'use strict';
// Artifact build only: stands in for the local bridge so the page runs on its own.
// Same API as web/js/net.js. The demo phone lives entirely in this tab.
(function () {
  const listeners = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (message) => { const e = new Error(message); e.friendly = true; return e; };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const DEFAULT_UI = {
    dwellEnabled: true, dwellMs: 800, dwellRepeat: false, videoDwell: true, buttonSize: 120, theme: 'dark',
    navMode: 'swipe', swapSides: false, layout: 'auto', sounds: true, invertSwipe: false,
    dockPinned: false, forceLandscape: true, rotation: 'landscape', audio: true, muted: false,
    quality: 'high', firstRunDone: false,
  };
  const KEY = 'gazecast-artifact-config';
  const config = { ui: Object.assign({}, DEFAULT_UI), favourites: [], saved: [] };
  try {
    const loaded = JSON.parse(localStorage.getItem(KEY) || '{}');
    Object.assign(config.ui, loaded.ui || {});
    if (Array.isArray(loaded.favourites)) config.favourites = loaded.favourites.filter((f) => typeof f === 'string');
  } catch (e) { /* storage unavailable: defaults */ }
  const saveConfig = () => { try { localStorage.setItem(KEY, JSON.stringify({ ui: config.ui, favourites: config.favourites })); } catch (e) { /* ignore */ } };

  const state = {
    demo: true, phase: 'searching', adb: { ok: true, engine: true }, devices: [], active: null,
    stream: { status: 'idle', mode: 'none' }, saved: config.saved, nearby: [],
  };
  const logEntries = [];
  let logSeq = 0;
  let pushQueued = false;

  const net = {
    online: false,
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    emit(name, a, b, c) { (listeners[name] || []).forEach((fn) => { try { fn(a, b, c); } catch (e) { console.error(e); } }); },
    send(op, params) {
      return new Promise((resolve, reject) => {
        if (!net.online) return reject(new Error('The demo is not ready yet.'));
        Promise.resolve().then(() => runOp(op, Object.assign({}, params || {})))
          .then((data) => resolve(clone(data || {})))
          .catch((e) => reject(new Error(e && e.friendly ? e.message : 'Something went wrong. Please try again.')));
      });
    },
    fire(op, params) {
      if (!net.online) return;
      Promise.resolve().then(() => runOp(op, Object.assign({}, params || {}))).catch(() => {});
    },
    // The page's pretend phone encodes H.264 and "sends" it; hand it straight back to the player.
    sendBinary(buf) { if (net.online) net.emit('binary', buf); },
    connect() {
      setTimeout(() => { net.online = true; net.emit('open'); backend.init(); }, 60);
    },
  };

  function event(obj) { const o = clone(obj); net.emit(o.ev, o); }
  function push() {
    if (pushQueued) return;
    pushQueued = true;
    setTimeout(() => { pushQueued = false; event({ ev: 'state', state }); }, 0);
  }
  function log(op, detail) {
    logEntries.push({ n: ++logSeq, t: Date.now(), op, detail: String(detail == null ? '' : detail) });
    if (logEntries.length > 300) logEntries.shift();
  }

  // ---------------------------------------------------------------- demo phone
  const APPS = [
    ['Phone', 'com.demo.dialer'], ['Messages', 'com.demo.messages'], ['Camera', 'com.demo.camera'],
    ['Photos', 'com.demo.photos'], ['Browser', 'com.demo.browser'], ['Maps', 'com.demo.maps'],
    ['Videos', 'com.demo.videos'], ['Mail', 'com.demo.mail'], ['Calendar', 'com.demo.calendar'],
    ['Clock', 'com.demo.clock'], ['Calculator', 'com.demo.calculator'], ['Contacts', 'com.demo.contacts'],
    ['Files', 'com.demo.files'], ['Settings', 'com.android.settings'], ['App Store', 'com.demo.store'],
    ['Music', 'com.demo.music'], ['Chat', 'com.demo.chat'], ['Films & TV', 'com.demo.films'],
    ['Weather', 'com.demo.weather'], ['Notes', 'com.demo.notes'], ['Drive', 'com.demo.drive'],
    ['Translate', 'com.demo.translate'], ['Recorder', 'com.demo.recorder'], ['Podcasts', 'com.demo.podcasts'],
    ['News', 'com.demo.news'], ['Fitness', 'com.demo.fitness'], ['Wallet', 'com.demo.wallet'],
    ['Smart Home', 'com.demo.home'], ['Audiobooks', 'com.demo.audiobooks'], ['Radio', 'com.demo.radio'],
    ['Banking', 'com.demo.banking'], ['Trains', 'com.demo.trains'], ['Recipes', 'com.demo.recipes'],
    ['Games', 'com.demo.games'], ['Health', 'com.demo.health'], ['Video Call', 'com.demo.videocall'],
  ].map(([label, pkg]) => ({ label, pkg, activity: '.MainActivity', system: /dialer|messages|camera|settings|clock|contacts|files/.test(pkg) }));
  const INTENT_NAMES = ['settings', 'wifi', 'bluetooth', 'hotspot', 'cast', 'display', 'sound', 'accessibility', 'battery'];

  const backend = {
    timer: null,
    init() {
      state.phase = 'searching';
      state.nearby = [{ name: 'adb-DEMO-pixel8', kind: 'pairing', host: '192.168.1.23', port: 37251 }];
      push();
      this.timer = setTimeout(() => this.attach(), 2600);
    },
    attach() {
      state.active = { serial: '192.168.43.1:5555', transport: 'wifi', model: 'Pixel 8 (demo)', android: '16', ips: ['192.168.43.1'], viaHotspot: true, battery: 82, id: 'demo' };
      state.phase = 'connected';
      state.stream = { status: 'live', mode: 'demo', audio: 'on', width: 1920, height: 864 };
      log('device', 'connected demo phone');
      push();
    },
    need() { if (!state.active) throw fail('The phone is not connected.'); },
    echo(op, detail, m) { log(op, detail); event({ ev: 'demo', op, m }); return {}; },
  };

  // ---------------------------------------------------------------- commands
  const OPS = {
    hello: async () => ({ state, config, log: logEntries.slice(-50) }),
    log: async () => ({ log: logEntries }),
    'config.set': async (m) => {
      const before = Object.assign({}, config.ui);
      if (m.ui && typeof m.ui === 'object') {
        for (const k of Object.keys(m.ui)) if (k in DEFAULT_UI && typeof m.ui[k] === typeof DEFAULT_UI[k]) config.ui[k] = m.ui[k];
      }
      if (Array.isArray(m.favourites)) config.favourites = m.favourites.filter((f) => typeof f === 'string').slice(0, 60);
      saveConfig();
      event({ ev: 'config', config });
      if (state.active && before.forceLandscape !== config.ui.forceLandscape) await OPS.rotation({ mode: config.ui.rotation });
      return {};
    },
    touch: async (m) => { backend.need(); event({ ev: 'demo', op: 'touch', m }); return {}; },
    tap: async (m) => { backend.need(); return backend.echo('tap', Number(m.x).toFixed(3) + ', ' + Number(m.y).toFixed(3), m); },
    swipe: async (m) => { backend.need(); return backend.echo('swipe', [m.x1, m.y1, m.x2, m.y2].map((v) => Number(v).toFixed(2)).join(' '), m); },
    key: async (m) => { backend.need(); return backend.echo('key', m.code + (m.name ? ' ' + m.name : ''), m); },
    text: async (m) => { backend.need(); return backend.echo('text', JSON.stringify(String(m.text || '')), m); },
    panel: async (m) => { backend.need(); return backend.echo('panel', String(m.which), m); },
    launch: async (m) => {
      backend.need();
      const app = APPS.find((a) => a.pkg === m.pkg);
      if (!app) throw fail('Unknown app.');
      return backend.echo('launch', app.pkg, { pkg: app.pkg, label: app.label });
    },
    intent: async (m) => {
      backend.need();
      if (INTENT_NAMES.indexOf(m.name) < 0) throw fail('Unknown shortcut.');
      return backend.echo('intent', m.name, m);
    },
    rotation: async (m) => {
      backend.need();
      const mode = m.mode === 'auto' || m.mode === 'portrait' ? m.mode : 'landscape';
      config.ui.rotation = mode;
      saveConfig();
      return backend.echo('rotation', mode, { mode });
    },
    apps: async () => { await sleep(700); return { apps: APPS, loading: false }; },
    pair: async (m) => {
      if (!/^\d{6}$/.test(String(m.code || ''))) throw fail('The pairing code is six digits.');
      await sleep(1200); backend.attach();
      return { paired: true, connected: true };
    },
    connect: async () => { await sleep(1000); backend.attach(); return {}; },
    tcpip: async () => { await sleep(1200); return { host: '192.168.43.1', port: 5555 }; },
    hotspotConnect: async () => { await sleep(1200); backend.attach(); return { host: '192.168.43.1' }; },
    disconnect: async () => {
      clearTimeout(backend.timer);
      state.active = null; state.phase = 'searching'; state.stream = { status: 'idle', mode: 'none' };
      push();
      return {};
    },
    resume: async () => { clearTimeout(backend.timer); backend.timer = setTimeout(() => backend.attach(), 1800); return {}; },
    forget: async (m) => {
      config.saved = config.saved.filter((d) => d.host !== m.host);
      state.saved = config.saved;
      push();
      return {};
    },
    scan: async () => { await sleep(600); return { nearby: state.nearby, gateways: ['192.168.43.1'] }; },
    restartStream: async () => ({}),
    refresh: async () => ({}),
    quit: async () => ({}),
    // Window buttons: there is no OS window here, so the page simulates them
    // (toast, Fullscreen API where the host allows it, "stopped" screen).
    'window.minimize': async () => { log('window', 'minimize'); return { simulated: true }; },
    'window.restore': async () => { log('window', 'restore'); return { simulated: true }; },
    'window.toggleMaximize': async () => { log('window', 'fullscreen'); return { simulated: true }; },
    'window.close': async () => { log('window', 'close'); return { simulated: true }; },
    'window.reopen': async () => {
      log('window', 'reopen');
      await OPS.disconnect();
      await OPS.resume();
      return {};
    },
  };
  function runOp(op, params) {
    if (!Object.prototype.hasOwnProperty.call(OPS, op)) return Promise.resolve({});
    return OPS[op](params);
  }

  // The page's `apps` event (the bridge pushes it on its own) is not needed: the page asks for apps itself.
  GC.net = net;
})();
