'use strict';
// Decodes the phone stream in the browser.
//   video : H.264 (Annex B) -> WebCodecs VideoDecoder -> <canvas>
//   audio : Opus            -> WebCodecs AudioDecoder -> Web Audio
//   fallback : PNG snapshots drawn straight to the canvas
(function () {
  const player = {
    canvas: null, ctx: null,
    width: 0, height: 0,
    frames: 0, fps: 0, live: false,
    muted: false, audioBlocked: false,
    onSize: null, onFirstFrame: null, onError: null,
    supported: 'VideoDecoder' in window,
  };

  let decoder = null;
  let codec = '';
  let spsKey = '';
  let lastConfig = null;
  let waitingKey = true;
  let latest = null;
  let rafQueued = false;
  let gotFrame = false;

  player.attach = function (canvas) {
    player.canvas = canvas;
    player.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    setInterval(() => { player.fps = player.frames; player.frames = 0; }, 1000);
  };

  function setSize(w, h) {
    if (w === player.width && h === player.height) return;
    player.width = w; player.height = h;
    player.canvas.width = w; player.canvas.height = h;
    if (player.onSize) player.onSize(w, h);
  }

  function present() {
    rafQueued = false;
    const f = latest; latest = null;
    if (!f) return;
    setSize(f.displayWidth, f.displayHeight);
    player.ctx.drawImage(f, 0, 0);
    f.close();
    player.frames++;
    if (!gotFrame) { gotFrame = true; player.live = true; if (player.onFirstFrame) player.onFirstFrame(); }
  }

  function queue(frame) {
    if (latest) latest.close();
    latest = frame;
    if (!rafQueued) { rafQueued = true; requestAnimationFrame(present); }
  }

  // Look for the SPS (NAL type 7) to learn profile and level -> "avc1.PPCCLL".
  function findSps(d) {
    for (let i = 0; i + 4 < d.length; i++) {
      if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1 && (d[i + 3] & 0x1f) === 7) {
        let end = d.length;
        for (let j = i + 4; j + 2 < d.length; j++) {
          if (d[j] === 0 && d[j + 1] === 0 && (d[j + 2] === 1 || (d[j + 2] === 0 && d[j + 3] === 1))) { end = j; break; }
        }
        return d.subarray(i + 3, end);
      }
    }
    return null;
  }
  const hex = (n) => n.toString(16).padStart(2, '0');

  function configure(sps) {
    codec = 'avc1.' + hex(sps[1]) + hex(sps[2]) + hex(sps[3]);
    spsKey = Array.prototype.join.call(sps, ',');
    if (decoder && decoder.state !== 'closed') { try { decoder.close(); } catch (e) { /* ignore */ } }
    decoder = new VideoDecoder({
      output: queue,
      error: (e) => {
        console.warn('Video decoder error:', e.message);
        waitingKey = true; decoder = null; spsKey = '';
        if (player.onError) player.onError(e);
      },
    });
    decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
  }

  function video(flags, pts, data) {
    if (!player.supported) return;
    if (flags === 1) { lastConfig = data.slice(); return; }
    const key = flags === 2;
    if (key) {
      let chunk = data;
      if (!findSps(data) && lastConfig) {
        chunk = new Uint8Array(lastConfig.length + data.length);
        chunk.set(lastConfig, 0); chunk.set(data, lastConfig.length);
      }
      const sps = findSps(chunk);
      if (sps && (!decoder || decoder.state !== 'configured' || Array.prototype.join.call(sps, ',') !== spsKey)) configure(sps);
      if (!decoder) return;
      waitingKey = false;
      data = chunk;
    } else if (waitingKey || !decoder) return;
    try {
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data }));
    } catch (e) {
      console.warn('decode failed:', e.message);
      waitingKey = true;
      if (player.onError) player.onError(e);
    }
  }

  // ------------------------------------------------------------ snapshots
  let pngBusy = false;
  function snapshot(data) {
    if (pngBusy) return;
    pngBusy = true;
    createImageBitmap(new Blob([data], { type: 'image/png' })).then((bmp) => {
      setSize(bmp.width, bmp.height);
      player.ctx.drawImage(bmp, 0, 0);
      bmp.close();
      player.frames++;
      if (!gotFrame) { gotFrame = true; player.live = true; if (player.onFirstFrame) player.onFirstFrame(); }
    }).catch(() => {}).then(() => { pngBusy = false; });
  }

  // Demo without an H.264 encoder: draw the pretend phone directly.
  player.drawDirect = function (source) {
    setSize(source.width, source.height);
    player.ctx.drawImage(source, 0, 0);
    player.frames++;
    if (!gotFrame) { gotFrame = true; player.live = true; if (player.onFirstFrame) player.onFirstFrame(); }
  };

  // ------------------------------------------------------------ audio
  let actx = null, gain = null, adec = null, nextTime = 0;
  function ensureAudio() {
    if (actx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    actx = new AC({ sampleRate: 48000, latencyHint: 'interactive' });
    gain = actx.createGain();
    gain.gain.value = player.muted ? 0 : 1;
    gain.connect(actx.destination);
    player.audioContext = actx;
  }
  player.unlockAudio = function () {
    if (actx && actx.state === 'suspended') actx.resume().then(() => { player.audioBlocked = false; }).catch(() => {});
  };
  player.setMuted = function (m) {
    player.muted = !!m;
    if (gain) gain.gain.setTargetAtTime(m ? 0 : 1, actx.currentTime, 0.03);
  };

  function playAudio(ad) {
    const n = ad.numberOfFrames, ch = ad.numberOfChannels;
    const buf = actx.createBuffer(ch, n, ad.sampleRate);
    for (let c = 0; c < ch; c++) {
      const plane = new Float32Array(n);
      ad.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
      buf.copyToChannel(plane, c);
    }
    ad.close();
    const now = actx.currentTime;
    // Keep a small cushion; if we fall behind or drift too far ahead, re-sync (keeps latency low).
    if (nextTime < now + 0.01 || nextTime > now + 0.4) nextTime = now + 0.06;
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    src.start(nextTime);
    nextTime += buf.duration;
  }

  function audio(flags, pts, data) {
    if (flags === 1 || !('AudioDecoder' in window)) return; // codec header is not needed for Opus
    ensureAudio();
    if (actx.state === 'suspended') { player.audioBlocked = true; actx.resume().catch(() => {}); return; }
    player.audioBlocked = false;
    if (!adec || adec.state === 'closed') {
      adec = new AudioDecoder({ output: playAudio, error: (e) => { console.warn('Audio decoder error:', e.message); adec = null; } });
      adec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
    }
    if (adec.decodeQueueSize > 50) return;
    try { adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: pts, data })); } catch (e) { adec = null; }
  }

  // ------------------------------------------------------------ entry point
  player.feed = function (arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const type = view.getUint8(0), flags = view.getUint8(1), pts = view.getFloat64(2, true);
    const data = new Uint8Array(arrayBuffer, 10);
    if (type === 1) video(flags, pts, data);
    else if (type === 2) audio(flags, pts, data);
    else if (type === 3) snapshot(data);
  };

  player.reset = function () {
    waitingKey = true; gotFrame = false; player.live = false; lastConfig = null; spsKey = '';
    if (decoder && decoder.state !== 'closed') { try { decoder.close(); } catch (e) { /* ignore */ } }
    decoder = null;
  };

  GC.player = player;
})();
