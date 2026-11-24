'use strict';
// GazeCast bridge. Serves the page on 127.0.0.1 only and relays between the
// page (WebSocket) and the phone (adb + scrcpy).
//
//   node bridge/server.js [--demo] [--port 8765] [--open] [--kiosk] [--windowed]

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ws = require('./ws');
const windowControl = require('./window');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const DATA = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
const flag = (name) => argv.indexOf('--' + name) >= 0;
const option = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const DEMO = flag('demo');
const PORT = Number(option('port', DEMO ? 8766 : 8765));
const HOST = '127.0.0.1';
const ORIGINS = ['http://127.0.0.1:' + PORT, 'http://localhost:' + PORT];
const HOSTS = ['127.0.0.1:' + PORT, 'localhost:' + PORT];

fs.mkdirSync(DATA, { recursive: true });

// ---------------------------------------------------------------- config
const CONFIG_FILE = path.join(DATA, DEMO ? 'config-demo.json' : 'config.json');
const DEFAULT_UI = {
  dwellEnabled: true, dwellMs: 800, dwellRepeat: false, videoDwell: true, buttonSize: 120, theme: 'dark',
  navMode: 'swipe', swapSides: false, layout: 'auto', sounds: true, invertSwipe: false,
  dockPinned: false, forceLandscape: true, rotation: 'landscape', audio: true, muted: false,
  quality: 'high', firstRunDone: false,
};
const config = { ui: Object.assign({}, DEFAULT_UI), favourites: [], saved: [] };
try {
  const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  Object.assign(config.ui, loaded.ui || {});
  if (Array.isArray(loaded.favourites)) config.favourites = loaded.favourites.filter((f) => typeof f === 'string');
  if (Array.isArray(loaded.saved)) config.saved = loaded.saved.filter((d) => d && typeof d.host === 'string');
} catch (e) { /* first run */ }

let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) { console.error('Could not save settings:', e.message); }
  }, 200);
}

// ---------------------------------------------------------------- hub
const clients = new Set();
const logEntries = [];
let logSeq = 0;
let pushQueued = false;

const hub = {
  dataDir: DATA,
  config,
  state: {
    demo: DEMO, phase: 'searching', adb: { ok: true, engine: true }, devices: [], active: null,
    stream: { status: 'idle', mode: 'none' }, saved: config.saved, nearby: [],
  },
  saveConfig,
  clientCount: () => clients.size,
  push() {
    if (pushQueued) return;
    pushQueued = true;
    setImmediate(() => { pushQueued = false; hub.event({ ev: 'state', state: hub.state }); });
  },
  event(obj) {
    const text = JSON.stringify(obj);
    for (const c of clients) c.sendText(text);
  },
  log(op, detail) {
    const entry = { n: ++logSeq, t: Date.now(), op, detail: String(detail == null ? '' : detail) };
    logEntries.push(entry);
    if (logEntries.length > 300) logEntries.shift();
    console.log(new Date(entry.t).toTimeString().slice(0, 8) + '  ' + op.padEnd(10) + ' ' + entry.detail);
    hub.event({ ev: 'log', entry });
  },
  // Media packet to every page: [type u8][flags u8][pts f64 LE][payload]
  binary(type, flags, pts, payload) {
    if (!clients.size) return;
    const head = Buffer.allocUnsafe(10);
    head[0] = type; head[1] = flags; head.writeDoubleLE(pts, 2);
    hub.raw(Buffer.concat([head, payload]));
  },
  raw(buf) {
    const video = buf[0] === 1;
    for (const c of clients) {
      // A page that cannot keep up skips frames until the next key frame instead of lagging behind.
      if (video && c.backlog > 12 * 1024 * 1024) { c.skipping = true; if (backend.onClientJoin) backend.onClientJoin(); }
      if (video && c.skipping) { if (buf[1] === 0) continue; if (buf[1] === 2) c.skipping = false; }
      c.sendBinary(buf);
    }
  },
};

const backend = DEMO ? new (require('./demo').DemoPhone)(hub) : new (require('./phone').Phone)(hub);

