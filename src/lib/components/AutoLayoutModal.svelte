<script lang="ts">
  // Camera auto-layout, two phases:
  //   DETECT — device holds LEDs blinking; a live overlay circles every blinking blob and shows
  //     the count. You tune brightness / zoom until all N LEDs are cleanly circled.
  //   MAP — "Map LEDs" runs the structured-light sequence and recovers each LED's position.
  import { onMount } from 'svelte';
  import { startCalibration, stopCalibration, uploadStripLayout } from '$lib/ble';
  import { captureAndDecode, detectBlobs } from '$lib/cameraDecode';
  import { buildLedmap, rectifyPoints, rotateLedmap, type Pt, type Ledmap } from '$lib/autoLayout';
  import LayoutPreview from './LayoutPreview.svelte';

  // Portal to <body> so the overlay covers the whole app (a device card's backdrop-filter would
  // otherwise trap this position:fixed overlay inside the card).
  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }

  let { deviceId, stripIndex, numLeds, onClose }:
    { deviceId: string; stripIndex: number; numLeds: number; onClose: () => void } = $props();

  const FRAME_MS = 220;   // must match firmware CALIB_FRAME_MS
  const DET_W = 200;      // live-detection resolution (low → responsive sliders)
  const MAP_W = 320;      // mapping resolution (higher → better separation)
  const DET_THR = 0.5;    // live blob threshold, fraction of peak temporal swing
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, numLeds))));

  let video: HTMLVideoElement;
  let preview: HTMLCanvasElement | undefined = $state();
  let stream: MediaStream | null = null;
  let videoTrack: MediaStreamTrack | null = null;
  let zoomCap: { min: number; max: number; step: number } | null = $state(null);
  let zoom = $state(1);

  let points: (Pt | null)[] = $state([]);
  let snap = $state(1);
  let rectify = $state(false);
  let turns = $state(0);
  let status = $state('Aim at the strip. Tune brightness until every LED is circled, then Map.');
  let busy = $state(false);
  let detectedCount = $state(0);
  let calBright = $state(40);

  let detecting = false;
  let mapGen = 0;
  let grab: HTMLCanvasElement | null = null;
  let frameBuf: Uint8Array[] = [];
  let bufW = 0, bufH = 0;
  const BUF = 10;

  const layout = $derived.by((): Ledmap | null => {
    if (!points.length) return null;
    const src = rectify ? rectifyPoints(points) : points;
    return rotateLedmap(buildLedmap(src, snap), turns);
  });
  const decodedCount = $derived(points.filter(Boolean).length);

  function applyZoom(z: number) { zoom = z; videoTrack?.applyConstraints({ advanced: [{ zoom: z } as any] }).catch(() => {}); }

  function closeModal() { detecting = false; stopCalibration(deviceId).catch(() => {}); onClose(); }

  // --- live detection: circle only things that BLINK (temporal range over a short window) ---
  function detectFrame() {
    if (!detecting) return;
    const cv = preview;
    if (video && video.videoWidth && cv) {
      const vw = video.videoWidth, vh = video.videoHeight;
      const w = Math.min(DET_W, vw), h = Math.round((w / vw) * vh);
      if (w !== bufW || h !== bufH) { frameBuf = []; bufW = w; bufH = h; }
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
        if (frameBuf.length >= 5 && ctx) {
          const pmin = new Uint8Array(N).fill(255), pmax = new Uint8Array(N);
          for (const g of frameBuf) for (let i = 0; i < N; i++) { if (g[i] < pmin[i]) pmin[i] = g[i]; if (g[i] > pmax[i]) pmax[i] = g[i]; }
          const range = new Uint8Array(N); let mx = 0;
          for (let i = 0; i < N; i++) { const r = pmax[i] - pmin[i]; range[i] = r; if (r > mx) mx = r; }
          const blobs = mx >= 25 ? detectBlobs(range, w, h, { thresh: Math.max(18, mx * DET_THR) }) : [];
          detectedCount = blobs.length;
          ctx.lineWidth = Math.max(1, w / 200);
          ctx.strokeStyle = blobs.length === numLeds ? '#2ecc71' : '#ffd23f';
          for (const b of blobs) { ctx.beginPath(); ctx.arc(b.x, b.y, Math.max(3, Math.sqrt(b.n) + 1), 0, 6.283); ctx.stroke(); }
        }
      }
    }
    setTimeout(detectFrame, 130);
  }

  function startDetect() { detecting = true; frameBuf = []; startCalibration(deviceId, stripIndex, calBright, 'strobe').catch(() => {}); detectFrame(); }

  let briTimer: any = null;
  function onBrightness() {
    if (!detecting || briTimer) return;
    briTimer = setTimeout(() => { briTimer = null; frameBuf = []; startCalibration(deviceId, stripIndex, calBright, 'strobe').catch(() => {}); }, 90);
  }

  onMount(() => {
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } });
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

  async function map() {
    busy = true; points = [];
    const myGen = ++mapGen;
    detecting = false;
    try {
      status = 'Mapping… hold steady';
      await startCalibration(deviceId, stripIndex, calBright, 'full');
      await new Promise((r) => setTimeout(r, FRAME_MS * 3));
      const res = await captureAndDecode(video, { bits, frameMs: FRAME_MS, numLeds, cycles: 6, procWidth: MAP_W, onLog: (m) => { if (myGen === mapGen) status = m; } });
      if (myGen !== mapGen) return;
      points = res.points;
      const got = res.diag?.found ?? 0;
      status = got >= numLeds ? `Mapped all ${numLeds}! Rotate if needed, then Use this map.`
        : got > 0 ? `Mapped ${got}/${numLeds}. Re-aim / tune brightness and Map again, or use what's here.`
          : `No LEDs decoded. Tune brightness so every LED is circled, then Map.`;
    } catch (e: any) {
      if (myGen === mapGen) status = 'Map failed: ' + (e?.message || e);
    } finally {
      if (myGen === mapGen) { busy = false; startDetect(); }
    }
  }

  function cancelMap() { mapGen++; busy = false; status = 'Map cancelled.'; stopCalibration(deviceId).catch(() => {}); startDetect(); }

  async function use() {
    if (!layout) return;
    busy = true; detecting = false;
    try {
      await stopCalibration(deviceId);          // stop flashing BEFORE uploading the layout
      await uploadStripLayout(deviceId, stripIndex, layout);
      onClose();                                // done → close the modal
    } catch (e: any) { status = 'Upload failed: ' + (e?.message || e); busy = false; startDetect(); }
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
        <div class="al-count" class:ok={detectedCount === numLeds}>Detected <strong>{detectedCount}</strong> / {numLeds}{#if detectedCount === numLeds} ✓{/if}</div>
        {#if zoomCap}
          <label class="al-slider">🔍 <input type="range" min={zoomCap.min} max={zoomCap.max} step={zoomCap.step} value={zoom} oninput={(e) => applyZoom(parseFloat(e.currentTarget.value))} /></label>
        {/if}
        <label class="al-slider">☀️ <input type="range" min="4" max="200" step="2" bind:value={calBright} oninput={onBrightness} /><span>{calBright}</span></label>
        <div class="al-scanrow">
          {#if busy}
            <button class="btn danger" onclick={cancelMap}>Cancel</button>
          {:else}
            <button class="btn primary" onclick={map}>Map LEDs</button>
          {/if}
        </div>
      </div>
      <div class="al-controls">
        <p class="al-status">{status}</p>
        {#if layout}
          <div class="al-rotate">Rotate
            <button class="btn small" onclick={() => (turns = (turns + 3) % 4)}>⟲</button>
            <button class="btn small" onclick={() => (turns = (turns + 1) % 4)}>⟳</button>
            <span>{turns * 90}°</span>
          </div>
          <label class="al-slider">Snap <input type="range" min="0" max="1" step="0.05" bind:value={snap} /><span>{snap > 0.66 ? 'grid' : snap < 0.34 ? 'free' : '·'}</span></label>
          <label class="cb"><input type="checkbox" bind:checked={rectify} /> Fix camera angle (rectangular)</label>
          <div class="al-result">{layout.width}×{layout.height}, {decodedCount} LEDs</div>
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
  .al-panel .btn { padding: 0.6rem 0.9rem; border: 1px solid rgba(255,255,255,0.18); border-radius: 8px;
    background: rgba(255,255,255,0.08); color: #e9eaee; font-size: 0.9rem; font-weight: 600; cursor: pointer;
    -webkit-tap-highlight-color: transparent; }
  /* Only apply hover on real pointers — on touch it sticks after a tap/scroll and looks like the
     button "changed color". */
  @media (hover: hover) { .al-panel .btn:hover:not(:disabled) { background: rgba(255,255,255,0.14); } }
  .al-panel .btn:disabled { opacity: 0.5; cursor: default; }
  .al-panel .btn.primary { background: linear-gradient(135deg, #3b82f6, #1d4ed8); border-color: transparent; color: #fff; }
  .al-panel .btn.danger { background: linear-gradient(135deg, #ef4444, #dc2626); border-color: transparent; color: #fff; }
  .al-panel .btn.small { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 0.85rem 1.1rem; border-bottom: 1px solid rgba(255,255,255,0.1); }
  header h2 { margin: 0; font-size: 1.1rem; }
  .al-close { background: none; border: none; color: #aaa; font-size: 1.7rem; line-height: 1; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .al-body { display: flex; gap: 1rem; padding: 1rem 1.1rem; flex-wrap: wrap; }
  .al-cam { flex: 1 1 280px; display: flex; flex-direction: column; gap: 0.5rem; }
  .al-preview { width: 100%; border-radius: 8px; background: #000; image-rendering: pixelated; aspect-ratio: 4/3; object-fit: contain; }
  .al-count { font-size: 0.95rem; text-align: center; opacity: 0.85; }
  .al-count.ok { color: #2ecc71; opacity: 1; font-weight: 600; }
  .al-slider { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; }
  .al-slider input[type="range"] { flex: 1; }
  .al-slider span { min-width: 2.5em; text-align: right; opacity: 0.8; font-variant-numeric: tabular-nums; }
  .al-scanrow { display: flex; }
  .al-scanrow .btn { flex: 1; }
  .al-controls { flex: 1 1 280px; display: flex; flex-direction: column; gap: 0.6rem; }
  .al-status { font-size: 0.9rem; opacity: 0.9; min-height: 2.4em; }
  .al-rotate { display: flex; align-items: center; gap: 0.4rem; font-size: 0.9rem; }
  .al-result { font-size: 0.85rem; opacity: 0.9; }
  .cb { display: flex; align-items: center; gap: 0.45rem; font-size: 0.85rem; }
</style>
