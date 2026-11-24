'use strict';
// Talks to scrcpy-server (the open-source mirroring engine by Genymobile).
// The server is pushed to the phone, started with app_process, and reached
// through an "adb forward" tunnel on 127.0.0.1. Three sockets are opened in
// order: video (H.264), audio (Opus) and control (binary input messages).
//
// Protocol reference: scrcpy doc/develop.md (version 5.x):
//   first socket : 1 dummy byte, 64 bytes device name
//   video/audio  : u32 codec id, then 12-byte headers
//       session packet  : bit63 set, then u32 width, u32 height      (video only)
//       media packet    : bit62 = config, bit61 = key frame, PTS, u32 size, payload

const net = require('net');
const { EventEmitter } = require('events');
const adb = require('./adb');

const REMOTE_JAR = '/data/local/tmp/scrcpy-server.jar';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Incremental reader: feed() chunks, pull exact byte counts.
class Reader {
  constructor() { this.chunks = []; this.length = 0; }
  feed(c) { this.chunks.push(c); this.length += c.length; }
  take(n) {
    if (this.length < n) return null;
    let first = this.chunks[0];
    if (first.length === n) { this.chunks.shift(); this.length -= n; return first; }
    if (first.length > n) { this.chunks[0] = first.subarray(n); this.length -= n; return first.subarray(0, n); }
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      first = this.chunks[0];
      const want = Math.min(first.length, n - off);
      first.copy(out, off, 0, want);
      off += want;
      if (want === first.length) this.chunks.shift(); else this.chunks[0] = first.subarray(want);
    }
    this.length -= n;
    return out;
  }
}

class ScrcpySession extends EventEmitter {
  constructor(serial, options) {
    super();
    this.serial = serial;
    this.options = Object.assign({ maxSize: 1920, bitRate: 8000000, maxFps: 60, audio: true }, options || {});
    this.width = 0;
    this.height = 0;
    this.deviceName = '';
    this.audioState = 'off';
    this.alive = false;
    this.stopped = false;
    this.sockets = [];
    this.control = null;
    this.proc = null;
    this.port = 0;
    this.lastConfig = null;
    this.pointerDown = false;
  }

  log(msg) { this.emit('log', msg); }

