'use strict';
// Gaze / dwell engine.
// Any element with class "gz" is a dwell target: resting the pointer on it fills
// a ring and then activates it ONCE. Real clicks (mouse, touch, Tobii click) work
// too and never double-fire with the dwell.
//
// One look = one press. After a press the ring closes and stays closed while the
// pointer rests there. The target re-arms only when the pointer has clearly left
// it: more than REARM_PX outside it, or more than EDGE_PX outside it for REARM_MS.
// A small tremor of the gaze, even one that briefly crosses the edge of the
// button, does not re-arm it, and neither does wandering around inside it.
// The same guard covers anything that appears under a resting gaze (a new sheet,
// a rebuilt key): it cannot start a dwell until the pointer has moved away.
//
//   data-repeat      may auto-repeat, but ONLY when gaze.repeat is switched on
//                    (Options > "Hold to repeat", off by default)
//   data-dwell="1.6" needs a longer look (used by the Resume button)
//   class gz-unlock  stays active while gaze is paused
(function () {
  const gaze = {
    enabled: true, dwellMs: 800, videoDwell: true, sounds: true, repeat: false,
    paused: false, synthetic: false,
  };

  const REARM_PX = 40;      // movement that counts as "looked away"
  const REARM_MS = 350;     // time off the target that counts as "left it"
  const EDGE_PX = 10;       // straying less than this past the edge is still "on it"
  const CLICK_GUARD_MS = 1500; // a real click this soon after a dwell press on the same spot is the same press

  let target = null, timer = 0, grace = 0, holdUntil = 0, ringEl = null, ringAnim = null;
  let px = 0, py = 0;       // last pointer position
  // The last press: { el, x, y, byDwell, at, offSince }. null = everything is armed.
  let fired = null;

  function eligible(node) {
    if (!node || !node.closest) return null;
    const t = node.closest('.gz');
    if (!t || t.disabled || t.getAttribute('aria-disabled') === 'true') return null;
    if (gaze.paused && !t.classList.contains('gz-unlock')) return null;
    if (t.closest('[inert]')) return null;
    return t;
  }

  function showRing(t, duration, delay) {
    hideRing();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ring');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('pathLength', '100');
    const radius = parseFloat(getComputedStyle(t).borderTopLeftRadius) || 20;
    rect.style.rx = Math.max(4, Math.min(radius, t.offsetHeight / 2) - 3) + 'px';
    svg.appendChild(rect);
    t.appendChild(svg);
    t.classList.add('gz-hot');
    ringEl = svg;
    ringAnim = rect.animate([{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }], { duration, delay, easing: 'linear', fill: 'forwards' });
  }
  function hideRing(done) {
    if (!ringEl) return;
    const el = ringEl; ringEl = null;
    if (ringAnim) { try { ringAnim.cancel(); } catch (e) { /* ignore */ } ringAnim = null; }
    if (el.parentNode) el.parentNode.classList.remove('gz-hot');
    if (done) { el.classList.add('done'); setTimeout(() => el.remove(), 420); } else el.remove();
  }

  function cancel() {
    clearTimeout(timer); timer = 0;
    hideRing();
    target = null;
  }

  function markFired(el, byDwell) {
    fired = { el, x: px, y: py, byDwell, at: performance.now(), offSince: 0 };
  }

  // Is this target still "used up" by the last press?
  function spentAt(t, x, y) {
    if (!fired) return false;
    const now = performance.now();
    // The pointer was last seen resting off the pressed button long enough ago: re-armed.
    if (fired.offSince && now - fired.offSince >= REARM_MS) { fired = null; return false; }
    const el = fired.el;
    const fromSpot = Math.hypot(x - fired.x, y - fired.y);
    if (el.isConnected) {
      // How far outside the pressed button is the pointer? (0 = still on it)
      const r = el.getBoundingClientRect();
      const off = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
      if (off >= REARM_PX) { fired = null; return false; }           // clearly looked away
      if (off >= EDGE_PX) { if (!fired.offSince) fired.offSince = now; } // left it: counts once it lasts REARM_MS
      else fired.offSince = 0;                                        // on it, or a tremor at its edge
      if (t === el) return true;
    } else if (fromSpot >= REARM_PX) { fired = null; return false; }
    // Something else now sits where the user was looking when they pressed
    // (a sheet opened, a key was rebuilt): it must not be pressed by the same look.
    if (t && fromSpot < REARM_PX) {
      const r = t.getBoundingClientRect();
      if (fired.x >= r.left && fired.x <= r.right && fired.y >= r.top && fired.y <= r.bottom) return true;
    }
    return false;
  }

  function begin(t, repeat) {
    target = t;
    const factor = parseFloat(t.dataset.dwell) || 1;
    const duration = repeat ? Math.max(450, gaze.dwellMs * 0.8) : gaze.dwellMs * factor;
    const delay = Math.max(0, holdUntil - performance.now());
    showRing(t, duration, delay);
    timer = setTimeout(fire, duration + delay);
  }

  function fire() {
    const t = target;
    timer = 0;
    if (!t || !eligible(t) || !t.isConnected) { cancel(); return; }
    hideRing(true);
    target = null;
    markFired(t, true);
    gaze.synthetic = true;
    try { t.click(); } finally { gaze.synthetic = false; }
    // Optional hold-to-repeat, only for buttons that allow it and only when switched on.
    if (gaze.repeat && gaze.enabled && t.dataset.repeat != null && t.isConnected && eligible(t)) begin(t, true);
  }

  function update(node, x, y) {
    if (typeof x === 'number') { px = x; py = y; }
    const t = eligible(node);
    if (t && t === target) { if (grace) { clearTimeout(grace); grace = 0; } return; }
    if (!t) {
      spentAt(null, px, py);
      // Small grace period so eye-tracker jitter over a gap does not restart the ring.
      if (target && !grace) grace = setTimeout(() => { grace = 0; cancel(); }, 140);
      return;
    }
    if (grace) { clearTimeout(grace); grace = 0; }
    cancel();
    if (!gaze.enabled) return;
    if (spentAt(t, px, py)) return;
    begin(t, false);
  }

  // Freshly opened panels wait a moment before they can be dwell-activated.
  // Neither of these re-arms the last press: only moving away does.
  gaze.hold = function (ms) { holdUntil = performance.now() + (ms || 450); cancel(); };
  gaze.refresh = function () { cancel(); };

  gaze.setPaused = function (p) {
    gaze.paused = !!p;
    document.body.classList.toggle('gaze-paused', gaze.paused);
    cancel(); cancelVideo();
    gaze.hold(500);
  };

  // ------------------------------------------------------------ feedback
  let fx = null;
  gaze.blip = function (kind) {
    if (!gaze.sounds) return;
    try {
      fx = fx || new (window.AudioContext || window.webkitAudioContext)();
      if (fx.state === 'suspended') { fx.resume().catch(() => {}); if (fx.state === 'suspended') return; }
      const o = fx.createOscillator(), g = fx.createGain(), t = fx.currentTime;
      const f = kind === 'error' ? [300, 220] : kind === 'soft' ? [520, 620] : [700, 980];
      o.type = 'sine';
      o.frequency.setValueAtTime(f[0], t); o.frequency.exponentialRampToValueAtTime(f[1], t + 0.07);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g); g.connect(fx.destination); o.start(t); o.stop(t + 0.16);
    } catch (e) { /* sound is optional */ }
  };

  gaze.ripple = function (el, x, y) {
    const r = el.getBoundingClientRect();
    const s = document.createElement('span');
    s.className = 'ripple';
    const size = Math.max(r.width, r.height) * 2.2;
    s.style.width = s.style.height = size + 'px';
    s.style.left = ((x == null ? r.width / 2 : x - r.left) - size / 2) + 'px';
    s.style.top = ((y == null ? r.height / 2 : y - r.top) - size / 2) + 'px';
    el.appendChild(s);
    el.classList.remove('fired'); void el.offsetWidth; el.classList.add('fired');
    setTimeout(() => s.remove(), 650);
  };

  // ------------------------------------------------------------ dwell on the phone picture
  // Same rule: one tap per look. The spot re-arms only after the pointer has
  // moved more than REARM_PX away from where it tapped.
  let surface = null, vcb = null, anchor = null, vtimer = 0, vspent = false, vring = null;
  const RADIUS = 34;        // tremor allowed while the ring fills

  function cancelVideo() {
    clearTimeout(vtimer); vtimer = 0;
    if (vring) vring.classList.remove('on');
  }
  function videoMove(e) {
    if (!gaze.enabled || !gaze.videoDwell || gaze.paused || e.pointerType === 'touch' || e.buttons) { cancelVideo(); if (!vspent) anchor = null; return; }
    const d = anchor ? Math.hypot(e.clientX - anchor.x, e.clientY - anchor.y) : Infinity;
    if (vspent ? d <= Math.max(REARM_PX, RADIUS) : d <= RADIUS) return;
    cancelVideo();
    anchor = { x: e.clientX, y: e.clientY };
    vspent = false;
    const box = surface.getBoundingClientRect();
    const delay = Math.max(0, holdUntil - performance.now());
    vring.classList.remove('done');
    vring.style.left = (anchor.x - box.left) + 'px';
    vring.style.top = (anchor.y - box.top) + 'px';
    vring.style.setProperty('--dwell', gaze.dwellMs + 'ms');
    vring.style.setProperty('--delay', (delay + 120) + 'ms');
    void vring.offsetWidth;
    vring.classList.add('on');
    const a = anchor;
    vtimer = setTimeout(() => {
      vtimer = 0;
      vspent = true;
      a.at = performance.now(); a.byDwell = true;
      vring.classList.remove('on'); vring.classList.add('done');
      setTimeout(() => vring.classList.remove('done'), 320);
      gaze.blip('soft');
      vcb(a.x, a.y);
    }, gaze.dwellMs + delay + 120);
  }
  gaze.watchSurface = function (el, ring, cb) {
    surface = el; vring = ring; vcb = cb;
    el.addEventListener('pointermove', videoMove);
    // Leaving the picture stops a running ring, but a used-up spot stays used up
    // (a tremor across the edge must not tap again).
    el.addEventListener('pointerleave', () => { cancelVideo(); if (!vspent) anchor = null; });
    el.addEventListener('pointerdown', (e) => { cancelVideo(); if (!vspent) { anchor = { x: e.clientX, y: e.clientY, byDwell: false }; vspent = true; } });
  };
  // A real click at the spot the dwell just tapped must not tap twice.
  gaze.videoJustFired = function (x, y) {
    return vspent && vtimer === 0 && anchor && anchor.byDwell !== false && Math.hypot(x - anchor.x, y - anchor.y) < REARM_PX && performance.now() - (anchor.at || 0) < CLICK_GUARD_MS;
  };

  // ------------------------------------------------------------ wiring
  gaze.init = function () {
    document.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') update(e.target, e.clientX, e.clientY); }, true);
    document.addEventListener('pointerover', (e) => { if (e.pointerType !== 'touch') update(e.target, e.clientX, e.clientY); }, true);
    document.documentElement.addEventListener('pointerleave', () => update(null));
    window.addEventListener('blur', () => { cancel(); cancelVideo(); });
    document.addEventListener('scroll', () => { if (target) cancel(); }, true);

    // Capture phase: decide whether a click is allowed through.
    document.addEventListener('click', (e) => {
      const t = e.target.closest ? e.target.closest('.gz') : null;
      if (gaze.paused && !(t && t.classList.contains('gz-unlock'))) {
        if (!e.target.closest || !e.target.closest('.allow-paused')) { e.stopPropagation(); e.preventDefault(); }
        return;
      }
      if (!t || gaze.synthetic) return;
      // A real click that arrives just after the dwell already pressed this same
      // target (for example the eye tracker's own dwell-click): same press, swallow it.
      if (e.isTrusted && fired && fired.byDwell && fired.el === t && performance.now() - fired.at < CLICK_GUARD_MS) {
        e.stopPropagation(); e.preventDefault();
        return;
      }
      // A normal click: it is the press. Stop the running ring and do not let the
      // dwell press again while the pointer keeps resting here.
      if (e.isTrusted && typeof e.clientX === 'number' && (e.clientX || e.clientY)) { px = e.clientX; py = e.clientY; }
      if (t === target) cancel();
      markFired(t, false);
    }, true);

    // Bubble phase: visual + audible feedback for every activation.
    document.addEventListener('click', (e) => {
      const t = e.target.closest ? e.target.closest('.gz') : null;
      if (!t) return;
      gaze.ripple(t, gaze.synthetic || !e.clientX ? null : e.clientX, gaze.synthetic || !e.clientY ? null : e.clientY);
      gaze.blip();
    });
  };

  GC.gaze = gaze;
})();