// ---------------------------------------------------------------- page commands
const OPS = {
  hello: async () => ({ state: hub.state, config, log: logEntries.slice(-50) }),
  log: async () => ({ log: logEntries }),
  'config.set': async (m) => {
    const before = Object.assign({}, config.ui);
    if (m.ui && typeof m.ui === 'object') {
      for (const k of Object.keys(m.ui)) if (k in DEFAULT_UI && typeof m.ui[k] === typeof DEFAULT_UI[k]) config.ui[k] = m.ui[k];
    }
    if (Array.isArray(m.favourites)) config.favourites = m.favourites.filter((f) => typeof f === 'string').slice(0, 60);
    saveConfig();
    hub.event({ ev: 'config', config });
    if (hub.state.active) {
      if (before.audio !== config.ui.audio || before.quality !== config.ui.quality) backend.restartStream();
      if (before.forceLandscape !== config.ui.forceLandscape) backend.rotation({ mode: config.ui.rotation });
    }
    return {};
  },
  touch: (m) => backend.touch(m),
  tap: (m) => backend.tap(m),
  swipe: (m) => backend.swipe(m),
  key: (m) => backend.key(m),
  text: (m) => backend.text(m),
  panel: (m) => backend.panel(m),
  launch: (m) => backend.launch(m),
  intent: (m) => backend.intent(m),
  rotation: (m) => backend.rotation(m),
  apps: (m) => backend.getApps(m),
  pair: (m) => backend.pair(m),
  connect: (m) => backend.connect(m),
  tcpip: () => backend.tcpip(),
  hotspotConnect: () => backend.hotspotConnect(),
  disconnect: () => backend.disconnect(),
  resume: () => backend.resume(),
  forget: (m) => backend.forget(m),
  scan: () => backend.scan(),
  restartStream: () => backend.restartStream(),
  refresh: async () => { backend.onClientJoin(); return {}; },
  quit: async () => { setTimeout(shutdown, 150); return {}; },

  // Window buttons (top-right corner of the page). With a real GazeCast browser
  // window they act on it; in demo mode without one they are only logged and the
  // page simulates the result ({ simulated: true }).
  'window.minimize': () => windowOp('minimize'),
  'window.restore': () => windowOp('restore'),
  'window.toggleMaximize': (m) => windowOp(m && m.mode === 'zoom' ? 'zoom' : 'fullscreen'),
  'window.close': async () => {
    hub.log('window', 'close');
    if (DEMO && !browser) return { simulated: true };
    setTimeout(shutdown, 150);
    return {};
  },
  'window.reopen': async () => {
    hub.log('window', 'reopen');
    if (DEMO) { await backend.disconnect(); await backend.resume(); }
    return {};
  },
};

async function windowOp(action) {
  hub.log('window', action);
  if (DEMO && !browser) return { simulated: true };
  await windowControl.control(action, browser ? browser.pid : 0);
  return {};
}

async function handle(client, text) {
  let m;
  try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m.op !== 'string' || !Object.prototype.hasOwnProperty.call(OPS, m.op)) return;
  try {
    const data = await OPS[m.op](m);
    if (m.id != null) client.sendJSON({ re: m.id, ok: true, data: data || {} });
  } catch (e) {
    if (!e.friendly) console.error('[' + m.op + ']', e);
    if (m.id != null) client.sendJSON({ re: m.id, ok: false, error: e.friendly ? e.message : 'Something went wrong. Please try again.' });
  }
}

// ---------------------------------------------------------------- http
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  // Only answer requests really addressed to this machine (blocks DNS-rebinding tricks).
  if (HOSTS.indexOf(req.headers.host) < 0) { res.writeHead(403); res.end('Forbidden'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/api/log') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ demo: DEMO, log: logEntries }));
    return;
  }
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(WEB, url));
  if (file !== WEB && file.indexOf(WEB + path.sep) !== 0) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

ws.attach(server, '/ws',
  (req) => HOSTS.indexOf(req.headers.host) >= 0 && ORIGINS.indexOf(req.headers.origin) >= 0,
  (client) => {
    clients.add(client);
    client.on('text', (t) => handle(client, t));
    client.on('binary', (b) => { if (DEMO && b.length > 10 && b[0] === 1) backend.demoVideo(b); });
    client.on('close', () => clients.delete(client));
    client.sendJSON({ ev: 'state', state: hub.state });
    backend.onClientJoin();
  });

// ---------------------------------------------------------------- browser window
function findBrowser() {
  const env = process.env;
  const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], env['LOCALAPPDATA']].filter(Boolean);
  const names = [['Google', 'Chrome', 'Application', 'chrome.exe'], ['Microsoft', 'Edge', 'Application', 'msedge.exe']];
  for (const n of names) for (const r of roots) {
    const p = path.join(r, ...n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let browser = null;
function openBrowser() {
  const url = 'http://127.0.0.1:' + PORT + '/';
  const exe = findBrowser();
  if (!exe) {
    console.log('Chrome was not found. Open ' + url + ' in your browser and press F11.');
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  const args = [
    '--app=' + url,
    '--user-data-dir=' + path.join(DATA, 'browser-profile'),
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
    '--disable-features=Translate,TranslateUI',
  ];
  if (flag('kiosk')) args.push('--kiosk'); else if (!flag('windowed')) args.push('--start-fullscreen');
  browser = spawn(exe, args, { stdio: 'ignore' });
  // Closing the window (Alt+F4) stops the bridge too.
  browser.on('exit', () => { browser = null; console.log('Window closed.'); shutdown(); });
}

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  console.log('Stopping GazeCast...');
  try { backend.shutdown(); } catch (e) { /* ignore */ }
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) { /* ignore */ }
  if (browser) { try { browser.kill(); } catch (e) { /* ignore */ } }
  for (const c of clients) c.close(1001);
  server.close();
  setTimeout(() => process.exit(0), 400);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('GazeCast is already running on port ' + PORT + '.');
    if (flag('open')) openBrowser();
    setTimeout(() => process.exit(0), 500);
  } else { console.error(e); process.exit(1); }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  GazeCast ' + (DEMO ? '(DEMO MODE - no phone needed) ' : '') + 'is running');
  console.log('  Page:  http://127.0.0.1:' + PORT + '/   (this computer only)');
  console.log('  Close the GazeCast window or press Ctrl+C here to stop.');
  console.log('');
  backend.init().catch((e) => console.error(e));
  if (flag('open')) openBrowser();
});
