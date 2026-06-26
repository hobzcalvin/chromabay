<script lang="ts">
  // Camera auto-layout, two phases (à la led_camera_map):
  //   1. DETECT — the device holds all LEDs steady-on; a live overlay circles every bright blob
  //      we detect. You tune brightness / distance / zoom until it cleanly finds all N LEDs.
  //   2. MAP — the device runs a structured-light sequence; we re-find those blobs on the clean
  //      averaged image and read each one's binary code to assign its LED index → position.
  import { onMount } from 'svelte';
  import { startCalibration, stopCalibration, uploadStripLayout } from '$lib/ble';
  import { captureAndDecode, captureRawFrames, detectBlobs, type DecodeDebug } from '$lib/cameraDecode';
  import { buildLedmap, rectifyPoints, rotateLedmap, type Pt, type Ledmap } from '$lib/autoLayout';
  import LayoutPreview from './LayoutPreview.svelte';

  // Move the overlay to <body> so it covers the whole app (a device card's backdrop-filter would
  // otherwise trap this position:fixed overlay inside the card).
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }

  let { deviceId, stripIndex, numLeds, onClose }:
    { deviceId: string; stripIndex: number; numLeds: number; onClose: () => void } = $props();

  const FRAME_MS = 220; // must match firmware CALIB_FRAME_MS
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, numLeds))));

  let video: HTMLVideoElement;             // hidden; just the capture source
  let preview: HTMLCanvasElement | undefined = $state(); // live detection view (camera + blob circles)
  let stream: MediaStream | null = null;
  let videoTrack: MediaStreamTrack | null = null;
  let zoomCap: { min: number; max: number; step: number } | null = $state(null);
  let zoom = $state(1);

  let points: (Pt | null)[] = $state([]);
  let snap = $state(1);
  let rectify = $state(false);
  let turns = $state(0);
  let status = $state('Aim at the strip. Tune brightness until every LED is circled, then Map.');
  let busy = $state(false);                // a map() is running
  let detectedCount = $state(0);
  let debug: DecodeDebug | null = $state(null);
  let dbgCanvas: HTMLCanvasElement | undefined = $state();

  let calBright = $state(40);              // calibration brightness (PRIMARY control, tuned by eye)
  let detThr = $state(0.5);                // live blob threshold, fraction of peak brightness
  let procWidth = $state(320);             // processing/preview resolution

  let detecting = false;                   // detection loop active (paused during a map)
  let mapGen = 0;                          // cancel/supersede token
  let grab: HTMLCanvasElement | null = null; // offscreen frame-grab canvas (created on first use)
  let frameBuf: Uint8Array[] = [];         // rolling window of recent gray frames (for blink test)
  let bufW = 0, bufH = 0;                  // buffer frame size (cleared if procWidth changes)
  const BUF = 12;

  function closeModal() { detecting = false; stopCalibration(deviceId).catch(() => {}); onClose(); }
  function applyZoom(z: number) { zoom = z; videoTrack?.applyConstraints({ advanced: [{ zoom: z } as any] }).catch(() => {}); }

  const layout = $derived.by((): Ledmap | null => {
    if (!points.length) return null;
    const src = rectify ? rectifyPoints(points) : points;
    return rotateLedmap(buildLedmap(src, snap), turns);
  });
  const decodedCount = $derived(points.filter(Boolean).length);

  // --- live detection: only circle things that actually BLINK with the strobe. We keep a short
  // rolling window of frames and detect blobs on the per-pixel temporal RANGE (max−min) — a real
  // LED toggles on/off (high range); static specks, reflections and noise don't (≈0) and vanish. ---
  function detectFrame() {
    if (!detecting) return;
    const cv = preview;
    if (video && video.videoWidth && cv) {
      const vw = video.videoWidth, vh = video.videoHeight;
      const w = Math.min(procWidth, vw), h = Math.round((w / vw) * vh);
      if (w !== bufW || h !== bufH) { frameBuf = []; bufW = w; bufH = h; } // resolution changed
      if (!grab) grab = document.createElement('canvas');
      grab.width = w; grab.height = h;
      const gctx = grab.getContext('2d', { willReadFrequently: true });
      if (gctx) {
        gctx.drawImage(video, 0, 0, w, h);
        const d = gctx.getImageData(0, 0, w, h).data;
        const N = w * h, gray = new Uint8Array(N);
        for (let i = 0, j = 0; i < d.length; i += 4, j++) { const m = d[i] > d[i + 1] ? d[i] : d[i + 1]; gray[j] = m > d[i + 2] ? m : d[i + 2]; }
        frameBuf.push(gray); if (frameBuf.length > BUF) frameBuf.shift();
        const ctx = cv.getContext('2d');
        cv.width = w; cv.height = h;
        if (ctx) ctx.drawImage(grab, 0, 0);
        // Need at least a couple of strobe transitions in the window before the range is meaningful.
        if (frameBuf.length >= 5 && ctx) {
          const pmin = new Uint8Array(N).fill(255), pmax = new Uint8Array(N);
          for (const g of frameBuf) for (let i = 0; i < N; i++) { if (g[i] < pmin[i]) pmin[i] = g[i]; if (g[i] > pmax[i]) pmax[i] = g[i]; }
          const range = new Uint8Array(N); let mx = 0;
          for (let i = 0; i < N; i++) { const r = pmax[i] - pmin[i]; range[i] = r; if (r > mx) mx = r; }
          const blobs = mx >= 25 ? detectBlobs(range, w, h, { thresh: Math.max(18, mx * detThr) }) : [];
          detectedCount = blobs.length;
          ctx.lineWidth = Math.max(1, w / 240);
          ctx.strokeStyle = blobs.length === numLeds ? '#2ecc71' : '#ffd23f';
          for (const b of blobs) { ctx.beginPath(); ctx.arc(b.x, b.y, Math.max(3, Math.sqrt(b.n) + 1), 0, 6.283); ctx.stroke(); }
        }
      }
    }
    setTimeout(detectFrame, 90);
  }

  function startDetect() {
    detecting = true; frameBuf = [];
    startCalibration(deviceId, stripIndex, calBright, 'strobe').catch(() => {}); // blink so we can validate
    detectFrame();
  }

  // Re-send the steady-on brightness when the slider moves (throttled), so the overlay updates live.
  let briTimer: any = null;
  function onBrightness() {
    if (!detecting) return;
    if (briTimer) return;
    briTimer = setTimeout(() => { briTimer = null; frameBuf = []; startCalibration(deviceId, stripIndex, calBright, 'strobe').catch(() => {}); }, 80);
  }

  onMount(() => {
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (video) { video.srcObject = stream; await video.play().catch(() => {}); }
        videoTrack = stream.getVideoTracks()[0] ?? null;
        const caps: any = videoTrack?.getCapabilities?.() ?? {};
        if (typeof caps.zoom === 'object' && caps.zoom && caps.zoom.max > caps.zoom.min) {
          zoomCap = { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 };
          zoom = (videoTrack!.getSettings() as any).zoom ?? caps.zoom.min;
        }
        startDetect();
      } catch (e: any) { status = 'Camera error: ' + (e?.message || e); }
    })();
    return () => { detecting = false; stream?.getTracks().forEach((t) => t.stop()); };
  });

  // MAP: switch to structured light, decode (detect blobs + read each one's code), then resume detect.
  async function map() {
    busy = true; points = []; debug = null;
    const myGen = ++mapGen;
    detecting = false;
    try {
      status = 'Mapping… hold steady';
      await startCalibration(deviceId, stripIndex, calBright, 'full');
      await new Promise((r) => setTimeout(r, FRAME_MS * 3)); // let the device enter the cycle
      const res = await captureAndDecode(video, {
        bits, frameMs: FRAME_MS, numLeds, cycles: 6, procWidth, onLog: (m) => { if (myGen === mapGen) status = m; },
      });
      if (myGen !== mapGen) return; // cancelled / superseded
      debug = res.debug ?? null;
      points = res.points;
      const got = res.diag?.found ?? 0;
      status = got >= numLeds
        ? `Mapped all ${numLeds}! Tune snap / rotation, then Use this map.`
        : got > 0
          ? `Mapped ${got}/${numLeds}. Re-aim/tune brightness and Map again, or use what's here.`
          : `No LEDs decoded (${res.reason}). Tune brightness so every LED is circled, then Map.`;
    } catch (e: any) {
      if (myGen === mapGen) status = 'Map failed: ' + (e?.message || e);
    } finally {
      if (myGen === mapGen) { busy = false; startDetect(); } // back to live detection
    }
  }

  function cancelMap() {
    mapGen++; busy = false; status = 'Map cancelled.';
    stopCalibration(deviceId).catch(() => {});
    startDetect();
  }

  // Record the raw structured-light frames to a .bin (CBC1) for offline decode debugging.
  async function record() {
    busy = true; const myGen = ++mapGen; detecting = false;
    try {
      status = 'Recording (~9s, hold steady)…';
      await startCalibration(deviceId, stripIndex, calBright, 'full');
      await new Promise((r) => setTimeout(r, FRAME_MS * 3));
      const ms = (1 + bits) * FRAME_MS * 5 * 1.5 + FRAME_MS;
      const frames = await captureRawFrames(video, ms, procWidth);
      if (myGen !== mapGen) return;
      if (!frames.length) { status = 'No frames captured.'; return; }
      const w = frames[0].w, h = frames[0].h, n = frames.length;
      const buf = new ArrayBuffer(16 + n * (4 + w * h));
      const dv = new DataView(buf), u8 = new Uint8Array(buf);
      dv.setUint32(0, 0x43424331, false); // 'CBC1'
      dv.setUint16(4, w, true); dv.setUint16(6, h, true); dv.setUint16(8, bits, true);
      dv.setUint16(10, FRAME_MS, true); dv.setUint16(12, numLeds, true); dv.setUint16(14, n, true);
      let off = 16;
      for (const f of frames) { dv.setFloat32(off, f.t, true); off += 4; u8.set(f.gray, off); off += w * h; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
      a.download = `chromabay-capture-strip${stripIndex + 1}-${w}x${h}-${n}f.bin`;
      a.click(); URL.revokeObjectURL(a.href);
      status = `Recorded ${n} frames (${w}×${h}). Downloaded ${a.download}.`;
    } catch (e: any) {
      if (myGen === mapGen) status = 'Record failed: ' + (e?.message || e);
    } finally {
      if (myGen === mapGen) { busy = false; startDetect(); }
    }
  }

  // After-map diagnostic: the temporal-range image + detected blobs (cyan) + decoded LEDs (green).
  $effect(() => {
    const d = debug; const cv = dbgCanvas;
    if (!cv || !d) return;
    cv.width = d.w; cv.height = d.h;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const img = ctx.createImageData(d.w, d.h);
    for (let i = 0, j = 0; i < d.range.length; i++, j += 4) { const v = d.range[i]; img.data[j] = v; img.data[j + 1] = v; img.data[j + 2] = v; img.data[j + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    for (const b of d.blobs) { ctx.strokeStyle = '#00d0ff'; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.arc(b.x, b.y, 2.5, 0, 6.283); ctx.stroke(); }
    for (const dd of d.decoded) { ctx.fillStyle = '#2ecc71'; ctx.beginPath(); ctx.arc(dd.x, dd.y, 1.6, 0, 6.283); ctx.fill(); }
  });

  async function use() {
    if (!layout) return;
    busy = true;
    try {
      await uploadStripLayout(deviceId, stripIndex, layout);
      status = `Uploaded ${layout.width}×${layout.height}.`;
    } catch (e: any) { status = 'Upload failed: ' + (e?.message || e); }
    finally { busy = false; }
  }
</script>

<div class="al-overlay" use:portal role="button" tabindex="-1"
  onclick={(e) => { if (e.target === e.currentTarget) closeModal(); }} onkeydown={() => {}}>
  <div class="al-panel">
    <header><h2>Auto-map strip {stripIndex + 1} ({numLeds} LEDs)</h2>
      <button class="al-close" aria-label="Close" onclick={closeModal}>×</button></header>
    <div class="al-body">
      <div class="al-cam">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={video} playsinline muted style="display:none"></video>
        <canvas bind:this={preview} class="al-preview"></canvas>
        <div class="al-count" class:ok={detectedCount === numLeds}>
          Detected <strong>{detectedCount}</strong> / {numLeds} LEDs
          {#if detectedCount === numLeds}✓{/if}
        </div>
        {#if zoomCap}
          <label class="al-zoom">🔍 <input type="range" min={zoomCap.min} max={zoomCap.max} step={zoomCap.step}
            value={zoom} oninput={(e) => applyZoom(parseFloat(e.currentTarget.value))} /></label>
        {/if}
        <label class="al-bri">Brightness
          <input type="range" min="4" max="200" step="2" bind:value={calBright} oninput={onBrightness} />
          <span>{calBright}</span></label>
        <div class="al-scanrow">
          {#if busy}
            <button class="btn danger" onclick={cancelMap}>Cancel</button>
          {:else}
            <button class="btn primary" onclick={map}>Map LEDs</button>
            <button class="btn" onclick={record} title="Save the raw capture for offline debugging">⏺</button>
          {/if}
        </div>
        <details class="al-settings">
          <summary>Advanced</summary>
          <label>Detection sensitivity <input type="range" min="0.2" max="0.85" step="0.05" bind:value={detThr} /><span>{detThr.toFixed(2)}</span></label>
          <label>Resolution <input type="range" min="160" max="480" step="20" bind:value={procWidth} /><span>{procWidth}px</span></label>
        </details>
        {#if debug}
          <div class="al-debug">
            <canvas bind:this={dbgCanvas} class="al-dbgcanvas"></canvas>
            <div class="al-counts">{debug.frames} frames · {debug.blobs.length} blobs · {debug.decoded.length} decoded · swing {debug.maxRange}/255</div>
          </div>
        {/if}
      </div>
      <div class="al-controls">
        <p class="al-status">{status}</p>
        <label>Snap <input type="range" min="0" max="1" step="0.05" bind:value={snap} disabled={!points.length} />
          <span>{snap.toFixed(2)} {snap > 0.66 ? '(force grid)' : snap < 0.34 ? '(keep spacing)' : ''}</span></label>
        <label class="cb"><input type="checkbox" bind:checked={rectify} disabled={!points.length} /> Rectify (assume rectangular, fix camera angle)</label>
        <div class="al-rotate">
          Rotate: <button class="btn small" disabled={!points.length} onclick={() => (turns = (turns + 3) % 4)}>⟲</button>
          <button class="btn small" disabled={!points.length} onclick={() => (turns = (turns + 1) % 4)}>⟳</button>
          <span>{turns * 90}°</span>
        </div>
        {#if layout}
          <div class="al-result">{layout.width}×{layout.height}, {decodedCount} LEDs mapped</div>
          <LayoutPreview width={layout.width} height={layout.height} map={layout.map} />
          <button class="btn primary" disabled={busy} onclick={use}>Use this map</button>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .al-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(3px);
    z-index: 3000; display: flex; align-items: flex-start; justify-content: center; box-sizing: border-box;
    padding: calc(env(safe-area-inset-top, 0px) + 0.6rem) 0.6rem calc(env(safe-area-inset-bottom, 0px) + 0.6rem); overflow-y: auto; }
  .al-panel { width: 100%; max-width: 760px; background: #14161c; color: #e9eaee; box-sizing: border-box;
    border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,0.7); }
  .al-panel .btn { padding: 0.55rem 0.9rem; border: 1px solid rgba(255,255,255,0.18); border-radius: 8px;
    background: rgba(255,255,255,0.08); color: #e9eaee; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
  .al-panel .btn:hover:not(:disabled) { background: rgba(255,255,255,0.14); }
  .al-panel .btn:disabled { opacity: 0.5; cursor: default; }
  .al-panel .btn.primary { background: linear-gradient(135deg, #3b82f6, #1d4ed8); border-color: transparent; color: #fff; }
  .al-panel .btn.danger { background: linear-gradient(135deg, #ef4444, #dc2626); border-color: transparent; color: #fff; }
  .al-panel .btn.small { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
  .al-zoom, .al-bri { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; }
  .al-zoom input[type="range"], .al-bri input[type="range"] { flex: 1; }
  .al-bri span { min-width: 2.5em; text-align: right; font-variant-numeric: tabular-nums; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 0.85rem 1.1rem;
    border-bottom: 1px solid rgba(255,255,255,0.1); }
  header h2 { margin: 0; font-size: 1.1rem; }
  .al-close { background: none; border: none; color: #aaa; font-size: 1.7rem; line-height: 1; cursor: pointer; }
  .al-body { display: flex; gap: 1rem; padding: 1rem 1.1rem; flex-wrap: wrap; }
  .al-cam { flex: 1 1 280px; display: flex; flex-direction: column; gap: 0.5rem; }
  .al-preview { width: 100%; border-radius: 8px; background: #000; image-rendering: pixelated; aspect-ratio: 4/3; object-fit: contain; }
  .al-count { font-size: 0.95rem; text-align: center; opacity: 0.85; }
  .al-count.ok { color: #2ecc71; opacity: 1; font-weight: 600; }
  .al-scanrow { display: flex; gap: 0.5rem; }
  .al-scanrow .btn { flex: 1; }
  .al-controls { flex: 1 1 280px; display: flex; flex-direction: column; gap: 0.6rem; }
  .al-controls label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; }
  .al-controls label.cb { flex-direction: row; align-items: center; gap: 0.45rem; }
  .al-status { font-size: 0.85rem; opacity: 0.85; min-height: 2.4em; }
  .al-result { font-size: 0.85rem; opacity: 0.9; }
  .al-rotate { display: flex; align-items: center; gap: 0.4rem; font-size: 0.9rem; }
  .al-debug { display: flex; flex-direction: column; gap: 0.3rem; }
  .al-dbgcanvas { width: 100%; image-rendering: pixelated; background: #000; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15); }
  .al-counts { font-size: 0.78rem; opacity: 0.85; font-variant-numeric: tabular-nums; }
  .al-settings { font-size: 0.85rem; }
  .al-settings summary { cursor: pointer; opacity: 0.8; }
  .al-settings label { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.4rem; }
  .al-settings label input[type='range'] { flex: 1; }
  .al-settings label span { min-width: 4em; text-align: right; opacity: 0.8; }
</style>