  async start() {
    const { server, serverVersion } = adb.paths;
    if (!server) throw new Error('scrcpy-server is missing. Run setup.ps1 first.');

    const push = await adb.run(['push', server, REMOTE_JAR], { serial: this.serial, timeout: 30000 });
    if (push.code !== 0) throw new Error('Could not copy scrcpy-server to the phone: ' + (push.stderr || push.stdout).trim());

    const scid = (Math.floor(Math.random() * 0x7ffffffe) + 1).toString(16).padStart(8, '0');
    this.port = await freePort();
    const fwd = await adb.run(['forward', 'tcp:' + this.port, 'localabstract:scrcpy_' + scid], { serial: this.serial });
    if (fwd.code !== 0) throw new Error('adb forward failed: ' + fwd.stderr.trim());

    const o = this.options;
    const args = [
      'CLASSPATH=' + REMOTE_JAR, 'app_process', '/', 'com.genymobile.scrcpy.Server', serverVersion,
      'scid=' + scid, 'log_level=info', 'tunnel_forward=true',
      'video=true', 'audio=' + (o.audio ? 'true' : 'false'), 'control=true',
      'video_codec=h264', 'audio_codec=opus',
      'max_size=' + o.maxSize, 'video_bit_rate=' + o.bitRate, 'max_fps=' + o.maxFps,
      'stay_awake=true', 'power_on=true', 'cleanup=true', 'clipboard_autosync=false',
    ];
    this.proc = adb.spawnAdb(['shell', args.join(' ')], this.serial);
    const onOut = (d) => String(d).split(/\r?\n/).forEach((l) => { if (l.trim()) this.log(l.trim()); });
    this.proc.stdout.on('data', onOut);
    this.proc.stderr.on('data', onOut);
    this.proc.on('exit', () => this._end('The mirroring engine on the phone stopped.'));

    // First socket: retry until the server is listening (it answers with one dummy byte).
    const video = await this._connectFirst();
    this._wireVideo(video.socket, video.reader);
    if (o.audio) {
      const a = await this._connect();
      this._wireAudio(a);
    }
    this.control = await this._connect();
    this.control.on('data', () => { /* device messages (clipboard etc.) are not needed */ });
    this.alive = true;
    this.emit('ready');
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port: this.port });
      s.setNoDelay(true);
      s.once('connect', () => { this.sockets.push(s); s.on('error', () => {}); s.on('close', () => this._end('Connection to the phone was lost.')); resolve(s); });
      s.once('error', reject);
    });
  }

  async _connectFirst() {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (this.stopped) throw new Error('stopped');
      const result = await new Promise((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port: this.port });
        s.setNoDelay(true);
        const reader = new Reader();
        let done = false;
        const fail = () => { if (!done) { done = true; s.destroy(); resolve(null); } };
        s.once('error', fail);
        s.once('close', fail);
        s.on('data', function first(d) {
          reader.feed(d);
          if (!done) {
            done = true;
            s.removeListener('data', first);
            s.removeListener('close', fail);
            resolve({ socket: s, reader });
          }
        });
        setTimeout(fail, 3000);
      });
      if (result) {
        result.reader.take(1); // dummy byte
        this.sockets.push(result.socket);
        result.socket.on('error', () => {});
        result.socket.on('close', () => this._end('Connection to the phone was lost.'));
        return result;
      }
      await sleep(100);
    }
    throw new Error('The phone did not start the mirroring engine in time.');
  }

  _wireVideo(socket, reader) {
    let stage = 0; // 0 name, 1 codec, 2 header, 3 payload
    let pending = null;
    const pump = () => {
      for (;;) {
        if (stage === 0) {
          const b = reader.take(64); if (!b) return;
          const end = b.indexOf(0);
          this.deviceName = b.toString('utf8', 0, end < 0 ? 64 : end);
          stage = 1;
        } else if (stage === 1) {
          const b = reader.take(4); if (!b) return;
          const id = b.readUInt32BE(0);
          if (id <= 1) { this._end('The phone could not start video capture.'); return; }
          stage = 2;
        } else if (stage === 2) {
          const h = reader.take(12); if (!h) return;
          if (h[0] & 0x80) { // session packet: new capture size (rotation etc.)
            this.width = h.readUInt32BE(4);
            this.height = h.readUInt32BE(8);
            this.emit('size', this.width, this.height);
            continue;
          }
          const hi = h.readUInt32BE(0);
          pending = {
            config: (hi & 0x40000000) !== 0,
            key: (hi & 0x20000000) !== 0,
            pts: (hi & 0x1fffffff) * 4294967296 + h.readUInt32BE(4),
            size: h.readUInt32BE(8),
          };
          stage = 3;
        } else {
          const p = reader.take(pending.size); if (!p) return;
          if (pending.config) this.lastConfig = p;
          this.emit('video', pending.config ? 1 : (pending.key ? 2 : 0), pending.pts, p);
          stage = 2;
        }
      }
    };
    socket.on('data', (d) => { reader.feed(d); pump(); });
    pump();
  }

  _wireAudio(socket) {
    const reader = new Reader();
    let stage = 0;
    let pending = null;
    socket.on('data', (d) => {
      reader.feed(d);
      for (;;) {
        if (stage === 0) {
          const b = reader.take(4); if (!b) return;
          const id = b.readUInt32BE(0);
          if (id <= 1) { this.audioState = 'unavailable'; this.emit('audio-state', this.audioState); stage = 9; return; }
          this.audioState = 'on';
          this.emit('audio-state', this.audioState);
          stage = 1;
        } else if (stage === 1) {
          const h = reader.take(12); if (!h) return;
          const hi = h.readUInt32BE(0);
          pending = { config: (hi & 0x40000000) !== 0, pts: (hi & 0x1fffffff) * 4294967296 + h.readUInt32BE(4), size: h.readUInt32BE(8) };
          stage = 2;
        } else if (stage === 2) {
          const p = reader.take(pending.size); if (!p) return;
          this.emit('audio', pending.config ? 1 : 0, pending.pts, p);
          stage = 1;
        } else return;
      }
    });
  }

  _end(reason) {
    if (this.stopped) return;
    this.stop();
    this.emit('end', reason);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.alive = false;
    for (const s of this.sockets) { try { s.destroy(); } catch (e) { /* ignore */ } }
    if (this.proc) { try { this.proc.kill(); } catch (e) { /* ignore */ } }
    if (this.port) adb.run(['forward', '--remove', 'tcp:' + this.port], { serial: this.serial, timeout: 4000 });
  }

  // ------------------------------------------------------------ control messages
  _send(buf) {
    if (!this.alive || !this.control || this.control.destroyed) return false;
    this.control.write(buf);
    return true;
  }

  // action: 0 down, 1 up, 2 move. nx/ny are 0..1 across the current video frame.
  touch(action, nx, ny) {
    if (!this.width) return false;
    const b = Buffer.alloc(32);
    b[0] = 2; b[1] = action;
    b.writeBigInt64BE(-2n, 2); // generic finger
    b.writeInt32BE(Math.max(0, Math.min(this.width - 1, Math.round(nx * this.width))), 10);
    b.writeInt32BE(Math.max(0, Math.min(this.height - 1, Math.round(ny * this.height))), 14);
    b.writeUInt16BE(this.width, 18);
    b.writeUInt16BE(this.height, 20);
    b.writeUInt16BE(action === 1 ? 0 : 0xffff, 22);
    b.writeInt32BE(0, 24);
    b.writeInt32BE(0, 28);
    return this._send(b);
  }

  async swipe(x1, y1, x2, y2, ms) {
    if (!this.touch(0, x1, y1)) return false;
    const steps = Math.max(4, Math.round((ms || 220) / 12));
    for (let i = 1; i <= steps; i++) {
      await sleep((ms || 220) / steps);
      const t = i / steps;
      const e = t * (2 - t); // ease-out, so lists keep a natural fling
      this.touch(2, x1 + (x2 - x1) * e, y1 + (y2 - y1) * e);
    }
    return this.touch(1, x2, y2);
  }

  key(code, action) {
    const b = Buffer.alloc(14);
    b[0] = 0; b[1] = action;
    b.writeInt32BE(code, 2);
    return this._send(b);
  }

  keyPress(code) { return this.key(code, 0) && this.key(code, 1); }

  text(str) {
    // Plain ASCII goes through key injection; anything else is pasted via the clipboard.
    if (/^[\x20-\x7e]*$/.test(str)) {
      const bytes = Buffer.from(str, 'utf8');
      for (let i = 0; i < bytes.length; i += 300) {
        const part = bytes.subarray(i, i + 300);
        const b = Buffer.alloc(5 + part.length);
        b[0] = 1; b.writeUInt32BE(part.length, 1); part.copy(b, 5);
        if (!this._send(b)) return false;
      }
      return true;
    }
    const bytes = Buffer.from(str, 'utf8');
    const b = Buffer.alloc(14 + bytes.length);
    b[0] = 9; b.writeBigInt64BE(0n, 1); b[9] = 1; b.writeUInt32BE(bytes.length, 10); bytes.copy(b, 14);
    return this._send(b);
  }

  panel(which) {
    const type = which === 'notifications' ? 5 : which === 'settings' ? 6 : 7;
    return this._send(Buffer.from([type]));
  }

  // Ask the encoder for a fresh key frame (used when a browser window joins).
  resetVideo() { return this._send(Buffer.from([17])); }
}

// Ask scrcpy-server for the list of installed apps with their real labels.
async function listApps(serial) {
  const { server, serverVersion } = adb.paths;
  if (!server) return [];
  const push = await adb.run(['push', server, REMOTE_JAR], { serial, timeout: 30000 });
  if (push.code !== 0) return [];
  const r = await adb.shell(serial,
    'CLASSPATH=' + REMOTE_JAR + ' app_process / com.genymobile.scrcpy.Server ' + serverVersion + ' list_apps=true',
    { timeout: 60000 });
  return parseAppList(r.stdout + '\n' + r.stderr);
}

function parseAppList(text) {
  const apps = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s+([*-])\s(.+?)\s+([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\s*$/.exec(line);
    if (m) apps.push({ label: m[2].trim(), pkg: m[3], system: m[1] === '*' });
  }
  return apps;
}

module.exports = { ScrcpySession, listApps, parseAppList };
