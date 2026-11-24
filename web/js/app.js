'use strict';
// GazeCast page logic: layout, buttons, sheets, connection screen, settings.
(function () {
  const { net, player, gaze, demo, icon } = GC;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  let state = { phase: 'searching', active: null, stream: { status: 'idle', mode: 'none' }, saved: [], nearby: [], adb: { ok: true } };
  let cfg = { ui: {}, favourites: [], saved: [] };
  const ui = {
    screen: 'boot', navMode: 'swipe', zoomMode: false, zoom: { z: 1, cx: 0.5, cy: 0.5 },
    sheet: null, kbTarget: null, kbShift: false, kbSym: false, kbEcho: '',
    apps: [], appsLoading: false, appsError: '', query: '', editFav: false,
    view: 'home', wifiMode: 'pair', form: { host: '', port: '', code: '', active: 'host' },
    manual: false, guideStep: 0, booted: false, wasConnected: false,
  };

  // ============================================================ helpers
  function btn(act, ic, label, cat, extra) {
    return '<button class="btn gz" data-act="' + act + '" data-cat="' + cat + '" ' + (extra || '') + '>' +
      '<span class="glyph">' + icon(ic) + '</span><span class="lbl">' + label + '</span></button>';
  }
  function setBtn(el, ic, label, cat) {
    if (!el) return;
    if (el.dataset.ic !== ic) { el.dataset.ic = ic; $('.glyph', el).innerHTML = icon(ic); }
    const l = $('.lbl', el);
    if (l.textContent !== label) l.textContent = label;
    if (cat) el.dataset.cat = cat;
  }

  function toast(text, kind) {
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.innerHTML = icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info') + '<span>' + esc(text) + '</span>';
    $('#toasts').appendChild(t);
    if (kind === 'error') gaze.blip('error');
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, kind === 'error' ? 5200 : 2400);
  }

  function cmd(op, params, quiet) {
    return net.send(op, params).catch((e) => { if (!quiet) toast(e.message, 'error'); throw e; });
  }
  const fireCmd = (op, params) => cmd(op, params).catch(() => {});
  const key = (code, name, long) => fireCmd('key', { code, name, long: !!long });

  function saveUi(patch) {
    Object.assign(cfg.ui, patch);
    applyConfig();
    net.send('config.set', { ui: patch }).catch(() => {});
  }

  function confirmBox(o) {
    return new Promise((resolve) => {
      const m = $('#confirm');
      if (m.onclick && m._resolve) { m._resolve(false); } // a newer question replaces an unanswered one (answer: the safe choice)
      m._resolve = resolve;
      m.innerHTML ='<div class="dialog glass"><div class="dialog-icon ' + (o.tone || 'warn') + '">' + icon(o.icon || 'alert') + '</div>' +
        '<h2>' + esc(o.title) + '</h2><p>' + esc(o.body) + '</p><div class="dialog-actions">' +
        '<button class="wide-btn gz primary" data-cat="sys" data-r="0">' + icon(o.safeIcon || 'check') + '<span>' + esc(o.safe) + '</span></button>' +
        '<button class="wide-btn gz" data-cat="danger" data-r="1">' + icon(o.riskIcon || 'exit') + '<span>' + esc(o.risk) + '</span></button></div></div>';
      m.inert = false; m.classList.add('open');
      gaze.hold(700);
      m.onclick = (e) => {
        const b = e.target.closest('[data-r]');
        if (!b) return;
        m.classList.remove('open'); m.inert = true; m.onclick = null; m._resolve = null;
        gaze.hold(400);
        resolve(b.dataset.r === '1');
      };
    });
  }

  // ============================================================ config
  function applyConfig() {
    const c = cfg.ui;
    document.documentElement.dataset.theme = c.theme === 'light' ? 'light' : 'dark';
    gaze.enabled = c.dwellEnabled !== false;
    gaze.dwellMs = clamp(Number(c.dwellMs) || 800, 300, 3000);
    gaze.videoDwell = c.videoDwell !== false;
    gaze.repeat = c.dwellRepeat === true;
    gaze.sounds = c.sounds !== false;
    document.body.classList.toggle('dock-pinned', !!c.dockPinned);
    player.setMuted(!!c.muted);
    updateDynamic();
    layout();
    if (ui.sheet === 'options') renderOptionValues();
  }

  // ============================================================ main screen: clusters + dock
  function buildMain() {
    $('#c-nav').innerHTML =
      btn('navmode', 'swipe', 'Swipe mode', 'nav') + btn('up', 'up', 'Up', 'nav', 'data-repeat') + btn('ok', 'ok', 'OK', 'nav') +
      btn('left', 'left', 'Left', 'nav', 'data-repeat') + btn('down', 'down', 'Down', 'nav', 'data-repeat') + btn('right', 'right', 'Right', 'nav', 'data-repeat');
    $('#c-gaze').innerHTML =
      '<button class="btn gz gz-unlock" data-act="pause" data-cat="gaze"><span class="glyph">' + icon('eyeoff') + '</span><span class="lbl">Pause gaze</span></button>' +
      btn('zoom', 'zoom', 'Zoom', 'gaze');
    $('#c-sys').innerHTML =
      btn('back', 'back', 'Back', 'sys') + btn('home', 'home', 'Home', 'sys') + btn('recents', 'recents', 'Recents', 'sys') +
      btn('notifications', 'bell', 'Alerts', 'sys') + btn('quick', 'sliders', 'Quick settings', 'sys') +
      btn('voldown', 'voldown', 'Volume -', 'sys', 'data-repeat') + btn('volup', 'volup', 'Volume +', 'sys', 'data-repeat') +
      btn('mute', 'speaker', 'Mute', 'sys') + btn('wake', 'sun', 'Wake', 'sys') + btn('power', 'power', 'Power', 'danger');
    $('#dock').innerHTML =
      btn('apps', 'grid', 'Apps', 'apps') + btn('shortcuts', 'gear', 'Phone settings', 'set') +
      btn('keyboard', 'keyboard', 'Keyboard', 'nav') + btn('connection', 'link', 'Connection', 'sys') + btn('options', 'tune', 'Options', 'gaze');
    $('#offline-icon').innerHTML = icon('alert');
    $('#stopped-icon').innerHTML = icon('power');
    $('#reopen-btn').innerHTML = icon('refresh') + '<span>Start demo again</span>';
    $('#winctl').innerHTML = btn('win-min', 'winmin', 'Minimise', 'nav') + btn('win-max', 'winrestore', 'Restore', 'nav') + btn('win-close', 'close', 'Close', 'danger');
    updateWinButtons();
  }

  // ------------------------------------------------------------ window buttons
  // Space kept free in the top-right corner for the always-visible window buttons.
  const WIN_W = 344, WIN_H = 128;
  function isFullscreen() {
    return !!document.fullscreenElement || (window.innerWidth >= screen.width && window.innerHeight >= screen.height);
  }
  function updateWinButtons() {
    const b = $('#winctl [data-act="win-max"]');
    if (!b) return;
    const fs = isFullscreen();
    setBtn(b, fs ? 'winrestore' : 'winmax', fs ? 'Restore' : 'Full screen');
  }
  async function winMinimise() {
    const wasFs = !!document.fullscreenElement;
    if (wasFs) { try { await document.exitFullscreen(); } catch (e) { /* carry on */ } }
    try {
      const d = await net.send('window.minimize');
      ui.restoreFs = wasFs && !d.simulated;
      if (d.simulated && wasFs) document.documentElement.requestFullscreen().catch(() => {});
      toast(d.simulated ? 'Minimised (demo). In the real app, open GazeCast from the taskbar to come back.' : 'Minimised. Open GazeCast from the taskbar to come back.');
    } catch (e) { toast(e.message, 'error'); }
  }
  async function winToggleMax() {
    try {
      if (document.fullscreenElement) { await document.exitFullscreen(); }
      else if (isFullscreen()) {
        const d = await net.send('window.toggleMaximize');
        if (d.simulated) toast('Demo: the real app would leave full screen here');
      } else {
        try { await document.documentElement.requestFullscreen(); }
        catch (e) {
          const d = await net.send('window.toggleMaximize');
          if (d.simulated) toast('Full screen is not available in this demo view');
        }
      }
    } catch (e) { toast(e.message || 'Press F11 on the keyboard for full screen', 'error'); }
    setTimeout(updateWinButtons, 400);
  }
  async function winClose() {
    closeSheet();
    const go = await confirmBox({
      icon: 'power', title: 'Close GazeCast?',
      body: 'The phone picture and the controls will stop. You can start again any time with start.bat.',
      safe: 'Stay', safeIcon: 'chevleft', risk: 'Close', riskIcon: 'close',
    });
    if (!go) return;
    try {
      const d = await net.send('window.close');
      if (d.simulated) { const s = $('#stopped'); s.inert = false; s.classList.add('open'); gaze.hold(700); }
      else setTimeout(() => { try { window.close(); } catch (e) { /* the bridge closes the window */ } }, 300);
    } catch (e) {
      try { window.close(); } catch (err) { /* ignore */ }
      toast('GazeCast has already stopped. Press Alt+F4 to close this window.', 'error');
    }
  }
  function winReopen() {
    const s = $('#stopped'); s.classList.remove('open'); s.inert = true;
    ui.manual = false; ui.stopped = false;
    net.send('window.reopen').catch(() => {});
    setView('home'); show('connect');
  }
  function initWindowButtons() {
    document.addEventListener('fullscreenchange', updateWinButtons);
    window.addEventListener('resize', updateWinButtons);
    // Back from the taskbar: put full screen back if we left it to minimise.
    const back = () => {
      if (!ui.restoreFs || document.hidden) return;
      ui.restoreFs = false;
      if (!isFullscreen()) document.documentElement.requestFullscreen().catch(() => { net.send('window.toggleMaximize').catch(() => {}); });
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
  }

  function updateDynamic() {
    const nav = $('#c-nav');
    if (!nav.firstChild) return;
    const mode = $('[data-act="navmode"]'), ok = $('[data-act="ok"]');
    nav.dataset.cat = ui.zoomMode ? 'gaze' : 'nav';
    $$('.btn', nav).forEach((b) => { b.dataset.cat = ui.zoomMode ? 'gaze' : 'nav'; });
    if (ui.zoomMode) {
      setBtn(mode, 'minus', 'Zoom out');
      setBtn(ok, 'plus', 'Zoom in');
    } else {
      setBtn(mode, ui.navMode === 'dpad' ? 'dpad' : 'swipe', ui.navMode === 'dpad' ? 'D-pad mode' : 'Swipe mode');
      setBtn(ok, 'ok', 'OK');
    }
    mode.classList.toggle('alt', !ui.zoomMode && ui.navMode === 'dpad');
    const z = ui.zoom.z;
    const zb = $('[data-act="zoom"]');
    setBtn(zb, ui.zoomMode ? 'check' : 'zoom', ui.zoomMode ? 'Done' : (z > 1 ? 'Zoom ' + z + '×' : 'Zoom'));
    zb.classList.toggle('on', ui.zoomMode || z > 1);
    const muted = !!cfg.ui.muted, noAudio = state.stream && state.stream.audio === 'unavailable';
    const mb = $('[data-act="mute"]');
    setBtn(mb, muted || noAudio ? 'mute' : 'speaker', noAudio ? 'No sound' : muted ? 'Unmute' : 'Mute');
    mb.classList.toggle('on', muted && !noAudio);
    const pb = $('[data-act="pause"]');
    setBtn(pb, gaze.paused ? 'eye' : 'eyeoff', gaze.paused ? 'Resume' : 'Pause gaze');
    pb.classList.toggle('on', gaze.paused);
    pb.dataset.dwell = gaze.paused ? '1.6' : '1';
    $('#zoom-badge').innerHTML = ui.zoomMode ? icon('zoom') + '<span>Look at a spot to zoom in. Arrows move the view.</span>' : (z > 1 ? icon('zoom') + '<span>' + z + '×</span>' : '');
    $('#zoom-badge').classList.toggle('show', ui.zoomMode || z > 1);
    $('#pause-badge').innerHTML = icon('lock') + '<span>Gaze paused. Look at Resume to continue.</span>';
    $('#pause-badge').classList.toggle('show', gaze.paused);
  }

  // ------------------------------------------------------------ layout engine
  const GAP = 12, PAD = 10, EDGE = 16, BEZEL = 9;
  function kbHeight(B) { const kh = clamp(Math.round(B * 0.62), 62, 96); return { kh, total: 5 * kh + 4 * 8 + 2 * 14 + 44 }; }

  function layout() {
    const W = window.innerWidth, H = window.innerHeight, c = cfg.ui;
    const want = clamp(Number(c.buttonSize) || 120, 100, 220);
    const aspect = player.width && player.height ? player.width / player.height : 20 / 9;
    const fit = (a) => {
      const w = Math.max(0, a.w - 2 * BEZEL), h = Math.max(0, a.h - 2 * BEZEL);
      const vw = Math.min(w, h * aspect), vh = vw / aspect;
      return { w: vw + 2 * BEZEL, h: vh + 2 * BEZEL, area: vw * vh };
    };
    const top = (B) => (c.dockPinned ? B + 2 * PAD + EDGE + 10 : 66);
    // The window buttons own the top-right corner (x >= winX, y <= WIN_H). Place the
    // phone as large as possible without going underneath them.
    const winX = W - WIN_W;
    const place3 = (a) => {
      const centred = (r) => { const f = fit(r); return { x: r.x + (r.w - f.w) / 2, y: r.y + (r.h - f.h) / 2, w: f.w, h: f.h, area: f.area }; };
      const r0 = centred(a);
      if (!(r0.x + r0.w > winX && r0.y < WIN_H)) return r0;
      const yLow = Math.max(a.y, WIN_H);
      const below = centred({ x: a.x, y: yLow, w: a.w, h: a.y + a.h - yLow });
      const beside = centred({ x: a.x, y: a.y, w: Math.min(a.x + a.w, winX - GAP) - a.x, h: a.h });
      return below.area >= beside.area ? below : beside;
    };

    // "below": phone on top, buttons in a bar underneath.   [nav 3x2] [gaze 1x2] [system 5x2]
    let Bb = want;
    while (9 * Bb + 6 * GAP + 6 * PAD + 2 * GAP > W - 2 * EDGE && Bb > 84) Bb -= 2;
    const barH = 2 * Bb + GAP + 2 * PAD;
    const areaB = { x: EDGE, y: top(Bb), w: W - 2 * EDGE, h: H - top(Bb) - EDGE - barH - GAP };
    // "sides": buttons in columns left and right of the phone (best for portrait apps).
    let Bs = want;
    const topR = (B) => Math.max(top(B), WIN_H);
    while ((4 * Bs + 3 * GAP + 2 * PAD > H - topR(Bs) - EDGE || 3 * Bs + 3 * GAP + 4 * PAD > H - topR(Bs) - EDGE) && Bs > 84) Bs -= 2;
    const colW = 3 * Bs + 2 * GAP + 2 * PAD;
    const areaS = { x: EDGE + colW + GAP, y: top(Bs), w: W - 2 * EDGE - 2 * colW - 2 * GAP, h: H - top(Bs) - EDGE };

    let mode = c.layout === 'below' || c.layout === 'sides' ? c.layout : (place3(areaB).area >= place3(areaS).area ? 'below' : 'sides');
    const kbOpen = ui.sheet === 'keyboard';
    const B = mode === 'below' ? Bb : Bs;
    const root = document.documentElement.style;
    root.setProperty('--B', B + 'px');
    root.setProperty('--kh', kbHeight(B).kh + 'px');
    document.body.dataset.layout = mode;

    let area = mode === 'below' ? areaB : areaS;
    if (kbOpen) area = { x: EDGE, y: top(B), w: W - 2 * EDGE, h: H - top(B) - kbHeight(B).total - GAP };
    const f = place3(area);
    place($('#phone'), f.x, f.y, f.w, f.h);

    // Top bar: centre the menu in the space left of the window buttons and tell
    // the chips how much room they have.
    const usable = winX;
    const dockOpenW = 5 * B + 4 * GAP + 2 * PAD;
    const cx = clamp(usable / 2, EDGE + dockOpenW / 2, Math.max(EDGE + dockOpenW / 2, usable - 8 - dockOpenW / 2));
    $('#dock').style.left = Math.round(cx) + 'px';
    const dockW = c.dockPinned ? dockOpenW : (W <= 1560 ? 312 : 624);
    root.setProperty('--chip-max', Math.max(54, Math.round(cx - dockW / 2 - 84)) + 'px');
    const room = usable - (cx + dockW / 2) - 24;
    document.body.classList.toggle('top-tight', room < 320);
    document.body.classList.toggle('top-tighter', room < 240);

    const nav = $('#c-nav'), gz = $('#c-gaze'), sys = $('#c-sys');
    const swap = !!c.swapSides;
    const mirror = (x, w) => (swap ? W - x - w : x);
    if (mode === 'below') {
      const y = H - EDGE - barH;
      const navW = 3 * B + 2 * GAP + 2 * PAD, gzW = B + 2 * PAD, sysW = 5 * B + 4 * GAP + 2 * PAD;
      nav.style.setProperty('--cols', 3); gz.style.setProperty('--cols', 1); sys.style.setProperty('--cols', 5);
      place(nav, mirror(EDGE, navW), y);
      place(sys, mirror(W - EDGE - sysW, sysW), y);
      const free0 = EDGE + navW, free1 = W - EDGE - sysW;
      place(gz, mirror(free0 + (free1 - free0 - gzW) / 2, gzW), y);
    } else {
      nav.style.setProperty('--cols', 3); gz.style.setProperty('--cols', 3); sys.style.setProperty('--cols', 3);
      const navH = 2 * B + GAP + 2 * PAD, gzH = B + 2 * PAD, sysH = 4 * B + 3 * GAP + 2 * PAD;
      // whichever column ends up on the right starts below the window buttons
      const colY = (right, h) => { const t = right ? topR(B) : top(B); return t + Math.max(0, (H - t - EDGE - h) / 2); };
      const y0 = colY(swap, navH + GAP + gzH);
      place(nav, mirror(EDGE, colW), y0);
      place(gz, mirror(EDGE, colW), y0 + navH + GAP);
      place(sys, mirror(W - EDGE - colW, colW), colY(!swap, sysH));
    }
    applyZoom();
  }
  function place(el, x, y, w, h) {
    el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(y) + 'px';
    if (w != null) { el.style.width = Math.round(w) + 'px'; el.style.height = Math.round(h) + 'px'; }
  }

  // ------------------------------------------------------------ dock (auto-collapsing)
  let dockTimer = 0;
  function dockOpen(open) {
    const d = $('#dock');
    clearTimeout(dockTimer);
    if (cfg.ui.dockPinned) open = true;
    if (open === d.classList.contains('open')) return;
    d.classList.toggle('open', open);
    if (open) {
      $$('.btn', d).forEach((b) => b.setAttribute('aria-disabled', 'true'));
      setTimeout(() => { $$('.btn', d).forEach((b) => b.removeAttribute('aria-disabled')); gaze.refresh(); }, 320);
    }
  }
  function initDock() {
    const d = $('#dock');
    d.addEventListener('pointerenter', () => { if (!gaze.paused) { clearTimeout(dockTimer); dockTimer = setTimeout(() => dockOpen(true), 160); } });
    d.addEventListener('pointerleave', () => { clearTimeout(dockTimer); dockTimer = setTimeout(() => dockOpen(false), 1300); });
    d.addEventListener('click', (e) => {
      if (!d.classList.contains('open')) { e.stopPropagation(); if (!gaze.paused) dockOpen(true); }
    }, true);
  }

  // ============================================================ phone picture: touch, dwell, zoom
  function norm(x, y) {
    const r = $('#screen').getBoundingClientRect();
    return { x: clamp((x - r.left) / r.width, 0, 1), y: clamp((y - r.top) / r.height, 0, 1) };
  }
  function tapMark(x, y) {
    const box = $('#viewport').getBoundingClientRect();
    const m = document.createElement('i');
    m.style.left = (x - box.left) + 'px'; m.style.top = (y - box.top) + 'px';
    $('#taps').appendChild(m);
    setTimeout(() => m.remove(), 600);
  }
  function initSurface() {
    const vp = $('#viewport');
    let down = false, swallow = false, lastMove = 0;
    vp.addEventListener('pointerdown', (e) => {
      player.unlockAudio();
      if (gaze.paused || !state.active) return;
      if (ui.zoomMode) { zoomAt(e.clientX, e.clientY); swallow = true; return; }
      if (gaze.videoJustFired(e.clientX, e.clientY)) { swallow = true; return; }
      swallow = false; down = true;
      try { vp.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      const p = norm(e.clientX, e.clientY);
      net.fire('touch', { a: 0, x: p.x, y: p.y });
      tapMark(e.clientX, e.clientY);
    });
    vp.addEventListener('pointermove', (e) => {
      if (!down) return;
      const t = performance.now();
      if (t - lastMove < 8) return;
      lastMove = t;
      const p = norm(e.clientX, e.clientY);
      net.fire('touch', { a: 2, x: p.x, y: p.y });
    });
    const up = (e) => {
      if (!down) return;
      down = false;
      const p = norm(e.clientX, e.clientY);
      net.fire('touch', { a: 1, x: p.x, y: p.y });
    };
    vp.addEventListener('pointerup', up);
    vp.addEventListener('pointercancel', up);
    vp.addEventListener('contextmenu', (e) => e.preventDefault());
    vp.addEventListener('wheel', (e) => {
      if (gaze.paused || !state.active) return;
      e.preventDefault();
      const p = norm(e.clientX, e.clientY), d = clamp(e.deltaY / 600, -0.3, 0.3);
      fireCmd('swipe', { x1: p.x, y1: p.y, x2: p.x, y2: clamp(p.y - d, 0.02, 0.98), ms: 120, label: 'wheel' });
    }, { passive: false });

    gaze.watchSurface(vp, $('#vring'), (x, y) => {
      if (!state.active) return;
      if (ui.zoomMode) { zoomAt(x, y); return; }
      const p = norm(x, y);
      tapMark(x, y);
      fireCmd('tap', { x: p.x, y: p.y });
    });
  }

  const ZOOMS = [1, 1.5, 2, 3, 4];
  function applyZoom() {
    const vp = $('#viewport'), cv = $('#screen');
    const w = vp.clientWidth, h = vp.clientHeight, z = ui.zoom.z;
    const tx = clamp(w / 2 - ui.zoom.cx * w * z, w - w * z, 0), ty = clamp(h / 2 - ui.zoom.cy * h * z, h - h * z, 0);
    cv.style.transform = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(' + z + ')';
    // keep the stored centre inside the reachable range so panning feels direct
    if (z > 1) { ui.zoom.cx = (w / 2 - tx) / (w * z); ui.zoom.cy = (h / 2 - ty) / (h * z); }
  }
  function zoomStep(dir) {
    const i = clamp(ZOOMS.indexOf(ui.zoom.z) + dir, 0, ZOOMS.length - 1);
    ui.zoom.z = ZOOMS[i];
    if (ui.zoom.z === 1) { ui.zoom.cx = 0.5; ui.zoom.cy = 0.5; }
    applyZoom(); updateDynamic();
  }
  function zoomAt(x, y) {
    const p = norm(x, y);
    ui.zoom.cx = p.x; ui.zoom.cy = p.y;
    tapMark(x, y);
    zoomStep(1);
  }
  function pan(dir) {
    const s = 0.3 / ui.zoom.z;
    if (dir === 'left') ui.zoom.cx -= s; if (dir === 'right') ui.zoom.cx += s;
    if (dir === 'up') ui.zoom.cy -= s; if (dir === 'down') ui.zoom.cy += s;
    ui.zoom.cx = clamp(ui.zoom.cx, 0, 1); ui.zoom.cy = clamp(ui.zoom.cy, 0, 1);
    applyZoom();
  }

  // ------------------------------------------------------------ direction buttons
  const DPAD = { up: [19, 'DPAD_UP'], down: [20, 'DPAD_DOWN'], left: [21, 'DPAD_LEFT'], right: [22, 'DPAD_RIGHT'] };
  // In swipe mode the arrow says where you want to GO: "Down" shows what is further down the page.
  const SWIPE = {
    down: [0.5, 0.7, 0.5, 0.3], up: [0.5, 0.3, 0.5, 0.7],
    right: [0.74, 0.5, 0.26, 0.5], left: [0.26, 0.5, 0.74, 0.5],
  };
  function nav(dir) {
    if (ui.zoomMode) { pan(dir); return; }
    if (ui.navMode === 'dpad') { key(DPAD[dir][0], DPAD[dir][1]); return; }
    let s = SWIPE[dir];
    if (cfg.ui.invertSwipe) s = [s[2], s[3], s[0], s[1]];
    fireCmd('swipe', { x1: s[0], y1: s[1], x2: s[2], y2: s[3], ms: 240, label: dir });
  }

  // ============================================================ sheets
  function openSheet(name) {
    if (ui.sheet === name) return;
    closeSheet(true);
    ui.sheet = name;
    const el = $('#' + name);
    el.inert = false; el.classList.add('open');
    if (name !== 'keyboard') $('#scrim').classList.add('open');
    document.body.dataset.sheet = name;
    dockOpen(false);
    gaze.hold(550);
    if (name === 'keyboard') layout();
  }
  function closeSheet(keepKb) {
    const name = ui.sheet;
    if (!name) return;
    const el = $('#' + name);
    el.classList.remove('open'); el.inert = true;
    $('#scrim').classList.remove('open');
    ui.sheet = null;
    delete document.body.dataset.sheet;
    if (name === 'drawer') { kbHide(); ui.editFav = false; }
    if (name === 'keyboard') { ui.kbTarget = null; layout(); }
    gaze.hold(350);
  }
  function rail(buttons) { return '<div class="rail">' + buttons.join('') + '</div>'; }
  function scrollBtns(target) {
    return btn('scroll-up', 'chevup', 'Up', 'nav', 'data-repeat data-target="' + target + '"') +
           btn('scroll-down', 'chevdown', 'Down', 'nav', 'data-repeat data-target="' + target + '"');
  }

  // ------------------------------------------------------------ app drawer
  function buildDrawer() {
    $('#drawer').innerHTML =
      '<div class="sheet-body"><header class="sheet-head"><div><h2>Apps</h2><p id="apps-count">Everything installed on the phone</p></div>' +
      '<label class="search">' + icon('search') + '<input id="app-search" type="text" placeholder="Search apps" autocomplete="off" spellcheck="false"></label></header>' +
      '<div class="scroller" id="app-scroll"><div id="app-grid"></div></div></div>' +
      rail([btn('close-sheet', 'close', 'Close', 'danger'), btn('app-kb', 'keyboard', 'Type to search', 'nav'),
        btn('fav-edit', 'star', 'Edit favourites', 'apps'), btn('apps-refresh', 'refresh', 'Refresh', 'sys'), scrollBtns('#app-scroll')]);
    $('#app-search').addEventListener('input', (e) => { ui.query = e.target.value; renderApps(); });
  }
  function tileHtml(app, i, fav) {
    let h = 0; for (let k = 0; k < app.pkg.length; k++) h = (h * 31 + app.pkg.charCodeAt(k)) % 360;
    const words = app.label.trim().split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w));
    const letters = (words.length > 1 ? Array.from(words[0])[0] + Array.from(words[1])[0] : Array.from(words[0] || app.label || '?')[0]).toUpperCase();
    return '<button class="tile gz" data-cat="apps" data-act="app" data-pkg="' + esc(app.pkg) + '" style="--i:' + Math.min(i, 30) + ';--h:' + h + '">' +
      '<span class="app-icon">' + esc(letters) + '</span><span class="lbl">' + esc(app.label) + '</span>' +
      '<span class="fav' + (fav ? ' is' : '') + '">' + icon('star') + '</span></button>';
  }
  function renderApps() {
    const grid = $('#app-grid');
    if (!grid) return;
    const q = ui.query.trim().toLowerCase();
    $('#drawer').classList.toggle('editing', ui.editFav);
    setBtn($('[data-act="fav-edit"]'), ui.editFav ? 'check' : 'star', ui.editFav ? 'Done' : 'Edit favourites');
    if (ui.appsLoading && !ui.apps.length) {
      grid.className = 'grid';
      grid.innerHTML = Array.from({ length: 18 }, (_, i) => '<div class="tile skeleton" style="--i:' + i + '"><span class="app-icon"></span><span class="lbl"></span></div>').join('');
      return;
    }
    if (ui.appsError && !ui.apps.length) {
      grid.className = 'empty';
      grid.innerHTML = '<div class="empty-icon">' + icon('alert') + '</div><h3>The app list could not be loaded</h3><p>' + esc(ui.appsError) + '</p>' +
        '<button class="wide-btn gz primary" data-cat="apps" data-act="apps-refresh">' + icon('refresh') + '<span>Try again</span></button>';
      return;
    }
    const list = ui.apps.filter((a) => !q || a.label.toLowerCase().indexOf(q) >= 0 || a.pkg.toLowerCase().indexOf(q) >= 0);
    $('#apps-count').textContent = ui.editFav ? 'Choose the apps to pin at the top' : (ui.apps.length + ' apps on the phone' + (ui.appsLoading ? ' · refreshing' : ''));
    if (!list.length) {
      grid.className = 'empty';
      grid.innerHTML = '<div class="empty-icon">' + icon('search') + '</div><h3>No app matches “' + esc(ui.query) + '”</h3><p>Try fewer letters, or clear the search to see everything.</p>' +
        '<button class="wide-btn gz primary" data-cat="apps" data-act="search-clear">' + icon('close') + '<span>Clear search</span></button>';
      return;
    }
    const favs = cfg.favourites.map((p) => list.find((a) => a.pkg === p)).filter(Boolean);
    let html = '', n = 0;
    if (favs.length && !q) {
      html += '<h3 class="grid-title">' + icon('star') + 'Favourites</h3><div class="grid">' + favs.map((a) => tileHtml(a, n++, true)).join('') + '</div><h3 class="grid-title">All apps</h3>';
    } else if (!q && !ui.editFav) {
      html += '<p class="hint">' + icon('star') + 'Tip: choose “Edit favourites” to pin the apps you use most at the top.</p>';
    }
    html += '<div class="grid">' + list.map((a) => tileHtml(a, n++, cfg.favourites.indexOf(a.pkg) >= 0)).join('') + '</div>';
    grid.className = '';
    grid.innerHTML = html;
  }
  function loadApps(refresh) {
    ui.appsLoading = true; ui.appsError = '';
    renderApps();
    net.send('apps', { refresh: !!refresh }).then((d) => {
      ui.apps = d.apps || []; ui.appsLoading = !!d.loading;
      demo.setApps(ui.apps);
      renderApps();
    }).catch((e) => { ui.appsLoading = false; ui.appsError = e.message; renderApps(); });
  }
  function openDrawer() {
    ui.query = ''; ui.editFav = false;
    $('#app-search').value = '';
    openSheet('drawer');
    $('#app-scroll').scrollTop = 0;
    loadApps(false);
    setTimeout(() => $('#app-search').focus({ preventScroll: true }), 300);
  }
  function launchApp(el) {
    const pkg = el.dataset.pkg, app = ui.apps.find((a) => a.pkg === pkg);
    if (ui.editFav) {
      const i = cfg.favourites.indexOf(pkg);
      if (i >= 0) cfg.favourites.splice(i, 1); else cfg.favourites.push(pkg);
      net.send('config.set', { favourites: cfg.favourites }).catch(() => {});
      const top = $('#app-scroll').scrollTop;
      renderApps();
      $('#app-scroll').scrollTop = top;
      $('#drawer').classList.add('no-stagger');
      return;
    }
    closeSheet();
    toast('Opening ' + (app ? app.label : 'app'), 'ok');
    fireCmd('launch', { pkg });
  }

  // ------------------------------------------------------------ phone settings shortcuts
  const TILES = [
    ['settings', 'gear', 'Settings'], ['wifi', 'wifi', 'Wi-Fi'], ['bluetooth', 'bluetooth', 'Bluetooth'],
    ['hotspot', 'hotspot', 'Hotspot'], ['cast', 'cast', 'Cast'], ['display', 'display', 'Display'],
    ['sound', 'note', 'Sound'], ['accessibility', 'access', 'Accessibility'], ['battery', 'battery', 'Battery'],
  ];
  function buildShortcuts() {
    $('#shortcuts').innerHTML = rail([btn('close-sheet', 'close', 'Close', 'danger')]) +
      '<div class="sheet-body"><header class="sheet-head"><div><h2>Phone settings</h2><p>Jump straight to a settings page on the phone</p></div></header>' +
      '<div class="grid tiles3">' +
      TILES.map((t, i) => '<button class="tile big gz" data-cat="set" data-act="intent" data-name="' + t[0] + '" style="--i:' + i + '"><span class="glyph">' + icon(t[1]) + '</span><span class="lbl">' + t[2] + '</span></button>').join('') +
      '<button class="tile big gz" data-cat="sys" data-act="quick-close" style="--i:9"><span class="glyph">' + icon('sliders') + '</span><span class="lbl">Quick settings</span></button>' +
      '<button class="tile big gz" data-cat="sys" data-act="notif-close" style="--i:10"><span class="glyph">' + icon('bell') + '</span><span class="lbl">Notifications</span></button>' +
      '<button class="tile big gz" data-cat="gaze" data-act="rotate" style="--i:11"><span class="glyph">' + icon('rotate') + '</span><span class="lbl" id="rotate-lbl">Auto-rotate</span></button>' +
      '</div></div>';
  }
  function updateRotateTile() {
    const l = $('#rotate-lbl'); if (!l) return;
    const auto = cfg.ui.rotation === 'auto';
    l.textContent = auto ? 'Auto-rotate: on' : 'Landscape lock';
    l.closest('.tile').classList.toggle('on', auto);
  }
  async function runIntent(name) {
    const a = state.active;
    if (a && name === 'hotspot' && a.viaHotspot) {
      const go = await confirmBox({
        icon: 'hotspot', title: 'You are connected through this hotspot',
        body: 'This computer reaches the phone through the phone’s own hotspot. If the hotspot is turned off, GazeCast loses the phone at once and someone will have to switch it back on at the phone.',
        safe: 'Stay here', risk: 'Open hotspot settings anyway', riskIcon: 'hotspot',
      });
      if (!go) return;
    } else if (a && name === 'wifi' && a.transport === 'wifi' && !a.viaHotspot) {
      const go = await confirmBox({
        icon: 'wifi', title: 'You are connected over Wi-Fi',
        body: 'GazeCast reaches the phone over Wi-Fi. If Wi-Fi is turned off on the phone, the picture and controls stop until it is switched back on at the phone.',
        safe: 'Stay here', risk: 'Open Wi-Fi settings anyway', riskIcon: 'wifi',
      });
      if (!go) return;
    }
    closeSheet();
    fireCmd('intent', { name });
  }

  // ------------------------------------------------------------ options sheet
  const OPTIONS = [
    { k: 'dwellEnabled', t: 'Dwell click', d: 'One look presses a button once. Look away and back to press again', i: 'eye', type: 'toggle' },
    { k: 'dwellMs', t: 'Dwell time', d: 'How long to look before it presses', i: 'pause', type: 'step', min: 300, max: 3000, step: 100, fmt: (v) => (v / 1000).toFixed(1) + ' s' },
    { k: 'videoDwell', t: 'Dwell on the phone picture', d: 'Looking at a spot on the phone taps it once', i: 'hand', type: 'toggle' },
    { k: 'dwellRepeat', t: 'Hold to repeat', d: 'Arrows and volume keep pressing while you keep looking. Normally off', i: 'refresh', type: 'toggle' },
    { k: 'buttonSize', t: 'Button size', d: 'Bigger buttons are easier to hit', i: 'plus', type: 'step', min: 120, max: 200, step: 10, fmt: (v) => v + ' px' },
    { k: 'theme', t: 'Theme', d: 'Dark is calmer on the eyes', i: 'moon', type: 'seg', opts: [['dark', 'Dark'], ['light', 'Light']] },
    { k: 'navMode', t: 'Arrows start in', d: 'Swipe scrolls, D-pad moves the focus', i: 'dpad', type: 'seg', opts: [['swipe', 'Swipe'], ['dpad', 'D-pad']] },
    { k: 'swapSides', t: 'Swap sides', d: 'Arrows on the right, phone buttons on the left', i: 'swap', type: 'toggle' },
    { k: 'invertSwipe', t: 'Reverse swipe direction', d: 'Arrows move the finger, not the page', i: 'swipe', type: 'toggle' },
    { k: 'dockPinned', t: 'Keep the top menu open', d: 'Otherwise it opens when you look at it', i: 'dots', type: 'toggle' },
    { k: 'layout', t: 'Button layout', d: 'Auto picks whichever makes the phone biggest', i: 'layout', type: 'seg', wide: true, opts: [['auto', 'Auto'], ['below', 'Below phone'], ['sides', 'Beside phone']] },
    { k: 'sounds', t: 'Click sounds', d: 'A soft tick when a button is pressed', i: 'note', type: 'toggle' },
    { k: 'audio', t: 'Phone sound on this computer', d: 'Plays the phone’s audio here', i: 'speaker', type: 'toggle' },
    { k: 'forceLandscape', t: 'Keep every app in landscape', d: 'Also turns apps that prefer portrait', i: 'rotate', type: 'toggle', wide: true },
    { k: 'quality', t: 'Picture quality', d: 'Lower is smoother on weak Wi-Fi', i: 'image', type: 'seg', wide: true, opts: [['low', 'Smooth'], ['high', 'Sharp'], ['ultra', 'Ultra']] },
  ];
  function buildOptions() {
    const cards = OPTIONS.map((o) => {
      const head = '<span class="opt-ico">' + icon(o.i) + '</span><span class="opt-text"><b>' + o.t + '</b><small>' + o.d + '</small></span>';
      if (o.type === 'toggle') return '<button class="opt gz' + (o.wide ? ' span' : '') + '" data-cat="gaze" data-act="opt-toggle" data-k="' + o.k + '">' + head + '<span class="switch"><i></i></span></button>';
      if (o.type === 'step') return '<div class="opt" data-k="' + o.k + '">' + head +
        '<button class="mini gz" data-cat="gaze" data-act="opt-step" data-k="' + o.k + '" data-d="-1" data-repeat>' + icon('minus') + '</button>' +
        '<output></output><button class="mini gz" data-cat="gaze" data-act="opt-step" data-k="' + o.k + '" data-d="1" data-repeat>' + icon('plus') + '</button></div>';
      return '<div class="opt' + (o.wide ? ' span' : '') + '" data-k="' + o.k + '">' + head + '<span class="seg">' +
        o.opts.map((p) => '<button class="mini gz" data-cat="gaze" data-act="opt-seg" data-k="' + o.k + '" data-v="' + p[0] + '">' + p[1] + '</button>').join('') + '</span></div>';
    }).join('');
    $('#options').innerHTML = rail([btn('close-sheet', 'close', 'Close', 'danger'), scrollBtns('#opt-scroll')]) +
      '<div class="sheet-body"><header class="sheet-head"><div><h2>Options</h2><p>Changes are saved straight away</p></div></header>' +
      '<div class="scroller" id="opt-scroll"><div class="opt-grid">' + cards + '</div>' +
      '<div class="opt-actions">' +
      '<button class="wide-btn gz" data-cat="sys" data-act="connection">' + icon('link') + '<span>Connection</span></button>' +
      '<button class="wide-btn gz" data-cat="set" data-act="guide">' + icon('book') + '<span>Setup guide</span></button>' +
      '<button class="wide-btn gz" data-cat="nav" data-act="win-max">' + icon('display') + '<span>Full screen on / off</span></button>' +
      '<button class="wide-btn gz" data-cat="danger" data-act="win-close">' + icon('close') + '<span>Close GazeCast</span></button>' +
      '</div></div></div>';
  }
  function renderOptionValues() {
    OPTIONS.forEach((o) => {
      const v = cfg.ui[o.k];
      const el = $('#options [data-k="' + o.k + '"]');
      if (!el) return;
      if (o.type === 'toggle') el.classList.toggle('on', !!v);
      else if (o.type === 'step') $('output', el).textContent = o.fmt(v);
      else $$('[data-v]', el).forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
    });
  }
  function optionChanged(k) {
    if (k === 'navMode') ui.navMode = cfg.ui.navMode;
    if (k === 'audio') toast(cfg.ui.audio ? 'Phone sound will play here' : 'Phone sound stays on the phone', 'ok');
  }

  // ------------------------------------------------------------ on-screen keyboard
  const ROWS = {
    abc: ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm,.'],
    sym: ['1234567890', '@#£$%&*()-', '_+=/:;!\'"', '€~\\|<>[]?'],
  };
  function buildKeyboard() {
    const rows = ui.kbSym ? ROWS.sym : ROWS.abc;
    const k = (ch) => '<button class="key gz" data-cat="nav" data-act="kb" data-k="' + esc(ch) + '">' + esc(ui.kbShift && !ui.kbSym ? ch.toUpperCase() : ch) + '</button>';
    const sp = (act, ic, label, cls, cat, rep) => '<button class="key gz ' + (cls || '') + '" data-cat="' + (cat || 'sys') + '" data-act="' + act + '"' + (rep ? ' data-repeat' : '') + '>' + (ic ? icon(ic) : '') + (label ? '<span>' + label + '</span>' : '') + '</button>';
    $('#keyboard').innerHTML =
      '<div class="kb-echo"><span class="kb-target">' + icon(ui.kbTarget === 'search' ? 'search' : 'phone') + (ui.kbTarget === 'search' ? 'Searching apps' : 'Typing on the phone') + '</span><span id="kb-echo"></span></div>' +
      '<div class="kb-row">' + rows[0].split('').map(k).join('') + '</div>' +
      '<div class="kb-row">' + rows[1].split('').map(k).join('') + '</div>' +
      '<div class="kb-row">' + rows[2].split('').map(k).join('') + sp('kb-back', 'backspace', '', '', 'danger', true) + '</div>' +
      '<div class="kb-row">' + sp('kb-shift', 'shift', '', ui.kbShift ? 'on' : '', 'gaze') + rows[3].split('').map(k).join('') + '</div>' +
      '<div class="kb-row">' + sp('kb-sym', '', ui.kbSym ? 'abc' : '#+=', '', 'gaze') + sp('kb-left', 'chevleft', '', '', 'sys', true) +
      sp('kb-space', '', 'space', 'w3', 'nav') + sp('kb-right', 'chevright', '', '', 'sys', true) + k('?') + sp('kb-enter', 'enter', 'Enter', 'w2', 'apps') + sp('kb-close', 'chevdown', 'Hide', '', 'danger') + '</div>';
    $('#kb-echo').textContent = ui.kbEcho;
  }
  function kbShow(target) {
    ui.kbTarget = target; ui.kbShift = false; ui.kbSym = false; ui.kbEcho = '';
    buildKeyboard();
    const el = $('#keyboard');
    if (target === 'search') { el.inert = false; el.classList.add('open', 'over'); document.body.classList.add('kb-over'); gaze.hold(450); }
    else { el.classList.remove('over'); openSheet('keyboard'); }
  }
  function kbHide() {
    const el = $('#keyboard');
    if (ui.kbTarget === 'search') { el.classList.remove('open', 'over'); el.inert = true; document.body.classList.remove('kb-over'); ui.kbTarget = null; }
    else if (ui.sheet === 'keyboard') closeSheet();
  }
  function kbType(ch) {
    if (ui.kbTarget === 'search') {
      ui.query += ch; $('#app-search').value = ui.query; renderApps();
    } else fireCmd('text', { text: ch });
    ui.kbEcho = (ui.kbEcho + ch).slice(-48);
    $('#kb-echo').textContent = ui.kbEcho;
    if (ui.kbShift) { ui.kbShift = false; buildKeyboardSoft(); }
  }
  // Re-label keys without replacing the elements (keeps the dwell state intact).
  function buildKeyboardSoft() {
    $$('#keyboard [data-act="kb"]').forEach((b) => { const c = b.dataset.k; b.textContent = ui.kbShift && !ui.kbSym ? c.toUpperCase() : c; });
    const s = $('#keyboard [data-act="kb-shift"]'); if (s) s.classList.toggle('on', ui.kbShift);
  }
  function kbSpecial(what) {
    const search = ui.kbTarget === 'search';
    if (what === 'back') {
      if (search) { ui.query = ui.query.slice(0, -1); $('#app-search').value = ui.query; renderApps(); } else key(67, 'DEL');
      ui.kbEcho = ui.kbEcho.slice(0, -1); $('#kb-echo').textContent = ui.kbEcho;
    } else if (what === 'enter') { if (search) kbHide(); else key(66, 'ENTER'); }
    else if (what === 'left') { if (!search) key(21, 'DPAD_LEFT'); }
    else if (what === 'right') { if (!search) key(22, 'DPAD_RIGHT'); }
  }

  // Real keyboard -> phone
  let typeBuf = '', typeTimer = 0;
  const KEYMAP = { Enter: 66, Backspace: 67, Delete: 112, Tab: 61, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Home: 122, End: 123, PageUp: 92, PageDown: 93 };
  function initKeys() {
    document.addEventListener('keydown', (e) => {
      player.unlockAudio();
      if (ui.screen === 'connect') { connectKey(e); return; }
      if (e.key === 'Escape') {
        if ($('#confirm').classList.contains('open')) return;
        if (ui.kbTarget === 'search') kbHide(); else if (ui.sheet) closeSheet(); else if (!gaze.paused && state.active) key(4, 'BACK');
        e.preventDefault(); return;
      }
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (ui.screen !== 'main' || gaze.paused || !state.active || (ui.sheet && ui.sheet !== 'keyboard')) return;
      if (e.ctrlKey && e.key.toLowerCase() === 'v') {
        if (navigator.clipboard && navigator.clipboard.readText) navigator.clipboard.readText().then((t) => { if (t) fireCmd('text', { text: t }); }).catch(() => {});
        e.preventDefault(); return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (KEYMAP[e.key]) { key(KEYMAP[e.key], e.key); e.preventDefault(); return; }
      if (e.key.length === 1) {
        typeBuf += e.key;
        clearTimeout(typeTimer);
        typeTimer = setTimeout(() => { const t = typeBuf; typeBuf = ''; fireCmd('text', { text: t }); }, 40);
        e.preventDefault();
      }
    });
  }

  // ============================================================ actions
  const ACT = {
    up: () => nav('up'), down: () => nav('down'), left: () => nav('left'), right: () => nav('right'),
    ok: () => (ui.zoomMode ? zoomStep(1) : key(23, 'DPAD_CENTER')),
    navmode: () => {
      if (ui.zoomMode) { zoomStep(-1); return; }
      ui.navMode = ui.navMode === 'swipe' ? 'dpad' : 'swipe';
      updateDynamic();
      toast(ui.navMode === 'dpad' ? 'D-pad mode: arrows move the highlight' : 'Swipe mode: arrows scroll and change pages');
    },
    home: () => key(3, 'HOME'), back: () => key(4, 'BACK'), recents: () => key(187, 'APP_SWITCH'),
    notifications: () => fireCmd('panel', { which: 'notifications' }),
    quick: () => fireCmd('panel', { which: 'settings' }),
    'quick-close': () => { closeSheet(); fireCmd('panel', { which: 'settings' }); },
    'notif-close': () => { closeSheet(); fireCmd('panel', { which: 'notifications' }); },
    volup: () => key(24, 'VOLUME_UP'), voldown: () => key(25, 'VOLUME_DOWN'),
    power: () => key(26, 'POWER'), wake: () => key(224, 'WAKEUP'),
    mute: () => {
      player.unlockAudio();
      if (state.stream && state.stream.audio === 'unavailable') { toast('Sound is not available in this mode'); return; }
      saveUi({ muted: !cfg.ui.muted });
      toast(cfg.ui.muted ? 'Sound muted on this computer' : 'Sound on');
    },
    pause: () => { gaze.setPaused(!gaze.paused); if (gaze.paused) { closeSheet(); dockOpen(false); } updateDynamic(); },
    zoom: () => { ui.zoomMode = !ui.zoomMode; if (ui.zoomMode && ui.zoom.z === 1) zoomStep(1); updateDynamic(); },
    apps: openDrawer,
    shortcuts: () => { updateRotateTile(); openSheet('shortcuts'); },
    keyboard: () => (ui.sheet === 'keyboard' ? closeSheet() : kbShow('phone')),
    options: () => { openSheet('options'); renderOptionValues(); $('#opt-scroll').scrollTop = 0; },
    connection: () => { closeSheet(); ui.manual = true; setView('home'); show('connect'); },
    guide: () => { closeSheet(); ui.manual = true; ui.guideStep = 0; setView('guide'); show('connect'); },
    'close-sheet': () => closeSheet(),
    'scroll-up': (el) => scrollPage(el, -1), 'scroll-down': (el) => scrollPage(el, 1),
    app: launchApp,
    'app-kb': () => (ui.kbTarget === 'search' ? kbHide() : kbShow('search')),
    'fav-edit': () => { ui.editFav = !ui.editFav; renderApps(); if (ui.editFav) toast('Choose apps to pin. Press Done when finished.'); },
    'apps-refresh': () => loadApps(true),
    'search-clear': () => { ui.query = ''; $('#app-search').value = ''; renderApps(); },
    intent: (el) => runIntent(el.dataset.name),
    rotate: () => {
      const mode = cfg.ui.rotation === 'auto' ? 'landscape' : 'auto';
      cfg.ui.rotation = mode; updateRotateTile();
      fireCmd('rotation', { mode });
      toast(mode === 'auto' ? 'Auto-rotate on: the phone turns with the app' : 'Locked to landscape', 'ok');
    },
    'opt-toggle': (el) => { const k = el.dataset.k; saveUi({ [k]: !cfg.ui[k] }); optionChanged(k); },
    'opt-step': (el) => {
      const o = OPTIONS.find((x) => x.k === el.dataset.k);
      saveUi({ [o.k]: clamp((Number(cfg.ui[o.k]) || o.min) + Number(el.dataset.d) * o.step, o.min, o.max) });
    },
    'opt-seg': (el) => { saveUi({ [el.dataset.k]: el.dataset.v }); optionChanged(el.dataset.k); },
    'win-min': winMinimise, 'win-max': winToggleMax, 'win-close': winClose, reopen: winReopen,
    kb: (el) => kbType(ui.kbShift && !ui.kbSym ? el.dataset.k.toUpperCase() : el.dataset.k),
    'kb-space': () => kbType(' '),
    'kb-back': () => kbSpecial('back'), 'kb-enter': () => kbSpecial('enter'),
    'kb-left': () => kbSpecial('left'), 'kb-right': () => kbSpecial('right'),
    'kb-shift': () => { ui.kbShift = !ui.kbShift; buildKeyboardSoft(); },
    'kb-sym': () => { ui.kbSym = !ui.kbSym; buildKeyboard(); gaze.hold(250); },
    'kb-close': () => kbHide(),
    retry: () => { fireCmd('restartStream'); toast('Starting the picture again'); },
    // connection screen
    view: (el) => setView(el.dataset.view),
    'to-main': () => { ui.manual = false; show('main'); },
    disconnect: () => { ui.stopped = true; fireCmd('disconnect'); },
    resume: () => { ui.stopped = false; renderHero(); fireCmd('resume'); toast('Looking for the phone again'); },
    'saved-connect': (el) => busy(el, cmd('connect', { host: el.dataset.host, port: Number(el.dataset.port) })),
    'saved-forget': (el) => fireCmd('forget', { host: el.dataset.host }),
    field: (el) => { ui.form.active = el.dataset.field; renderForm(); },
    num: (el) => formKey(el.dataset.n),
    'wifi-mode': (el) => { ui.wifiMode = el.dataset.mode; ui.form.active = ui.form.host ? (ui.form.port ? (ui.wifiMode === 'pair' ? 'code' : 'port') : 'port') : 'host'; renderConnect(); },
    'wifi-go': (el) => submitWifi(el),
    tcpip: (el) => busy(el, cmd('tcpip').then((d) => toast('Wireless mode is ready at ' + d.host + '. You can unplug the cable.', 'ok'))),
    'hotspot-go': (el) => busy(el, cmd('hotspotConnect')),
    'guide-next': () => { ui.guideStep++; if (ui.guideStep >= GUIDE.length) { saveUi({ firstRunDone: true }); setView('home'); } else renderConnect(); },
    'guide-back': () => { if (ui.guideStep === 0) setView('home'); else { ui.guideStep--; renderConnect(); } },
    'guide-skip': () => { saveUi({ firstRunDone: true }); setView('home'); },
  };
  function scrollPage(el, dir) {
    const s = $(el.dataset.target);
    if (s) s.scrollBy({ top: dir * s.clientHeight * 0.7, behavior: 'smooth' });
  }
  function busy(el, promise) {
    el.classList.add('busy');
    return promise.catch(() => {}).then(() => el.classList.remove('busy'));
  }
  function initActions() {
    document.addEventListener('click', (e) => {
      const el = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!el || el.getAttribute('aria-disabled') === 'true') return;
      const fn = ACT[el.dataset.act];
      if (fn) fn(el);
    });
    $('#scrim').addEventListener('click', () => closeSheet());
  }

  // ============================================================ connection screen
  const GUIDE = [
    { i: 'phone', t: 'Open Settings on the phone', p: 'On the Pixel, swipe up and open <b>Settings</b>. Scroll to the very bottom and tap <b>About phone</b>.' },
    { i: 'sparkle', t: 'Switch on Developer options', p: 'Scroll to the bottom and tap <b>Build number</b> seven times, quickly. Enter the phone PIN if it asks. A small message says <b>You are now a developer</b>.' },
    { i: 'tune', t: 'Find Developer options', p: 'Press back once. Open <b>System</b>, then <b>Developer options</b>. Make sure the switch at the top is on.' },
    { i: 'usb', t: 'Turn on USB debugging', p: 'In Developer options, scroll down to <b>USB debugging</b> and switch it on. Tap <b>OK</b>. This lets the phone be controlled through the cable.' },
    { i: 'wifi', t: 'Turn on Wireless debugging', p: 'Just below, switch on <b>Wireless debugging</b> (the phone must be on Wi-Fi). Tick <b>Always allow on this network</b> and tap <b>Allow</b>. This lets it work without the cable.' },
    { i: 'check', t: 'All set on the phone', p: 'That was the hard part and it only has to be done once. Next, choose how to connect: home Wi-Fi, the phone’s hotspot, or the USB cable.' },
  ];

  function show(screen) {
    if (ui.screen === screen) return;
    ui.screen = screen;
    document.body.dataset.screen = screen;
    $('#main').inert = screen !== 'main';
    $('#connect').inert = screen !== 'connect';
    gaze.hold(600);
    if (screen === 'connect') { closeSheet(); renderConnect(); renderHero(); }
    if (screen === 'main') layout();
  }
  function setView(v) {
    ui.view = v;
    if (v === 'wifi') prefill();
    renderConnect();
    gaze.hold(450);
  }
  function prefill() {
    const f = ui.form;
    const pairing = (state.nearby || []).find((n) => n.kind === 'pairing');
    const conn = (state.nearby || []).find((n) => n.kind === 'connect');
    const hit = ui.wifiMode === 'pair' ? pairing : conn;
    if (hit && !f.host) { f.host = hit.host; f.port = String(hit.port); f.active = ui.wifiMode === 'pair' ? 'code' : 'port'; }
    else if (!f.host) f.active = 'host';
  }

  const wide = (act, ic, label, cat, extra) => '<button class="wide-btn gz ' + ((extra && extra.cls) || '') + '" data-cat="' + cat + '" data-act="' + act + '" ' + ((extra && extra.attr) || '') + '>' + icon(ic) + '<span>' + label + '</span></button>';
  const backBtn = () => wide('view', 'chevleft', 'Back', 'sys', { attr: 'data-view="home"' });
  const step = (n, html) => '<li><span class="n">' + n + '</span><div>' + html + '</div></li>';

  function renderConnect() {
    const p = $('#connect-panel');
    let h = '';
    if (ui.view === 'home') {
      h = '<header class="panel-head"><h2>How would you like to connect?</h2><p>Pick one. GazeCast remembers the phone and reconnects by itself next time.</p></header>' +
        '<div class="methods">' +
        '<button class="method gz" data-cat="nav" data-act="view" data-view="wifi"><span class="glyph">' + icon('wifi') + '</span><b>Home Wi-Fi</b><small>Phone and computer on the same Wi-Fi. No cable.</small></button>' +
        '<button class="method gz" data-cat="apps" data-act="view" data-view="hotspot"><span class="glyph">' + icon('hotspot') + '</span><b>Phone hotspot</b><small>Away from home. The computer joins the phone’s hotspot.</small></button>' +
        '<button class="method gz" data-cat="sys" data-act="view" data-view="usb"><span class="glyph">' + icon('usb') + '</span><b>USB cable</b><small>Simplest and most reliable. Just plug it in.</small></button>' +
        '</div><div id="saved-list"></div>' +
        '<div class="panel-actions">' + wide('guide-open', 'book', 'First time? Setup guide', 'set', { cls: cfg.ui.firstRunDone ? '' : 'primary' }) + '<span id="home-extra"></span></div>';
    } else if (ui.view === 'wifi') {
      const pair = ui.wifiMode === 'pair';
      h = '<header class="panel-head"><h2>Connect over home Wi-Fi</h2><div class="tabs">' +
        '<button class="mini gz' + (pair ? ' on' : '') + '" data-cat="nav" data-act="wifi-mode" data-mode="pair">First time: pair</button>' +
        '<button class="mini gz' + (!pair ? ' on' : '') + '" data-cat="nav" data-act="wifi-mode" data-mode="connect">Already paired</button></div></header>' +
        '<div class="split"><ol class="steps">' +
        step(1, 'On the phone open <b>Settings › System › Developer options › Wireless debugging</b> and switch it on.') +
        (pair ? step(2, 'Tap <b>Pair device with pairing code</b>. The phone shows a six-digit code and an address with a port.') +
                step(3, 'Type the address, the port (the number after the colon) and the code here. Then press Pair.')
              : step(2, 'Look at <b>IP address &amp; Port</b> at the top of that screen, for example 192.168.1.23:41235.') +
                step(3, 'Type the address and the port here, then press Connect.')) +
        '<li class="found" id="nearby-hint"></li></ol>' +
        '<div class="form"><div id="fields"></div><div class="numpad">' +
        '1234567890.'.split('').map((n) => '<button class="key gz" data-cat="nav" data-act="num" data-n="' + n + '">' + n + '</button>').join('') +
        '<button class="key gz" data-cat="danger" data-act="num" data-n="back" data-repeat>' + icon('backspace') + '</button></div></div></div>' +
        '<div class="panel-actions">' + backBtn() + wide('wifi-go', pair ? 'link' : 'wifi', pair ? 'Pair and connect' : 'Connect', 'nav', { cls: 'primary' }) + '</div>';
    } else if (ui.view === 'hotspot') {
      h = '<header class="panel-head"><h2>Connect through the phone’s hotspot</h2><p>Wireless debugging usually switches off while the phone is a hotspot, so GazeCast uses a one-time cable step instead.</p></header>' +
        '<ol class="steps roomy">' +
        step(1, '<b>Once only:</b> plug the phone into this computer with the USB cable, wait until GazeCast shows it, then press <b>Prepare phone</b>.<div class="inline-act">' + wide('tcpip', 'usb', 'Prepare phone', 'apps') + '<span class="status-line" id="usb-status"></span></div>') +
        step(2, 'Unplug the cable. On the phone switch on <b>Hotspot</b>. On this computer, join the phone’s hotspot from the Wi-Fi list.') +
        step(3, 'Press <b>Connect over hotspot</b>. Next time GazeCast does this by itself.<div class="inline-act">' + wide('hotspot-go', 'hotspot', 'Connect over hotspot', 'apps', { cls: 'primary' }) + '</div>') +
        '</ol><p class="note">' + icon('info') + 'If the phone is restarted, do step 1 once more.</p>' +
        '<div class="panel-actions">' + backBtn() + '</div>';
    } else if (ui.view === 'usb') {
      h = '<header class="panel-head"><h2>Connect with the USB cable</h2><p>GazeCast notices the phone by itself. There is nothing to type.</p></header>' +
        '<ol class="steps roomy">' +
        step(1, 'Plug the phone into this computer with a USB cable that can carry data.') +
        step(2, 'Unlock the phone. When it asks <b>Allow USB debugging?</b> tick <b>Always allow from this computer</b> and tap <b>Allow</b>.') +
        step(3, 'That is all. The phone appears here within a few seconds.<div class="inline-act"><span class="status-line" id="usb-status"></span></div>') +
        '</ol><p class="note">' + icon('info') + 'Nothing happening? USB debugging may be off. Open the setup guide from the first page.</p>' +
        '<div class="panel-actions">' + backBtn() + wide('tcpip', 'wifi', 'Also set up cable-free use', 'nav') + '</div>';
    } else if (ui.view === 'guide') {
      const s = GUIDE[ui.guideStep], last = ui.guideStep === GUIDE.length - 1;
      h = '<header class="panel-head"><h2>Getting the phone ready</h2><p>A one-time job on the Pixel. Take it one step at a time.</p></header>' +
        '<div class="guide" data-step="' + ui.guideStep + '"><div class="guide-art" data-cat="set">' + icon(s.i) + '</div>' +
        '<div class="guide-text"><span class="kicker">Step ' + (ui.guideStep + 1) + ' of ' + GUIDE.length + '</span><h3>' + s.t + '</h3><p>' + s.p + '</p></div></div>' +
        '<div class="dots">' + GUIDE.map((_, i) => '<i class="' + (i === ui.guideStep ? 'on' : i < ui.guideStep ? 'done' : '') + '"></i>').join('') + '</div>' +
        '<div class="panel-actions">' + wide('guide-back', 'chevleft', 'Back', 'sys') + (last ? '' : wide('guide-skip', 'close', 'Skip guide', 'gaze')) +
        wide('guide-next', last ? 'check' : 'chevright', last ? 'Choose how to connect' : 'Next step', 'set', { cls: 'primary' }) + '</div>';
    }
    p.dataset.view = ui.view;
    p.innerHTML = h;
    p.classList.remove('swap'); void p.offsetWidth; p.classList.add('swap');
    if (ui.view === 'wifi') renderForm();
    updateConnect();
  }
  ACT['guide-open'] = () => { ui.guideStep = 0; setView('guide'); };

  function renderForm() {
    const f = ui.form, pair = ui.wifiMode === 'pair';
    const field = (k, label, ph, cls) => '<button class="field gz ' + cls + (f.active === k ? ' active' : '') + '" data-cat="nav" data-act="field" data-field="' + k + '"><small>' + label + '</small><b class="' + (f[k] ? '' : 'ph') + '">' + esc(f[k] || ph) + '</b></button>';
    $('#fields').innerHTML = field('host', 'Phone address', '192.168.1.23', 'grow') + field('port', pair ? 'Pairing port' : 'Port', pair ? '37251' : '41235', '') + (pair ? field('code', 'Pairing code', '123456', 'full') : '');
  }
  function formKey(n) {
    const f = ui.form, k = f.active;
    const max = k === 'host' ? 15 : k === 'port' ? 5 : 6;
    if (n === 'back') f[k] = f[k].slice(0, -1);
    else if (n === '.' && k !== 'host') return;
    else if (f[k].length < max) f[k] += n;
    renderForm();
  }
  function connectKey(e) {
    if (ui.view !== 'wifi') return;
    if (/^[0-9.]$/.test(e.key)) formKey(e.key);
    else if (e.key === 'Backspace') formKey('back');
    else if (e.key === 'Tab' || e.key === ':') { const order = ui.wifiMode === 'pair' ? ['host', 'port', 'code'] : ['host', 'port']; ui.form.active = order[(order.indexOf(ui.form.active) + 1) % order.length]; renderForm(); e.preventDefault(); }
    else if (e.key === 'Enter') { const b = $('[data-act="wifi-go"]'); if (b) submitWifi(b); }
  }
  function submitWifi(el) {
    const f = ui.form;
    if (ui.wifiMode === 'pair') {
      busy(el, cmd('pair', { host: f.host, port: Number(f.port), code: f.code }).then((d) => {
        f.code = '';
        if (!d.connected) {
          ui.wifiMode = 'connect'; f.port = ''; f.active = 'port';
          renderConnect();
          toast('Paired. Now type the port shown under “IP address & Port” on the phone.', 'ok');
        }
      }));
    } else busy(el, cmd('connect', { host: f.host, port: Number(f.port) }));
  }

  function linkName(a) { return a.transport === 'usb' ? 'USB cable' : a.viaHotspot ? 'Phone hotspot' : 'Wi-Fi'; }

  function renderHero() {
    const rings = $('#rings'), title = $('#hero-title'), sub = $('#hero-sub'), acts = $('#hero-actions');
    const a = state.active;
    let mode = 'search', t = 'Looking for your phone', s = 'Plug in the cable, or choose a way to connect.', ic = 'phone', buttons = '';
    if (!net.online) { mode = 'error'; t = 'GazeCast has stopped'; s = 'Start it again with start.bat.'; ic = 'alert'; }
    else if (state.phase === 'no-adb') { mode = 'error'; t = 'GazeCast is missing its tools'; s = 'Run setup.ps1 once (see the README), then start GazeCast again.'; ic = 'alert'; }
    else if (a) {
      mode = 'ok'; t = 'Connected to ' + a.model; ic = 'phone';
      s = linkName(a) + (a.android ? ' · Android ' + a.android : '') + (a.battery != null ? ' · battery ' + a.battery + '%' : '');
      buttons = wide('to-main', 'chevright', 'Show the phone', 'sys', { cls: 'primary' }) + wide('disconnect', 'close', 'Disconnect', 'danger');
    } else if (state.phase === 'unauthorized') { mode = 'wait'; t = 'Phone found. Tap Allow on it'; s = 'Unlock the phone and tap Allow on the “Allow USB debugging?” message.'; ic = 'lock'; }
    else {
      if (ui.stopped) s = 'Disconnected. Press Search again, or choose a way to connect.';
      buttons = wide('resume', 'refresh', 'Search again', 'nav', ui.stopped ? { cls: 'primary' } : null);
    }
    if (rings.dataset.mode !== mode) rings.dataset.mode = mode;
    $('#hero-icon').innerHTML = icon(ic);
    title.textContent = t; sub.textContent = s;
    if (acts.dataset.html !== buttons) { acts.dataset.html = buttons; acts.innerHTML = buttons; }
    if (state.demo && !$('.demo-tag')) { const d = document.createElement('div'); d.className = 'demo-tag'; d.textContent = 'Demo mode · no phone needed'; $('#connect .hero').appendChild(d); }
  }

  function updateConnect() {
    if (ui.screen !== 'connect') return;
    const saved = $('#saved-list');
    if (saved) {
      const list = state.saved || [];
      const html = list.length ? '<h3 class="grid-title">' + icon('phone') + 'Saved phones</h3>' + list.slice(0, 2).map((d) =>
        '<div class="saved"><span class="saved-name"><b>' + esc(d.name || 'Phone') + '</b><small>' + esc(d.host + ':' + d.port) + (d.hotspot ? ' · hotspot' : '') + '</small></span>' +
        wide('saved-connect', 'link', 'Connect', 'sys', { attr: 'data-host="' + esc(d.host) + '" data-port="' + Number(d.port) + '"' }) +
        wide('saved-forget', 'trash', 'Forget', 'danger', { attr: 'data-host="' + esc(d.host) + '"' }) + '</div>').join('') : '';
      if (saved.dataset.html !== html) { saved.dataset.html = html; saved.innerHTML = html; }
    }
    const hint = $('#nearby-hint');
    if (hint) {
      const want = ui.wifiMode === 'pair' ? 'pairing' : 'connect';
      const hit = (state.nearby || []).find((n) => n.kind === want);
      hint.innerHTML = hit ? icon('sparkle') + '<div>Found a phone nearby at <b>' + esc(hit.host + ':' + hit.port) + '</b>. The address is filled in for you.</div>' : '';
      hint.classList.toggle('show', !!hit);
      if (hit && !ui.form.host) { prefill(); renderForm(); }
    }
    const usb = $('#usb-status');
    if (usb) {
      const a = state.active;
      const txt = a ? 'Phone connected: ' + a.model + ' (' + linkName(a) + ')' : state.phase === 'unauthorized' ? 'Phone found. Tap Allow on the phone screen.' : 'Waiting for the phone…';
      usb.className = 'status-line ' + (a ? 'ok' : state.phase === 'unauthorized' ? 'wait' : 'search');
      usb.innerHTML = '<i></i>' + esc(txt);
    }
  }

  // ============================================================ state from the bridge
  let lostTimer = 0, okTimer = 0;
  function onState(s) {
    const before = state;
    state = s;
    const connected = !!s.active;
    const was = !!before.active;

    // top bar
    const chip = $('#status-chip');
    const st = s.stream || {};
    chip.dataset.tone = connected ? (st.status === 'live' ? 'ok' : 'wait') : 'off';
    $('.txt', chip).textContent = connected ? s.active.model + ' · ' + linkName(s.active) + (s.active.battery != null ? ' · ' + s.active.battery + '%' : '') : 'No phone';
    const link = $('#link-chip');
    link.hidden = !(connected && s.active.viaHotspot);
    link.innerHTML = icon('hotspot') + '<span>Linked through the phone hotspot</span>';

    // stream lifecycle
    if (st.status === 'starting' && (before.stream || {}).status !== 'starting') player.reset();
    if (s.demo) { if (connected && !demo.running) demo.start(); else if (!connected && demo.running) { demo.stop(); player.reset(); } }
    if (!connected && was) player.reset();
    renderPhoneState();
    updateDynamic();

    // screens
    if (!ui.booted) return;
    if (connected && !was) {
      clearTimeout(lostTimer);
      ui.stopped = false;
      if (!cfg.ui.firstRunDone) saveUi({ firstRunDone: true });
      if (ui.screen === 'connect') {
        gaze.blip('soft');
        $('#rings').classList.add('celebrate');
        clearTimeout(okTimer);
        okTimer = setTimeout(() => { $('#rings').classList.remove('celebrate'); if (state.active) { ui.manual = false; show('main'); } }, 1900);
      }
      loadApps(false);
    }
    if (!connected && was) {
      ui.zoomMode = false; ui.zoom = { z: 1, cx: 0.5, cy: 0.5 };
      clearTimeout(lostTimer);
      lostTimer = setTimeout(() => { if (!state.active) { setView('home'); show('connect'); } }, ui.screen === 'main' ? 3500 : 0);
    }
    if (ui.screen === 'connect') { renderHero(); updateConnect(); }
  }

  function renderPhoneState() {
    const el = $('#phone-state'), st = state.stream || {};
    let html = '';
    if (!state.active) html = stateCard('link', 'Reconnecting to your phone', 'Hold on, GazeCast is looking for it again.', false, true);
    else if (!player.supported && st.mode === 'scrcpy') html = stateCard('alert', 'This browser cannot show live video', 'Please open GazeCast in Google Chrome or Microsoft Edge.', false);
    else if (st.status === 'starting' || (st.status === 'live' && !player.live)) html = stateCard('phone', 'Starting the phone picture', st.note || 'This takes a few seconds.', false, true);
    else if (st.status === 'idle' || st.status === 'error') html = stateCard('alert', 'The picture has stopped', st.note || 'Press Try again to restart it.', true);
    if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
    el.classList.toggle('show', !!html);
    const sc = $('#stream-chip');
    let txt = '';
    if (state.active && player.live) {
      txt = st.mode === 'demo' ? 'Demo · ' + (demo.mode === 'loopback' ? 'H.264 ' : '') + player.fps + ' fps' : st.mode === 'screencap' ? 'Snapshot mode' : 'Live · ' + player.fps + ' fps';
    }
    sc.textContent = txt; sc.hidden = !txt;
    sc.classList.toggle('warn', st.mode === 'screencap');
  }
  function stateCard(ic, title, text, retry, loading) {
    return '<div class="state-card' + (loading ? ' loading' : '') + '"><div class="state-icon">' + icon(ic) + '</div><h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' +
      (retry ? '<button class="wide-btn gz primary" data-cat="sys" data-act="retry">' + icon('refresh') + '<span>Try again</span></button>' : '') + '</div>';
  }

  // ============================================================ boot
  function boot() {
    buildMain(); buildDrawer(); buildShortcuts(); buildOptions();
    player.attach($('#screen'));
    player.onSize = () => layout();
    player.onFirstFrame = () => renderPhoneState();
    player.onError = () => { if (state.demo) demo.mode = 'direct'; else net.fire('refresh'); };
    gaze.init(); initDock(); initSurface(); initKeys(); initActions(); initWindowButtons();
    window.addEventListener('resize', layout);
    document.addEventListener('pointerdown', () => player.unlockAudio(), true);
    setInterval(() => {
      $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      renderPhoneState();
      if (player.audioBlocked && !ui.audioHint && !cfg.ui.muted) { ui.audioHint = true; toast('Click anywhere once with the mouse to switch on phone sound'); }
    }, 1000);

    net.on('state', (m) => onState(m.state));
    net.on('config', (m) => { cfg = m.config; applyConfig(); updateRotateTile(); });
    net.on('apps', (m) => { ui.apps = m.apps || []; ui.appsLoading = !!m.loading; demo.setApps(ui.apps); if (ui.sheet === 'drawer') renderApps(); });
    net.on('demo', (m) => demo.handle(m));
    net.on('binary', (buf) => player.feed(buf));
    net.on('close', () => { $('#offline').classList.add('open'); $('#offline').inert = false; });
    net.on('open', () => {
      $('#offline').classList.remove('open'); $('#offline').inert = true;
      net.send('hello').then((d) => {
        cfg = d.config;
        if (!ui.booted) ui.navMode = cfg.ui.navMode === 'dpad' ? 'dpad' : 'swipe';
        applyConfig();
        const first = !ui.booted;
        ui.booted = true;
        onState(d.state);
        if (first) {
          if (d.state.active) { show('main'); loadApps(false); }
          else { if (!cfg.ui.firstRunDone) { ui.view = 'guide'; ui.guideStep = 0; } show('connect'); }
        }
      });
    });
    layout();
    net.connect();
  }

  GC.app = { ui, layout, state: () => state, cfg: () => cfg };
  boot();
})();
