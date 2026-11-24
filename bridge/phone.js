'use strict';
// The real phone: finds it over USB / Wi-Fi / hotspot, keeps it connected,
// runs the scrcpy stream and turns page commands into phone actions.

const fs = require('fs');
const path = require('path');
const adb = require('./adb');
const { ScrcpySession, listApps } = require('./scrcpy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const PKG = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/;
const ACTIVITY = /^[A-Za-z0-9_.$]+$/;

// Settings shortcut tiles. Each entry lists commands to try in order.
const INTENTS = {
  settings:      ['am start -a android.settings.SETTINGS'],
  wifi:          ['am start -a android.settings.WIFI_SETTINGS'],
  bluetooth:     ['am start -a android.settings.BLUETOOTH_SETTINGS'],
  hotspot:       ["am start -n 'com.android.settings/.TetherSettings'",
                  "am start -n 'com.android.settings/.Settings$TetherSettingsActivity'",
                  'am start -a android.settings.WIRELESS_SETTINGS'],
  cast:          ['am start -a android.settings.CAST_SETTINGS'],
  display:       ['am start -a android.settings.DISPLAY_SETTINGS'],
  sound:         ['am start -a android.settings.SOUND_SETTINGS'],
  accessibility: ['am start -a android.settings.ACCESSIBILITY_SETTINGS'],
  battery:       ['am start -a android.settings.BATTERY_SAVER_SETTINGS'],
};

const QUALITY = {
  low:    { maxSize: 1280, bitRate: 4000000 },
  high:   { maxSize: 1920, bitRate: 8000000 },
  ultra:  { maxSize: 2400, bitRate: 16000000 },
};

function fail(message) { const e = new Error(message); e.friendly = true; return e; }

class Phone {
  constructor(hub) {
    this.hub = hub;
    this.active = null;       // { serial, transport, model, ... }
    this.session = null;
    this.failures = 0;
    this.fallbackRun = 0;
    this.fbSize = null;       // physical size in the current rotation (for "adb shell input")
    this.fbTouch = null;
    this.manualDisconnect = false;
    this.busy = false;
    this.tickCount = 0;
    this.apps = [];
    this.appsLoading = false;
    this.gateways = [];
    this.mdns = [];
    this.attachId = 0;
  }

  async init() {
    const st = this.hub.state;
    st.demo = false;
    st.adb = { ok: !!adb.paths.adb, engine: !!adb.paths.server };
    if (!adb.paths.adb) {
      st.phase = 'no-adb';
      this.hub.push();
      return;
    }
    await adb.run(['start-server'], { timeout: 20000 });
    this.timer = setInterval(() => this.tick(), 2000);
    this.tick();
  }

  // ------------------------------------------------------------ discovery
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.tickCount++;
      const st = this.hub.state;
      const list = await adb.devices();
      if (list === null) { st.adb.ok = false; st.phase = 'no-adb'; this.hub.push(); return; }
      st.adb.ok = true;
      st.devices = list;

      if (this.tickCount % 5 === 1) this.gateways = await adb.gateways();

      if (this.active && !list.some((d) => d.serial === this.active.serial && d.state === 'device')) {
        this.hub.log('device', 'lost ' + this.active.serial);
        this.detach();
      }
      if (!this.active && !this.manualDisconnect) {
        const ready = list.filter((d) => d.state === 'device');
        const pick = ready.find((d) => d.transport === 'usb') || ready[0];
        if (pick) await this.attach(pick);
      }
      if (!this.active) {
        st.phase = list.some((d) => d.state === 'unauthorized') ? 'unauthorized' : 'searching';
        // Stale wireless entries block reconnects: drop them.
        for (const d of list) {
          if (d.state === 'offline' && d.transport === 'wifi') await adb.run(['disconnect', d.serial], { timeout: 4000 });
        }
        if (!this.manualDisconnect && this.tickCount % 3 === 0) await this.autoConnect();
      }
      this.updateLink();
      this.hub.push();
    } catch (e) {
      this.hub.log('error', String(e && e.message || e));
    } finally {
      this.busy = false;
    }
  }

  async autoConnect() {
    const st = this.hub.state;
    this.mdns = await adb.mdns();
    st.nearby = this.mdns;
    const targets = [];
    for (const m of this.mdns) if (m.kind === 'connect') targets.push(m.host + ':' + m.port);
    for (const s of this.hub.config.saved) {
      const t = s.host + ':' + s.port;
      if (targets.indexOf(t) < 0) targets.push(t);
    }
    // When this PC is on a phone hotspot the phone is the gateway.
    for (const g of this.gateways) {
      if (this.hub.config.saved.some((s) => s.hotspot) && targets.indexOf(g + ':5555') < 0) targets.push(g + ':5555');
    }
    for (const t of targets.slice(0, 6)) {
      const r = await adb.run(['connect', t], { timeout: 5000 });
      if (/connected to/.test(r.stdout)) return;
    }
  }

  updateLink() {
    const a = this.active;
    if (!a) return;
    const host = a.serial.split(':')[0];
    const ips = (a.ips || []).concat(IPV4.test(host) ? [host] : []);
    a.viaHotspot = a.transport === 'wifi' && this.gateways.some((g) => ips.indexOf(g) >= 0);
  }

  async attach(dev) {
    const st = this.hub.state;
    const id = ++this.attachId;
    this.active = { serial: dev.serial, transport: dev.transport, model: dev.model || 'Android phone', android: '', ips: [], viaHotspot: false, battery: null, id: dev.serial };
    st.active = this.active;
    st.phase = 'connected';
    this.failures = 0;
    this.hub.log('device', 'connected ' + dev.serial + ' (' + dev.transport + ')');
    this.hub.push();

    const s = dev.serial;
    const props = await adb.shell(s, 'getprop ro.product.model; getprop ro.build.version.release; getprop ro.serialno');
    if (id !== this.attachId) return;
    const lines = props.stdout.split(/\r?\n/).map((l) => l.trim());
    if (lines[0]) this.active.model = lines[0];
    this.active.android = lines[1] || '';
    this.active.id = lines[2] || s;

    const ip = await adb.shell(s, 'ip -f inet -o addr show');
    if (id !== this.attachId) return;
    const ips = [];
    for (const l of ip.stdout.split(/\r?\n/)) {
      const m = /^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/.exec(l);
      if (m && m[1] !== 'lo') ips.push(m[2]);
    }
    this.active.ips = ips;
    this.updateLink();

    if (dev.transport === 'wifi') {
      const m = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(s);
      if (m) this.remember(m[1], Number(m[2]), this.active.model, this.active.viaHotspot);
    }
    this.hub.push();

    const ui = this.hub.config.ui;
    await this.applyRotation(ui.rotation || 'landscape');
    await adb.shell(s, 'settings put global stay_on_while_plugged_in 7; svc power stayon true');
    if (id !== this.attachId) return;

    this.startStream();
    this.loadApps(false);
    this.pollBattery();
  }

  detach() {
    this.attachId++;
    this.stopStream();
    this.active = null;
    this.hub.state.active = null;
    this.hub.state.stream = { status: 'idle', mode: 'none' };
    this.hub.state.phase = 'searching';
    this.hub.push();
  }

  remember(host, port, name, hotspot) {
    const saved = this.hub.config.saved;
    const existing = saved.find((d) => d.host === host);
    if (existing) { existing.port = port; existing.name = name; existing.last = Date.now(); existing.hotspot = !!hotspot || !!existing.hotspot; }
    else saved.push({ host, port, name, last: Date.now(), hotspot: !!hotspot });
    this.hub.state.saved = saved;
    this.hub.saveConfig();
  }

  async pollBattery() {
    const a = this.active;
    if (!a) return;
    const r = await adb.shell(a.serial, 'dumpsys battery');
    const m = /level:\s*(\d+)/.exec(r.stdout);
    if (m && this.active === a) { a.battery = Number(m[1]); this.hub.push(); }
    clearTimeout(this.batteryTimer);
    this.batteryTimer = setTimeout(() => this.pollBattery(), 120000);
  }

  // ------------------------------------------------------------ stream
  startStream() {
    const a = this.active;
    if (!a) return;
    this.stopStream();
    const st = this.hub.state;
    if (!adb.paths.server) { this.startFallback('The scrcpy engine is not installed (run setup.ps1). Showing snapshots instead.'); return; }
    const ui = this.hub.config.ui;
    const q = QUALITY[ui.quality] || QUALITY.high;
    st.stream = { status: 'starting', mode: 'scrcpy', audio: 'off', width: 0, height: 0 };
    this.hub.push();

    const session = new ScrcpySession(a.serial, { maxSize: q.maxSize, bitRate: q.bitRate, audio: ui.audio !== false });
    this.session = session;
    const startedAt = Date.now();
    session.on('log', (l) => this.hub.log('scrcpy', l));
    session.on('video', (flags, pts, buf) => this.hub.binary(1, flags, pts, buf));
    session.on('audio', (flags, pts, buf) => this.hub.binary(2, flags, pts, buf));
    session.on('size', (w, h) => { st.stream.width = w; st.stream.height = h; this.hub.push(); });
    session.on('audio-state', (s) => { st.stream.audio = s; this.hub.push(); });
    session.on('ready', () => { st.stream.status = 'live'; st.stream.audio = session.audioState; this.hub.push(); });
    const retry = (reason) => {
      if (this.session !== session) return;
      this.session = null;
      if (!this.active) return;
      if (Date.now() - startedAt > 15000) this.failures = 0; else this.failures++;
      this.hub.log('stream', 'ended: ' + reason + ' (failures ' + this.failures + ')');
      if (this.failures >= 3) { this.startFallback('Live video could not start (' + reason + '). Showing snapshots instead.'); return; }
      st.stream = { status: 'starting', mode: 'scrcpy', audio: 'off', note: reason };
      this.hub.push();
      this.retryTimer = setTimeout(() => this.startStream(), 1500);
    };
    session.on('end', retry);
    session.start().catch((e) => { session.stop(); retry(String(e.message || e)); });
  }

  stopStream() {
    clearTimeout(this.retryTimer);
    this.fallbackRun++;
    if (this.session) { const s = this.session; this.session = null; s.stop(); }
  }

  // Fallback: PNG snapshots through "adb exec-out screencap". Slow but dependable.
  async startFallback(note) {
    const a = this.active;
    if (!a) return;
    const run = ++this.fallbackRun;
    this.hub.state.stream = { status: 'live', mode: 'screencap', audio: 'unavailable', note };
    this.hub.push();
    while (run === this.fallbackRun && this.active === a) {
      const r = await adb.run(['exec-out', 'screencap', '-p'], { serial: a.serial, binary: true, timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
      if (run !== this.fallbackRun) return;
      const png = r.stdout;
      if (r.code === 0 && png.length > 24 && png[1] === 0x50) {
        this.fbSize = { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
        this.hub.state.stream.width = this.fbSize.w;
        this.hub.state.stream.height = this.fbSize.h;
        this.hub.binary(3, 0, Date.now() * 1000, png);
        await sleep(this.hub.clientCount() ? 60 : 1000);
      } else {
        await sleep(1000);
      }
    }
  }

  async restartStream() {
    this.failures = 0;
    this.startStream();
    return {};
  }

  onClientJoin() {
    if (this.session && this.session.alive) this.session.resetVideo();
  }

  // ------------------------------------------------------------ input
  need() {
    if (!this.active) throw fail('The phone is not connected.');
    return this.active.serial;
  }

  live() { return this.session && this.session.alive ? this.session : null; }

  async physicalSize() {
    if (this.fbSize) return this.fbSize;
    const r = await adb.shell(this.need(), 'dumpsys window displays');
    const m = /cur=(\d+)x(\d+)/.exec(r.stdout);
    return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 2400, h: 1080 };
  }

  async touch(m) {
    const s = this.live();
    const x = clamp01(m.x), y = clamp01(m.y), a = m.a | 0;
    if (s) { s.touch(a, x, y); return; }
    // Without the control socket: remember the gesture and replay it with "input".
    if (a === 0) this.fbTouch = { x, y, t: Date.now() };
    else if (a === 1 && this.fbTouch) {
      const d = this.fbTouch; this.fbTouch = null;
      const size = await this.physicalSize();
      const px = (v, n) => Math.round(v * n);
      if (Math.hypot(x - d.x, y - d.y) < 0.02) await adb.shell(this.need(), 'input tap ' + px(d.x, size.w) + ' ' + px(d.y, size.h));
      else await adb.shell(this.need(), 'input swipe ' + px(d.x, size.w) + ' ' + px(d.y, size.h) + ' ' + px(x, size.w) + ' ' + px(y, size.h) + ' ' + Math.max(80, Math.min(2000, Date.now() - d.t)));
    }
  }

  async tap(m) {
    const x = clamp01(m.x), y = clamp01(m.y);
    this.hub.log('tap', x.toFixed(3) + ', ' + y.toFixed(3));
    const s = this.live();
    if (s) { s.touch(0, x, y); await sleep(60); s.touch(1, x, y); return {}; }
    const size = await this.physicalSize();
    await adb.shell(this.need(), 'input tap ' + Math.round(x * size.w) + ' ' + Math.round(y * size.h));
    return {};
  }

  async swipe(m) {
    const x1 = clamp01(m.x1), y1 = clamp01(m.y1), x2 = clamp01(m.x2), y2 = clamp01(m.y2);
    const ms = Math.max(60, Math.min(3000, Number(m.ms) || 220));
    this.hub.log('swipe', [x1, y1, x2, y2].map((v) => v.toFixed(2)).join(' ') + ' ' + ms + 'ms' + (m.label ? ' (' + m.label + ')' : ''));
    const s = this.live();
    if (s) { await s.swipe(x1, y1, x2, y2, ms); return {}; }
    const size = await this.physicalSize();
    const px = (v, n) => Math.round(v * n);
    await adb.shell(this.need(), 'input swipe ' + px(x1, size.w) + ' ' + px(y1, size.h) + ' ' + px(x2, size.w) + ' ' + px(y2, size.h) + ' ' + ms);
    return {};
  }

  async key(m) {
    const code = Number(m.code);
    if (!Number.isInteger(code) || code < 0 || code > 400) throw fail('Unknown key.');
    this.hub.log('key', code + (m.name ? ' ' + m.name : '') + (m.long ? ' (long)' : ''));
    const s = this.live();
    if (s) {
      if (m.long) { s.key(code, 0); await sleep(700); s.key(code, 1); } else s.keyPress(code);
      return {};
    }
    await adb.shell(this.need(), 'input keyevent ' + (m.long ? '--longpress ' : '') + code);
    return {};
  }

  async text(m) {
    const text = String(m.text || '').slice(0, 2000);
    if (!text) return {};
    this.hub.log('text', JSON.stringify(text.length > 40 ? text.slice(0, 40) + '...' : text));
    const s = this.live();
    if (s) { s.text(text); return {}; }
    if (!/^[\x20-\x7e]*$/.test(text)) throw fail('Special characters need live video mode. Only plain letters and numbers can be typed right now.');
    // "input text" treats %s as a space; the whole argument is single-quoted for the phone shell.
    await adb.shell(this.need(), 'input text ' + adb.shq(text.replace(/ /g, '%s')));
    return {};
  }

  async panel(m) {
    const which = m.which === 'notifications' || m.which === 'settings' ? m.which : 'collapse';
    this.hub.log('panel', which);
    const s = this.live();
    if (s) { s.panel(which); return {}; }
    const cmd = which === 'notifications' ? 'expand-notifications' : which === 'settings' ? 'expand-settings' : 'collapse';
    await adb.shell(this.need(), 'cmd statusbar ' + cmd);
    return {};
  }

  async launch(m) {
    const pkg = String(m.pkg || '');
    if (!PKG.test(pkg)) throw fail('Unknown app.');
    const app = this.apps.find((a) => a.pkg === pkg);
    const activity = app && app.activity && ACTIVITY.test(app.activity) ? app.activity : null;
    this.hub.log('launch', pkg + (activity ? '/' + activity : ''));
    let r;
    if (activity) {
      r = await adb.shell(this.need(), 'am start -n ' + adb.shq(pkg + '/' + activity));
      if (!/Error|Exception/.test(r.stdout + r.stderr)) return {};
    }
    r = await adb.shell(this.need(), 'monkey -p ' + adb.shq(pkg) + ' -c android.intent.category.LAUNCHER 1');
    if (/No activities found|Error/.test(r.stdout + r.stderr)) throw fail('That app could not be opened.');
    return {};
  }

  async intent(m) {
    const list = INTENTS[m.name];
    if (!list) throw fail('Unknown shortcut.');
    this.hub.log('intent', m.name);
    for (const cmd of list) {
      const r = await adb.shell(this.need(), cmd);
      if (!/Error|Exception|does not exist/.test(r.stdout + r.stderr)) return {};
    }
    throw fail('The phone could not open that settings page.');
  }

  async applyRotation(mode) {
    const s = this.need();
    const force = this.hub.config.ui.forceLandscape !== false;
    if (mode === 'auto') {
      await adb.shell(s, 'settings put system accelerometer_rotation 1; wm set-ignore-orientation-request false');
    } else {
      const rot = mode === 'portrait' ? 0 : 1;
      await adb.shell(s, 'settings put system accelerometer_rotation 0; settings put system user_rotation ' + rot +
        '; wm set-ignore-orientation-request ' + (rot === 1 && force ? 'true' : 'false'));
    }
  }

  async rotation(m) {
    const mode = m.mode === 'auto' || m.mode === 'portrait' ? m.mode : 'landscape';
    this.hub.log('rotation', mode);
    this.hub.config.ui.rotation = mode;
    this.hub.saveConfig();
    await this.applyRotation(mode);
    return {};
  }

  // ------------------------------------------------------------ apps
  cacheFile() {
    const id = String(this.active ? this.active.id : 'none').replace(/[^A-Za-z0-9]/g, '_');
    return path.join(this.hub.dataDir, 'apps-' + id + '.json');
  }

  async getApps(m) {
    if (m && m.refresh) this.loadApps(true);
    return { apps: this.apps, loading: this.appsLoading };
  }

  async loadApps(force) {
    const a = this.active;
    if (!a || this.appsLoading) return;
    this.appsLoading = true;
    try {
      if (!force || !this.apps.length) {
        try { this.apps = JSON.parse(fs.readFileSync(this.cacheFile(), 'utf8')); this.hub.event({ ev: 'apps', apps: this.apps, loading: true }); } catch (e) { /* no cache yet */ }
      }
      const s = a.serial;
      const q = await adb.shell(s, 'cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER', { timeout: 30000 });
      const activities = {};
      for (const line of q.stdout.split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)\s*$/.exec(line);
        if (m && !activities[m[1]]) activities[m[1]] = m[2];
      }
      const labelled = await listApps(s);
      if (this.active !== a) return;
      const byPkg = {};
      for (const app of labelled) byPkg[app.pkg] = app;
      const pkgs = Object.keys(activities);
      const source = pkgs.length ? pkgs : labelled.map((l) => l.pkg);
      const apps = source.map((pkg) => ({
        pkg,
        activity: activities[pkg] || '',
        label: byPkg[pkg] ? byPkg[pkg].label : prettyName(pkg),
        system: byPkg[pkg] ? byPkg[pkg].system : false,
      }));
      apps.sort((x, y) => x.label.localeCompare(y.label));
      if (apps.length) {
        this.apps = apps;
        try { fs.writeFileSync(this.cacheFile(), JSON.stringify(apps)); } catch (e) { /* cache is optional */ }
      }
      this.hub.log('apps', apps.length + ' launchable apps (' + labelled.length + ' labels)');
    } finally {
      this.appsLoading = false;
      this.hub.event({ ev: 'apps', apps: this.apps, loading: false });
    }
  }

  // ------------------------------------------------------------ connection
  async pair(m) {
    const host = String(m.host || '').trim(), port = Number(m.port), code = String(m.code || '').trim();
    if (!IPV4.test(host) || !(port > 0 && port < 65536)) throw fail('That address does not look right. It should look like 192.168.1.23 and a port number.');
    if (!/^\d{6}$/.test(code)) throw fail('The pairing code is six digits.');
    this.hub.log('pair', host + ':' + port);
    const r = await adb.run(['pair', host + ':' + port, code], { timeout: 25000 });
    const out = (r.stdout + ' ' + r.stderr).trim();
    if (!/Successfully paired/i.test(out)) throw fail('Pairing did not work. Check the code and the pairing port, then try again. (' + out.slice(0, 120) + ')');
    this.manualDisconnect = false;
    // The phone now announces its connect port; try to find it automatically.
    for (let i = 0; i < 5; i++) {
      const found = (await adb.mdns()).find((s) => s.kind === 'connect' && s.host === host);
      if (found) {
        const c = await adb.run(['connect', host + ':' + found.port], { timeout: 6000 });
        if (/connected to/.test(c.stdout)) return { paired: true, connected: true };
      }
      await sleep(1000);
    }
    return { paired: true, connected: false };
  }

  async connect(m) {
    const host = String(m.host || '').trim(), port = Number(m.port) || 5555;
    if (!IPV4.test(host) || !(port > 0 && port < 65536)) throw fail('That address does not look right. It should look like 192.168.1.23 and a port number.');
    this.hub.log('connect', host + ':' + port);
    this.manualDisconnect = false;
    const r = await adb.run(['connect', host + ':' + port], { timeout: 8000 });
    const out = (r.stdout + ' ' + r.stderr).trim();
    if (!/connected to/.test(out)) throw fail('Could not reach the phone at ' + host + ':' + port + '. Check that both devices are on the same network and that debugging is on.');
    this.tick();
    return {};
  }

  // One-time step over USB (or an existing link): make the phone listen on port 5555.
  async tcpip() {
    const a = this.active;
    if (!a) throw fail('Plug the phone in with the USB cable first.');
    const ips = a.ips.slice();
    this.hub.log('tcpip', '5555 on ' + a.serial);
    const r = await adb.run(['tcpip', '5555'], { serial: a.serial, timeout: 10000 });
    if (r.code !== 0) throw fail('The phone refused to switch on wireless mode: ' + (r.stderr || r.stdout).trim());
    if (!ips.length) throw fail('Wireless mode is on, but the phone has no Wi-Fi address yet. Join Wi-Fi (or turn the hotspot on) and press Connect.');
    await sleep(2500);
    const candidates = ips.concat(this.gateways.filter((g) => ips.indexOf(g) < 0));
    for (const ip of candidates) {
      const c = await adb.run(['connect', ip + ':5555'], { timeout: 5000 });
      if (/connected to/.test(c.stdout)) {
        this.remember(ip, 5555, a.model, this.gateways.indexOf(ip) >= 0);
        return { host: ip, port: 5555 };
      }
    }
    throw fail('Wireless mode is on, but this computer could not reach the phone at ' + ips.join(' or ') + '. Make sure both are on the same Wi-Fi or hotspot.');
  }

  async hotspotConnect() {
    this.manualDisconnect = false;
    this.gateways = await adb.gateways();
    if (!this.gateways.length) throw fail('This computer is not connected to any network. Join the phone hotspot first.');
    for (const g of this.gateways) {
      this.hub.log('connect', g + ':5555 (hotspot gateway)');
      const c = await adb.run(['connect', g + ':5555'], { timeout: 6000 });
      if (/connected to/.test(c.stdout)) { this.remember(g, 5555, 'Phone hotspot', true); this.tick(); return { host: g }; }
    }
    throw fail('The phone did not answer at ' + this.gateways.join(' or ') + '. Do the one-time USB step first, and check this computer is joined to the phone hotspot.');
  }

  async disconnect() {
    const a = this.active;
    this.manualDisconnect = true;
    this.hub.log('disconnect', a ? a.serial : '-');
    if (a) {
      this.detach();
      if (a.transport === 'wifi') await adb.run(['disconnect', a.serial], { timeout: 4000 });
    }
    return {};
  }

  async resume() { this.manualDisconnect = false; this.tick(); return {}; }

  async forget(m) {
    const host = String(m.host || '');
    const cfg = this.hub.config;
    const gone = cfg.saved.filter((d) => d.host === host);
    cfg.saved = cfg.saved.filter((d) => d.host !== host);
    this.hub.state.saved = cfg.saved;
    this.hub.saveConfig();
    for (const d of gone) await adb.run(['disconnect', d.host + ':' + d.port], { timeout: 4000 });
    this.hub.push();
    return {};
  }

  async scan() {
    this.mdns = await adb.mdns();
    this.gateways = await adb.gateways();
    this.hub.state.nearby = this.mdns;
    this.hub.push();
    return { nearby: this.mdns, gateways: this.gateways };
  }

  shutdown() {
    clearInterval(this.timer);
    clearTimeout(this.batteryTimer);
    this.stopStream();
  }
}

function clamp01(v) { v = Number(v); return v >= 0 ? (v <= 1 ? v : 1) : 0; }

function prettyName(pkg) {
  const parts = pkg.split('.').filter((p) => ['com', 'org', 'net', 'android', 'google', 'apps', 'app', 'www'].indexOf(p) < 0);
  const last = parts[parts.length - 1] || pkg;
  return last.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = { Phone, INTENTS };
