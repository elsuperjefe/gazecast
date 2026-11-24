'use strict';
// Minimal WebSocket server (RFC 6455) so the bridge needs no npm packages.
// Supports text + binary messages, fragmentation, ping/pong and close.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 32 * 1024 * 1024;

class WsClient extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  get backlog() { return this.socket.writableLength; }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009);
        len = Number(big); off = 10;
      }
      if (!masked) return this.close(1002); // browsers always mask
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      off += 4;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + i] ^ mask[i & 3];
      this.buf = b.subarray(off + len);

      if (opcode === 0x8) { this.close(1000); return; }
      if (opcode === 0x9) { this._frame(0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x2) { this.fragOpcode = opcode; this.fragments = [payload]; }
      else if (opcode === 0x0) this.fragments.push(payload);
      else return this.close(1002);
      if (fin) {
        const data = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.fragOpcode === 0x1) this.emit('text', data.toString('utf8'));
        else this.emit('binary', data);
      }
    }
  }

  _frame(opcode, payload) {
    if (!this.open || this.socket.destroyed) return;
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.allocUnsafe(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.allocUnsafe(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.allocUnsafe(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = 0x80 | opcode;
    try {
      this.socket.cork();
      this.socket.write(head);
      this.socket.write(payload);
      this.socket.uncork();
    } catch (e) { this._closed(); }
  }

  sendText(str) { this._frame(0x1, Buffer.from(str, 'utf8')); }
  sendJSON(obj) { this.sendText(JSON.stringify(obj)); }
  sendBinary(buf) { this._frame(0x2, buf); }

  close(code) {
    if (!this.open) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code || 1000, 0);
    this._frame(0x8, p);
    this.socket.end();
    this._closed();
  }
}

// Attach to an http.Server. `allow(req)` decides whether the upgrade is accepted.
function attach(server, path, allow, onClient) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const url = (req.url || '').split('?')[0];
    if (url !== path || !key || !allow(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    onClient(new WsClient(socket), req);
  });
}

module.exports = { attach };
