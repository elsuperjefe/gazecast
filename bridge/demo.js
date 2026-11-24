'use strict';
// Demo phone: no hardware needed. Every command is written to the command log
// and echoed to the page, which draws a pretend Pixel home screen and reacts.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(message) { const e = new Error(message); e.friendly = true; return e; }

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

class DemoPhone {
  constructor(hub) { this.hub = hub; this.apps = APPS; }

  async init() {
    const st = this.hub.state;
    st.demo = true;
    st.adb = { ok: true, engine: true };
    st.phase = 'searching';
    st.nearby = [{ name: 'adb-DEMO-pixel8', kind: 'pairing', host: '192.168.1.23', port: 37251 }];
    this.hub.push();
    this.timer = setTimeout(() => this.attach(), 2600);
  }

  attach() {
    const st = this.hub.state;
    st.active = { serial: '192.168.43.1:5555', transport: 'wifi', model: 'Pixel 8 (demo)', android: '16', ips: ['192.168.43.1'], viaHotspot: true, battery: 82, id: 'demo' };
    st.phase = 'connected';
    st.stream = { status: 'live', mode: 'demo', audio: 'on', width: 1920, height: 864 };
    this.hub.log('device', 'connected demo phone');
    this.hub.push();
  }

  echo(op, detail, m) {
    this.hub.log(op, detail);
    this.hub.event({ ev: 'demo', op, m });
    return {};
  }

  onClientJoin() {}
  // Demo video loop-back: the page encodes its pretend phone screen to H.264 and
  // the bridge relays it exactly like a real scrcpy stream.
  demoVideo(buf) { this.hub.raw(buf); }

  need() { if (!this.hub.state.active) throw fail('The phone is not connected.'); }

  async touch(m) { this.need(); this.hub.event({ ev: 'demo', op: 'touch', m }); }
  async tap(m) { this.need(); return this.echo('tap', Number(m.x).toFixed(3) + ', ' + Number(m.y).toFixed(3), m); }
  async swipe(m) { this.need(); return this.echo('swipe', [m.x1, m.y1, m.x2, m.y2].map((v) => Number(v).toFixed(2)).join(' ') + ' ' + (m.ms || 220) + 'ms' + (m.label ? ' (' + m.label + ')' : ''), m); }
  async key(m) { this.need(); return this.echo('key', m.code + (m.name ? ' ' + m.name : '') + (m.long ? ' (long)' : ''), m); }
  async text(m) { this.need(); return this.echo('text', JSON.stringify(String(m.text || '')), m); }
  async panel(m) { this.need(); return this.echo('panel', String(m.which), m); }
  async launch(m) {
    this.need();
    const app = this.apps.find((a) => a.pkg === m.pkg);
    if (!app) throw fail('Unknown app.');
    return this.echo('launch', app.pkg + '/' + app.activity, { pkg: app.pkg, label: app.label });
  }
  async intent(m) {
    this.need();
    if (INTENT_NAMES.indexOf(m.name) < 0) throw fail('Unknown shortcut.');
    return this.echo('intent', m.name, m);
  }
  async rotation(m) {
    this.need();
    const mode = m.mode === 'auto' || m.mode === 'portrait' ? m.mode : 'landscape';
    this.hub.config.ui.rotation = mode;
    this.hub.saveConfig();
    return this.echo('rotation', mode, { mode });
  }

  async getApps() { await sleep(700); return { apps: this.apps, loading: false }; }

  async pair(m) {
    if (!/^\d{6}$/.test(String(m.code || ''))) throw fail('The pairing code is six digits.');
    this.hub.log('pair', m.host + ':' + m.port);
    await sleep(1200);
    this.attach();
    return { paired: true, connected: true };
  }
  async connect(m) { this.hub.log('connect', m.host + ':' + (m.port || 5555)); await sleep(1000); this.attach(); return {}; }
  async tcpip() { this.hub.log('tcpip', '5555'); await sleep(1200); return { host: '192.168.43.1', port: 5555 }; }
  async hotspotConnect() { this.hub.log('connect', 'hotspot gateway'); await sleep(1200); this.attach(); return { host: '192.168.43.1' }; }
  async disconnect() {
    clearTimeout(this.timer);
    const st = this.hub.state;
    st.active = null; st.phase = 'searching'; st.stream = { status: 'idle', mode: 'none' };
    this.hub.log('disconnect', 'demo');
    this.hub.push();
    return {};
  }
  async resume() { clearTimeout(this.timer); this.timer = setTimeout(() => this.attach(), 1800); return {}; }
  async forget(m) {
    const cfg = this.hub.config;
    cfg.saved = cfg.saved.filter((d) => d.host !== m.host);
    this.hub.state.saved = cfg.saved;
    this.hub.saveConfig(); this.hub.push();
    return {};
  }
  async scan() { await sleep(600); return { nearby: this.hub.state.nearby, gateways: ['192.168.43.1'] }; }
  async restartStream() { this.hub.log('stream', 'restart'); return {}; }
  shutdown() { clearTimeout(this.timer); }
}

module.exports = { DemoPhone };
