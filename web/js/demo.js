'use strict';
// Demo mode only: draws a pretend Pixel screen that reacts to every command,
// then (when the browser can) encodes it to H.264 and sends it through the
// bridge so the real decode path is exercised end to end.
(function () {
  const S = {
    w: 1920, h: 864, portrait: false,
    screen: 'home', app: null, page: 0, pageAnim: 0,
    shade: 0, shadeAnim: 0, focus: -1, typed: '', volume: 9, volShow: 0,
    ripples: [], scroll: 0, scrollTo: 0, appAnim: 0, down: null, trail: null,
  };
  let apps = [];
  let surface = null, g = null;
  let running = false, raf = 0, lastDraw = 0;
  let encoder = null, frameNo = 0, forceKey = true, startedAt = 0;
  const demo = { mode: 'off', running: false };

  const hueOf = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
  const now = () => performance.now();

  function rr(x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }

  function iconSlots() {
    const cols = S.portrait ? 4 : 6, rows = S.portrait ? 4 : 2;
    const size = Math.round(Math.min(S.w / (cols * 1.9), S.h / (rows * 3.0)));
    const gx = (S.w - cols * size) / (cols + 1);
    const top = S.h * (S.portrait ? 0.3 : 0.34), gy = size * 0.62;
    const out = [];
    for (let i = 0; i < cols * rows; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      out.push({ x: gx + c * (size + gx), y: top + r * (size + gy), s: size });
    }
    return { slots: out, per: cols * rows, cols };
  }

  function drawWallpaper(t) {
    const grd = g.createLinearGradient(0, 0, S.w, S.h);
    const a = (t / 90) % 360;
    grd.addColorStop(0, 'hsl(' + (230 + 30 * Math.sin(t / 4000)) + ' 60% 20%)');
    grd.addColorStop(1, 'hsl(' + (285 + 25 * Math.cos(t / 5000)) + ' 55% 16%)');
    g.fillStyle = grd; g.fillRect(0, 0, S.w, S.h);
    const blobs = [[0.25, 0.3, 200, 0.55], [0.72, 0.62, 330, 0.5], [0.55, 0.2, 170, 0.4]];
    blobs.forEach((b, i) => {
      const x = S.w * (b[0] + 0.12 * Math.sin(t / (2600 + i * 700) + i)), y = S.h * (b[1] + 0.14 * Math.cos(t / (3100 + i * 500)));
      const r = Math.max(S.w, S.h) * 0.38;
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, 'hsla(' + ((b[2] + a) % 360) + ' 85% 62% / ' + b[3] + ')');
      rg.addColorStop(1, 'hsla(' + ((b[2] + a) % 360) + ' 85% 62% / 0)');
      g.fillStyle = rg; g.fillRect(0, 0, S.w, S.h);
    });
  }

  function text(str, x, y, size, weight, color, align) {
    g.font = (weight || 500) + ' ' + size + 'px Manrope, "Segoe UI", sans-serif';
    g.fillStyle = color || '#fff'; g.textAlign = align || 'left'; g.textBaseline = 'middle';
    g.fillText(str, x, y);
  }

  function drawStatus() {
    const d = new Date();
    const u = S.h / 864 * (S.portrait ? 0.5 : 1);
    text(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 44 * u, 30 * u, 24 * u, 600, 'rgba(255,255,255,.92)');
    text('5G   82%', S.w - 44 * u, 30 * u, 22 * u, 600, 'rgba(255,255,255,.85)', 'right');
  }

  function drawIcon(app, slot, focused, alpha) {
    const { x, y, s } = slot, h = hueOf(app.pkg);
    g.globalAlpha = alpha;
    if (focused) { g.shadowColor = 'hsl(' + h + ' 90% 70%)'; g.shadowBlur = 40; }
    const grd = g.createLinearGradient(x, y, x + s, y + s);
    grd.addColorStop(0, 'hsl(' + h + ' 78% 62%)'); grd.addColorStop(1, 'hsl(' + ((h + 40) % 360) + ' 72% 46%)');
    g.fillStyle = grd; rr(x, y, s, s, s * 0.3); g.fill();
    g.shadowBlur = 0;
    if (focused) { g.lineWidth = 5; g.strokeStyle = '#fff'; rr(x - 7, y - 7, s + 14, s + 14, s * 0.34); g.stroke(); }
    text(app.label[0], x + s / 2, y + s / 2 + 2, s * 0.46, 700, 'rgba(255,255,255,.96)', 'center');
    text(app.label, x + s / 2, y + s + s * 0.24, s * 0.18, 600, 'rgba(255,255,255,.92)', 'center');
    g.globalAlpha = 1;
  }

  function drawHome(t) {
    const L = iconSlots(), d = new Date();
    const u = Math.min(S.w, S.h) / 864;
    text(d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }), S.w * 0.06, S.h * 0.17, 44 * u, 600);
    text('Demo phone  -  nothing here is real', S.w * 0.06, S.h * 0.17 + 50 * u, 24 * u, 500, 'rgba(255,255,255,.7)');
    S.pageAnim += (S.page - S.pageAnim) * 0.18;
    const pages = Math.max(1, Math.ceil(apps.length / L.per));
    for (let p = 0; p < pages; p++) {
      const off = (p - S.pageAnim) * S.w;
      if (Math.abs(off) >= S.w) continue;
      for (let i = 0; i < L.per; i++) {
        const app = apps[p * L.per + i];
        if (!app) break;
        const slot = { x: L.slots[i].x + off, y: L.slots[i].y, s: L.slots[i].s };
        drawIcon(app, slot, S.focus === p * L.per + i, 1 - Math.min(1, Math.abs(off) / S.w));
      }
    }
    for (let p = 0; p < pages; p++) {
      g.fillStyle = p === S.page ? '#fff' : 'rgba(255,255,255,.35)';
      g.beginPath(); g.arc(S.w / 2 + (p - (pages - 1) / 2) * 26 * u, S.h * 0.86, 6 * u, 0, 7); g.fill();
    }
    const pw = Math.min(S.w * 0.5, 900 * u), ph = 62 * u;
    g.fillStyle = 'rgba(255,255,255,.16)'; rr((S.w - pw) / 2, S.h * 0.915 - ph / 2, pw, ph, ph / 2); g.fill();
    text(S.typed ? S.typed + '|' : 'Search', (S.w - pw) / 2 + 36 * u, S.h * 0.915, 26 * u, 500, S.typed ? '#fff' : 'rgba(255,255,255,.7)');
  }

  function drawApp(t) {
    const a = S.app, h = hueOf(a.pkg), u = Math.min(S.w, S.h) / 864;
    S.appAnim += (1 - S.appAnim) * 0.16;
    const k = S.appAnim;
    g.save();
    g.globalAlpha = k;
    g.translate(S.w / 2, S.h / 2); g.scale(0.9 + 0.1 * k, 0.9 + 0.1 * k); g.translate(-S.w / 2, -S.h / 2);
    g.fillStyle = 'hsl(' + h + ' 28% 11%)'; g.fillRect(0, 0, S.w, S.h);
    const bar = 120 * u;
    const grd = g.createLinearGradient(0, 0, S.w, 0);
    grd.addColorStop(0, 'hsl(' + h + ' 70% 46%)'); grd.addColorStop(1, 'hsl(' + ((h + 40) % 360) + ' 70% 36%)');
    g.fillStyle = grd; g.fillRect(0, 0, S.w, bar);
    text(a.label, 56 * u, bar * 0.62, 44 * u, 700);
    S.scroll += (S.scrollTo - S.scroll) * 0.2;
    g.save(); g.beginPath(); g.rect(0, bar, S.w, S.h - bar); g.clip();
    const rowH = 132 * u, cols = S.portrait ? 1 : 2, cw = (S.w - 56 * u * (cols + 1)) / cols;
    for (let i = 0; i < 24; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      const x = 56 * u + c * (cw + 56 * u), y = bar + 40 * u + r * (rowH + 24 * u) - S.scroll;
      if (y > S.h || y + rowH < bar) continue;
      g.fillStyle = S.focus === i ? 'hsla(' + h + ' 60% 60% / .35)' : 'rgba(255,255,255,.07)'; rr(x, y, cw, rowH, 28 * u); g.fill();
      g.fillStyle = 'hsl(' + ((h + i * 23) % 360) + ' 70% 60%)'; rr(x + 24 * u, y + 24 * u, rowH - 48 * u, rowH - 48 * u, 20 * u); g.fill();
      text(a.label + ' item ' + (i + 1), x + rowH + 4 * u, y + rowH * 0.38, 30 * u, 600);
      text('Sample row for scrolling and tapping', x + rowH + 4 * u, y + rowH * 0.68, 22 * u, 500, 'rgba(255,255,255,.6)');
    }
    g.restore();
    if (S.typed) {
      const tw = Math.min(S.w * 0.7, 1100 * u);
      g.fillStyle = 'rgba(10,12,24,.86)'; rr((S.w - tw) / 2, S.h - 150 * u, tw, 96 * u, 30 * u); g.fill();
      text(S.typed + '|', (S.w - tw) / 2 + 36 * u, S.h - 102 * u, 34 * u, 600);
    }
    g.restore();
  }

  function drawRecents() {
    const u = Math.min(S.w, S.h) / 864;
    g.fillStyle = 'rgba(8,10,20,.55)'; g.fillRect(0, 0, S.w, S.h);
    text('Recent apps', S.w / 2, S.h * 0.12, 36 * u, 700, '#fff', 'center');
    const cw = S.w * 0.26, ch = S.h * 0.56;
    for (let i = 0; i < 3; i++) {
      const app = apps[(i * 5 + 2) % Math.max(1, apps.length)];
      if (!app) continue;
      const x = S.w / 2 + (i - 1) * (cw + 40 * u) - cw / 2, y = S.h * 0.22, h = hueOf(app.pkg);
      g.fillStyle = 'hsl(' + h + ' 40% 22%)'; rr(x, y, cw, ch, 36 * u); g.fill();
      g.fillStyle = 'hsl(' + h + ' 70% 50%)'; rr(x, y, cw, 90 * u, [36 * u, 36 * u, 0, 0]); g.fill();
      text(app.label, x + 30 * u, y + 46 * u, 30 * u, 700);
    }
  }

  function drawShade() {
    const target = S.shade ? 1 : 0;
    S.shadeAnim += (target - S.shadeAnim) * 0.2;
    if (S.shadeAnim < 0.01) return;
    const u = Math.min(S.w, S.h) / 864, k = S.shadeAnim;
    g.fillStyle = 'rgba(6,8,18,' + 0.6 * k + ')'; g.fillRect(0, 0, S.w, S.h);
    const pw = Math.min(S.w * 0.92, 1100 * u), ph = S.h * 0.8, x = (S.w - pw) / 2, y = -ph + (ph + 30 * u) * k;
    g.fillStyle = 'rgba(28,32,54,.97)'; rr(x, y, pw, ph, 44 * u); g.fill();
    const quick = S.lastShade === 2;
    text(quick ? 'Quick settings' : 'Notifications', x + 44 * u, y + 64 * u, 34 * u, 700);
    if (quick) {
      const names = ['Internet', 'Bluetooth', 'Hotspot', 'Torch', 'Auto-rotate', 'Do Not Disturb', 'Battery Saver', 'Aeroplane'];
      const tw = (pw - 44 * u * 2 - 24 * u * 3) / 4, th = 110 * u;
      names.forEach((n, i) => {
        const tx = x + 44 * u + (i % 4) * (tw + 24 * u), ty = y + 120 * u + Math.floor(i / 4) * (th + 24 * u);
        g.fillStyle = i < 3 ? 'hsl(215 85% 62%)' : 'rgba(255,255,255,.1)'; rr(tx, ty, tw, th, th / 2); g.fill();
        text(n, tx + tw / 2, ty + th / 2, 24 * u, 600, '#fff', 'center');
      });
    } else {
      ['Messages  -  Sam: See you at four?', 'Calendar  -  Physio tomorrow 10:30', 'Weather  -  Light rain this evening'].forEach((n, i) => {
        const ty = y + 120 * u + i * 128 * u;
        g.fillStyle = 'rgba(255,255,255,.08)'; rr(x + 44 * u, ty, pw - 88 * u, 108 * u, 30 * u); g.fill();
        text(n, x + 80 * u, ty + 54 * u, 26 * u, 500);
      });
    }
  }

  function drawOverlays(t) {
    const u = Math.min(S.w, S.h) / 864;
    if (S.volShow > t) {
      const w = 420 * u, x = (S.w - w) / 2, y = 70 * u;
      g.fillStyle = 'rgba(20,24,44,.92)'; rr(x, y, w, 70 * u, 35 * u); g.fill();
      g.fillStyle = 'rgba(255,255,255,.2)'; rr(x + 90 * u, y + 29 * u, w - 124 * u, 12 * u, 6 * u); g.fill();
      g.fillStyle = 'hsl(165 80% 62%)'; rr(x + 90 * u, y + 29 * u, (w - 124 * u) * S.volume / 15, 12 * u, 6 * u); g.fill();
      text('Vol', x + 28 * u, y + 36 * u, 24 * u, 700);
    }
    S.ripples = S.ripples.filter((r) => t - r.t < 600);
    for (const r of S.ripples) {
      const k = (t - r.t) / 600;
      g.strokeStyle = 'rgba(255,255,255,' + (1 - k) + ')'; g.lineWidth = 6 * u * (1 - k) + 1;
      g.beginPath(); g.arc(r.x * S.w, r.y * S.h, (20 + 90 * k) * u, 0, 7); g.stroke();
      g.fillStyle = 'rgba(255,255,255,' + 0.35 * (1 - k) + ')'; g.beginPath(); g.arc(r.x * S.w, r.y * S.h, 22 * u, 0, 7); g.fill();
    }
    if (S.trail && t - S.trail.t < 500) {
      const k = (t - S.trail.t) / 500;
      g.strokeStyle = 'rgba(255,255,255,' + 0.7 * (1 - k) + ')'; g.lineWidth = 14 * u; g.lineCap = 'round';
      g.beginPath(); g.moveTo(S.trail.x1 * S.w, S.trail.y1 * S.h); g.lineTo(S.trail.x2 * S.w, S.trail.y2 * S.h); g.stroke();
    }
  }

  function draw(t) {
    if (surface.width !== S.w || surface.height !== S.h) { surface.width = S.w; surface.height = S.h; forceKey = true; }
    if (S.screen === 'off') { g.fillStyle = '#000'; g.fillRect(0, 0, S.w, S.h); drawOverlays(t); return; }
    drawWallpaper(t);
    if (S.screen === 'app' && S.app) drawApp(t); else drawHome(t);
    if (S.screen === 'recents') drawRecents();
    drawStatus();
    drawShade();
    drawOverlays(t);
  }

  // ------------------------------------------------------------ reactions
  function tap(x, y) {
    S.ripples.push({ x, y, t: now() });
    if (S.screen === 'off') return;
    if (S.shade) { if (y > 0.82) S.shade = 0; return; }
    if (S.screen === 'recents') { S.screen = S.app ? 'app' : 'home'; return; }
    if (S.screen === 'home') {
      const L = iconSlots();
      L.slots.forEach((s, i) => {
        const px = x * S.w, py = y * S.h;
        if (px >= s.x && px <= s.x + s.s && py >= s.y && py <= s.y + s.s * 1.3) {
          const app = apps[S.page * L.per + i];
          if (app) open(app);
        }
      });
    }
  }
  function open(app) { S.app = app; S.screen = 'app'; S.appAnim = 0; S.scroll = S.scrollTo = 0; S.focus = -1; S.typed = ''; S.shade = 0; }
  function gesture(x1, y1, x2, y2) {
    S.trail = { x1, y1, x2, y2, t: now() };
    const dx = x2 - x1, dy = y2 - y1;
    if (S.screen === 'off') return;
    if (Math.abs(dy) > Math.abs(dx)) {
      if (S.shade) { if (dy < 0) S.shade = 0; return; }
      if (y1 < 0.08 && dy > 0) { S.shade = 1; S.lastShade = 1; return; }
      if (S.screen === 'app') S.scrollTo = Math.max(0, Math.min(2400, S.scrollTo - dy * S.h * 1.6));
    } else if (S.screen === 'home') {
      const pages = Math.max(1, Math.ceil(apps.length / iconSlots().per));
      S.page = Math.max(0, Math.min(pages - 1, S.page + (dx < 0 ? 1 : -1)));
    }
  }
  function key(code) {
    const L = iconSlots();
    if (code === 224) { S.screen = S.screen === 'off' ? 'home' : S.screen; return; }
    if (code === 26) { S.screen = S.screen === 'off' ? 'home' : 'off'; return; }
    if (S.screen === 'off') return;
    if (code === 3) { S.screen = 'home'; S.shade = 0; S.focus = -1; S.typed = ''; }
    else if (code === 4) { if (S.shade) S.shade = 0; else if (S.screen !== 'home') { S.screen = 'home'; S.typed = ''; } }
    else if (code === 187) S.screen = S.screen === 'recents' ? 'home' : 'recents';
    else if (code === 24 || code === 25) { S.volume = Math.max(0, Math.min(15, S.volume + (code === 24 ? 1 : -1))); S.volShow = now() + 1600; }
    else if (code >= 19 && code <= 22) {
      const cols = S.screen === 'app' ? (S.portrait ? 1 : 2) : L.cols;
      const max = S.screen === 'app' ? 23 : Math.min(apps.length, (S.page + 1) * L.per) - 1;
      const min = S.screen === 'app' ? 0 : S.page * L.per;
      let f = S.focus < min ? min : S.focus + (code === 19 ? -cols : code === 20 ? cols : code === 21 ? -1 : 1);
      if (S.focus < min) f = min;
      S.focus = Math.max(min, Math.min(max, f));
      if (S.screen === 'app') S.scrollTo = Math.max(0, Math.floor(S.focus / cols) * 156 * (Math.min(S.w, S.h) / 864) - S.h * 0.3);
    } else if (code === 23 || code === 66) {
      if (S.screen === 'home' && apps[S.focus]) open(apps[S.focus]);
      else if (S.screen === 'app') S.ripples.push({ x: 0.5, y: 0.5, t: now() });
    } else if (code === 67) S.typed = S.typed.slice(0, -1);
  }

  demo.handle = function (e) {
    const m = e.m || {};
    switch (e.op) {
      case 'touch':
        if (m.a === 0) S.down = { x: m.x, y: m.y };
        else if (m.a === 1 && S.down) {
          const d = S.down; S.down = null;
          if (Math.hypot(m.x - d.x, m.y - d.y) < 0.02) tap(d.x, d.y); else gesture(d.x, d.y, m.x, m.y);
        }
        break;
      case 'tap': tap(m.x, m.y); break;
      case 'swipe': gesture(m.x1, m.y1, m.x2, m.y2); break;
      case 'key': key(Number(m.code)); break;
      case 'text': S.typed = (S.typed + String(m.text || '')).slice(-60); break;
      case 'panel': S.shade = m.which === 'collapse' ? 0 : (m.which === 'settings' ? 2 : 1); if (S.shade) S.lastShade = S.shade; break;
      case 'launch': open({ pkg: m.pkg, label: m.label || m.pkg }); break;
      case 'intent': open({ pkg: 'settings.' + m.name, label: 'Settings  -  ' + m.name.charAt(0).toUpperCase() + m.name.slice(1) }); break;
      case 'rotation':
        S.portrait = m.mode === 'portrait';
        S.w = S.portrait ? 864 : 1920; S.h = S.portrait ? 1920 : 864;
        break;
    }
  };
  demo.setApps = function (list) { apps = list || []; };

  // ------------------------------------------------------------ loop + H.264 loop-back
  async function setupEncoder() {
    if (!('VideoEncoder' in window) || !GC.player.supported) return false;
    for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42002a', 'avc1.42e028']) {
      const cfg = { codec, width: S.w, height: S.h, bitrate: 6000000, framerate: 30, latencyMode: 'realtime', avc: { format: 'annexb' } };
      try {
        const ok = await VideoEncoder.isConfigSupported(cfg);
        if (!ok.supported) continue;
        encoder = new VideoEncoder({
          output: (chunk) => {
            const buf = new Uint8Array(10 + chunk.byteLength);
            const view = new DataView(buf.buffer);
            buf[0] = 1; buf[1] = chunk.type === 'key' ? 2 : 0; view.setFloat64(2, chunk.timestamp, true);
            chunk.copyTo(buf.subarray(10));
            GC.net.sendBinary(buf.buffer);
          },
          error: (e) => { console.warn('Demo encoder stopped:', e.message); encoder = null; demo.mode = 'direct'; },
        });
        encoder.configure(cfg);
        encoder.cfg = cfg;
        return true;
      } catch (e) { encoder = null; }
    }
    return false;
  }

  function loop(t) {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    if (t - lastDraw < 30) return;
    lastDraw = t;
    draw(t);
    if (demo.mode === 'loopback' && encoder && encoder.state === 'configured') {
      if (encoder.cfg.width !== S.w || encoder.cfg.height !== S.h) {
        encoder.cfg = Object.assign({}, encoder.cfg, { width: S.w, height: S.h });
        encoder.configure(encoder.cfg); forceKey = true;
      }
      if (encoder.encodeQueueSize < 3) {
        const frame = new VideoFrame(surface, { timestamp: Math.round(t * 1000) });
        encoder.encode(frame, { keyFrame: forceKey || frameNo % 60 === 0 });
        frame.close(); frameNo++; forceKey = false;
      }
      // If nothing came back through the bridge, fall back to drawing directly.
      if (!GC.player.live && t - startedAt > 4000) { demo.mode = 'direct'; console.info('Demo: H.264 loop-back unavailable, drawing directly.'); }
    } else {
      GC.player.drawDirect(surface);
    }
  }

  demo.start = async function () {
    if (running) return;
    running = true; demo.running = true;
    surface = document.createElement('canvas');
    surface.width = S.w; surface.height = S.h;
    g = surface.getContext('2d', { alpha: false });
    demo.mode = (await setupEncoder()) ? 'loopback' : 'direct';
    forceKey = true; startedAt = now();
    raf = requestAnimationFrame(loop);
  };
  demo.stop = function () {
    running = false; demo.running = false;
    cancelAnimationFrame(raf);
    if (encoder && encoder.state !== 'closed') { try { encoder.close(); } catch (e) { /* ignore */ } }
    encoder = null; demo.mode = 'off';
  };
  demo.requestKey = function () { forceKey = true; };

  GC.demo = demo;
})();
