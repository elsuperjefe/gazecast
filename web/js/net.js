'use strict';
// WebSocket link to the local bridge, with automatic reconnect.
(function () {
  const listeners = {};
  const pending = new Map();
  let socket = null;
  let seq = 0;
  let retry = 0;

  const net = {
    online: false,
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    emit(name, a, b, c) { (listeners[name] || []).forEach((fn) => { try { fn(a, b, c); } catch (e) { console.error(e); } }); },

    // Request with a reply. Rejects with a friendly Error.
    send(op, params) {
      return new Promise((resolve, reject) => {
        if (!net.online) return reject(new Error('GazeCast is not running. Start it again with start.bat.'));
        const id = ++seq;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify(Object.assign({ op, id }, params || {})));
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); reject(new Error('The phone took too long to answer.')); }
        }, 70000);
      });
    },
    // Fire and forget (touch moves).
    fire(op, params) {
      if (net.online) socket.send(JSON.stringify(Object.assign({ op }, params || {})));
    },
    sendBinary(buf) { if (net.online && socket.bufferedAmount < 8e6) socket.send(buf); },
    connect,
  };

  function connect() {
    socket = new WebSocket('ws://' + location.host + '/ws');
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => { net.online = true; retry = 0; net.emit('open'); };
    socket.onclose = () => {
      const was = net.online;
      net.online = false;
      pending.forEach((p) => p.reject(new Error('GazeCast is not running. Start it again with start.bat.')));
      pending.clear();
      if (was) net.emit('close');
      retry = Math.min(retry + 1, 5);
      setTimeout(connect, 400 * retry);
    };
    socket.onmessage = (e) => {
      if (typeof e.data !== 'string') { net.emit('binary', e.data); return; }
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.re != null) {
        const p = pending.get(m.re);
        if (p) { pending.delete(m.re); if (m.ok) p.resolve(m.data); else p.reject(new Error(m.error)); }
      } else if (m.ev) net.emit(m.ev, m);
    };
  }

  GC.net = net;
})();
