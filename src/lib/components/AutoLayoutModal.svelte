<script lang="ts">
  // Camera auto-layout in three explicit steps:
  //   1. FRAME   — device held steady ALL-ON; the user frames the whole array, holds still, taps Capture.
  //   2. TUNE    — (auto) ramp brightness from low until the blinking LEDs are clearly visible, landing on
  //                the dimmest level that reads (dim = no bloom = LEDs stay distinct dots).
  //   3. CAPTURE — (auto) record the structured-light sequence at high res, decode, show the result.
  // The result shows the ALL-ON photo with every found LED overlaid + the logical grid preview, so the
  // user can judge how well it went. No realtime per-frame analysis (it only ever undercounted + janked).
  import { onMount } from 'svelte';
  import { startCalibration, stopCalibration, uploadStripLayout, CALIB_PAIRS_FEAT } from '$lib/ble';
  import { captureRawFrames, measureSwing, type Frame } from '$lib/cameraDecode';
  import { runAutoScan, type ScanResult } from '$lib/autoScan';
  import { buildLedmap, fitWiring, rectifyPoints, rotateLedmap, type Pt, type Ledmap } from '$lib/autoLayout';
  import LayoutPreview from './LayoutPreview.svelte';

  function portal(node: HTMLElement) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }

  let { deviceId, stripIndex, numLeds, feat = 1, onClose }:
    { deviceId: string; stripIndex: number; numLeds: number; feat?: number; onClose: () => void } = $props();

  const FRAME_MS = 220;
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, numLeds))));
  // feat>=9 firmware runs inverse pairs (mode 3) and takes our `bits`; older firmware runs the
  // legacy [ON][bits] sequence, which the v2 decoder also reads (less robustly).
  const seqKind: 'comp' | 'legacy' = feat >= CALIB_PAIRS_FEAT ? 'comp' : 'legacy';
  // Processing resolution scales with array size (≈34 px/LED across the width); a 5×5 stays at 320, a
  // 20×20 → 512 (capped for capture/CPU cost).
  const MAP_W = Math.min(512, Math.max(320, Math.round(Math.sqrt(numLeds) * 34)));
  // Brightness ramp: geometric steps, stop at the first clearly-visible level, then nudge up for margin.
  const BRIGHT_LEVELS = [2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
  const VIS_SWING = 28;                                      // temporal swing (0..255) that clears sensor noise
  const VIS_BLOBS = Math.max(4, Math.round(numLeds * 0.05)); // a handful of distinct blinking blobs = "visible"

  let video: HTMLVideoElement;
  let preview: HTMLCanvasElement | undefined = $state();
  let resultCanvas: HTMLCanvasElement | undefined = $state();
  let stream: MediaStream | null = null;
  let videoTrack: MediaStreamTrack | null = null;
  let zoomCap: { min: number; max: number; step: number } | null = $state(null);
  let zoom = $state(1);
  let alive = true;

  let phase = $state<'frame' | 'tune' | 'capture' | 'result'>('frame');
  let points: (Pt | null)[] = $state([]);
  let snap = $state(1);
  let rectify = $state(true);
  let turns = $state(0);
  let status = $state('Frame the whole device, hold steady, then tap Capture.');
  let calBright = $state(40);
  let progress = $state(0);          // 0..1 capture progress
  let capLabel = $state('Capturing…');
  let gen = 0;                       // invalidates an in-flight ramp/capture when the user acts again
  // ALL-ON photo + found LED positions, for the result overlay.
  let overlay: { img: Uint8Array; w: number; h: number; pts: { x: number; y: number }[] } | null = $state(null);

  // A standard W×H matrix (straight or serpentine) is recognised from its wiring order, which is exact
  // even with jitter, perspective or LEDs the camera missed; anything else uses the generic grid fit.
  let useWiring = $state(true);
  const wiring = $derived(points.length ? fitWiring(points, numLeds) : null);
  const layout = $derived.by((): Ledmap | null => {
    if (!points.length) return null;
    if (wiring && useWiring) return rotateLedmap(wiring.ledmap, turns);
    const src = rectify ? rectifyPoints(points) : points;
    return rotateLedmap(buildLedmap(src, snap), turns);
  });
  const decodedCount = $derived(points.filter(Boolean).length);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  function applyZoom(z: number) { zoom = z; videoTrack?.applyConstraints({ advanced: [{ zoom: z } as any] }).catch(() => {}); }
  function closeModal() { gen++; phase = 'result'; stopCalibration(deviceId).catch(() => {}); onClose(); }

  // Lightweight preview: just draw the live video (NO per-frame analysis) except on the result screen.
  function previewLoop() {
    if (!alive) return;
    if (phase !== 'result' && video && video.videoWidth && preview) {
      const vw = video.videoWidth, vh = video.videoHeight;
      const pw = Math.min(540, vw), ph = Math.round((pw / vw) * vh);
      preview.width = pw; preview.height = ph;
      preview.getContext('2d')?.drawImage(video, 0, 0, pw, ph);
    }
    setTimeout(previewLoop, 100);
  }

  onMount(() => {
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } });
        // Closed while the permission prompt was up: the cleanup below already ran (with no
        // stream to stop), so release the camera here and don't start calibrating the LEDs.
        if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
        if (video) { video.srcObject = stream; await video.play().catch(() => {}); }
        videoTrack = stream.getVideoTracks()[0] ?? null;
        const caps: any = videoTrack?.getCapabilities?.() ?? {};
        if (typeof caps.zoom === 'object' && caps.zoom && caps.zoom.max > caps.zoom.min) {
          zoomCap = { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 };
          zoom = (videoTrack!.getSettings() as any).zoom ?? caps.zoom.min;
        }
        startFrame();
        previewLoop();
      } catch (e: any) { status = 'Camera error: ' + (e?.message || e); }
    })();
    return () => { alive = false; gen++; stream?.getTracks().forEach((t) => t.stop()); };
  });

  // PHASE 1 — framing. Device steady ALL-ON so the array is clearly lit to aim at.
  function startFrame() {
    phase = 'frame';
    status = 'Frame the whole device, hold steady, then tap Capture.';
    startCalibration(deviceId, stripIndex, calBright, 'detect').catch(() => {});
  }

  // PHASE 2 — ramp brightness from low until the blinking strip is clearly visible; return the chosen
  // level (nudged up a little for SNR margin), or null if nothing showed even at full brightness.
  async function tuneBrightness(myGen: number): Promise<number | null> {
    phase = 'tune';
    for (const B of BRIGHT_LEVELS) {
      if (myGen !== gen) return null;
      status = `Finding brightness… (level ${B})`;
      await startCalibration(deviceId, stripIndex, B, 'strobe');
      await sleep(FRAME_MS * 2);                              // settle + a couple strobe cycles
      if (myGen !== gen) return null;
      const m = await measureSwing(video, 650, MAP_W);
      if (myGen !== gen) return null;
      if (m.maxRange >= VIS_SWING && m.blobs >= VIS_BLOBS) return Math.min(255, Math.round(B * 1.3));
    }
    return null;
  }

  // PHASE 2+3 — closed loop (src/lib/autoScan.ts): probe brightness with a strobe until the LED
  // cores are neither faint nor clipped, then run the structured-light sequence and decode it
  // (dimming + retrying if it came back clipped and incomplete). Benchmarked offline by
  // automation/autolayout-sim.ts against the same code.
  let lastScanFrames: Frame[] = [];
  // Raw capture file (replay with automation/replay-capture.ts): 'CBC1' = legacy sequence,
  // 'CBC2' = inverse pairs; u16 w,h,bits,frameMs,numLeds,frameCount; per frame f32 t + w*h gray.
  function encodeCapture(frames: Frame[]): ArrayBuffer {
    const w = frames[0].w, h = frames[0].h, n = Math.min(frames.length, 65535);
    const buf = new ArrayBuffer(16 + n * (4 + w * h));
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    dv.setUint32(0, seqKind === 'comp' ? 0x43424332 : 0x43424331, false);
    dv.setUint16(4, w, true); dv.setUint16(6, h, true); dv.setUint16(8, bits, true);
    dv.setUint16(10, FRAME_MS, true); dv.setUint16(12, numLeds, true); dv.setUint16(14, n, true);
    let off = 16;
    for (let i = 0; i < n; i++) { const f = frames[i]; dv.setFloat32(off, f.t, true); off += 4; u8.set(f.gray, off); off += w * h; }
    return buf;
  }
  // Automation: the rig pulls the last scan's raw frames (base64 capture file) for offline replay.
  (window as any).__chromabayAutoLayoutDump = () => {
    if (!lastScanFrames.length) return null;
    const u8 = new Uint8Array(encodeCapture(lastScanFrames)); let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  async function capture(skipTune = false) {
    const myGen = ++gen;
    phase = 'capture'; points = []; overlay = null; progress = 0; capLabel = 'Mapping…';
    const t0 = performance.now(), expMs = skipTune ? 9000 : 15000;
    const pt = setInterval(() => { if (myGen !== gen) { clearInterval(pt); return; } progress = Math.min(0.98, (performance.now() - t0) / expMs); }, 100);
    const io = {
      flash: async (k: 'strobe' | 'legacy' | 'comp', b: number, onlyLeds?: number[]) => {
        if (myGen !== gen) throw new Error('cancelled');
        if (!onlyLeds) calBright = b;
        await startCalibration(deviceId, stripIndex, b, k === 'strobe' ? 'strobe' : k === 'comp' ? 'pairs' : 'full', bits, FRAME_MS, onlyLeds);
        await sleep(FRAME_MS * 2);                    // let the device + camera exposure settle
      },
      capture: async (ms: number) => {
        if (myGen !== gen) throw new Error('cancelled');
        const fr = await captureRawFrames(video, ms, MAP_W); lastScanFrames = fr; return fr;
      },
    };
    try {
      const res: ScanResult = await runAutoScan(io, {
        numLeds, bits, kind: seqKind, frameMs: FRAME_MS, startBrightness: calBright,
        maxProbes: skipTune ? 0 : 7, onStatus: (m) => { if (myGen === gen) status = m; },
      });
      clearInterval(pt); progress = 1;
      if (myGen !== gen) return;
      points = res.points;
      calBright = res.brightness;
      if (lastScanFrames.length) {
        // Backdrop: the brightest captured frame (an ALL-ON) with every found LED dotted on it.
        let bi = 0, bm = -1; for (let i = 0; i < lastScanFrames.length; i++) { let m = 0; const g = lastScanFrames[i].gray; for (let j = 0; j < g.length; j += 7) m += g[j]; if (m > bm) { bm = m; bi = i; } }
        const f = lastScanFrames[bi];
        overlay = { img: f.gray, w: f.w, h: f.h, pts: res.points.flatMap((p) => (p ? [{ x: p.x * f.w, y: p.y * f.w }] : [])) };
      }
      phase = 'result';
      status = res.found > 0 ? `Mapped ${res.found}/${numLeds} at flash level ${res.brightness}. Check the overlay — rotate/adjust, then Use, or Recapture.`
                             : `Couldn't decode the LEDs (${res.reason}) — try Recapture, move closer, or hold steadier.`;
      // Automation hook: the bench rig (automation/autolayout-rig.mjs) reads the result from here.
      (window as any).__chromabayAutoLayout = { at: Date.now(), found: res.found, numLeds, brightness: res.brightness,
        kind: seqKind, diag: res.diag, probes: res.probes, points: res.points, layout: $state.snapshot(layout),
        wiring: wiring ? { cols: wiring.cols, rows: wiring.rows, serpentine: wiring.serpentine, residual: wiring.residual } : null };
      stopCalibration(deviceId).catch(() => {});
    } catch (e: any) {
      clearInterval(pt);
      if (myGen === gen) { status = 'Capture failed: ' + (e?.message || e); startFrame(); }
    }
  }

  function recapture() { capture(true); }     // reuse the current (possibly hand-tuned) brightness
  function reframe() { points = []; overlay = null; startFrame(); }

  // Record the raw structured-light frames to a .bin (CBC1) for offline decode debugging — at the
  // auto-tuned brightness, so the recording matches what the decoder actually sees.
  async function record() {
    const myGen = ++gen;
    const b = await tuneBrightness(myGen);
    if (myGen !== gen) return;
    if (b == null) { status = "Couldn't see the LEDs to record."; startFrame(); return; }
    calBright = b;
    phase = 'capture'; capLabel = 'Recording…'; progress = 0;
    try {
      const ms = (seqKind === 'comp' ? 2 + 2 * (bits + 1) : 1 + bits) * FRAME_MS * 3 + FRAME_MS;   // ≈10s @25 LEDs, ≈17s @400
      status = `Recording (~${Math.round((ms + FRAME_MS * 3) / 1000)}s, hold steady)…`;
      await startCalibration(deviceId, stripIndex, calBright, seqKind === 'comp' ? 'pairs' : 'full', bits, FRAME_MS);
      await sleep(FRAME_MS * 3);
      const frames = await captureRawFrames(video, ms, MAP_W);
      if (myGen !== gen) return;
      if (!frames.length) { status = 'No frames captured.'; startFrame(); return; }
      const w = frames[0].w, h = frames[0].h, n = frames.length;
      const buf = encodeCapture(frames);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
      a.download = `chromabay-capture-strip${stripIndex + 1}-${w}x${h}-${n}f.bin`;
      a.click(); URL.revokeObjectURL(a.href);
      status = `Recorded ${n} frames (${w}×${h}) at brightness ${calBright}. Downloaded ${a.download}.`;
    } catch (e: any) {
      if (myGen === gen) status = 'Record failed: ' + (e?.message || e);
    } finally {
      if (myGen === gen) startFrame();
    }
  }

  async function use() {
    if (!layout) return;
    gen++; phase = 'result';
    try {
      await stopCalibration(deviceId);
      await uploadStripLayout(deviceId, stripIndex, layout);
      onClose();
    } catch (e: any) { status = 'Upload failed: ' + (e?.message || e); }
  }

  // Draw the ALL-ON photo with every found LED dotted on top, whenever we land on the result.
  $effect(() => {
    if (phase === 'result' && overlay && resultCanvas) drawOverlay(overlay, resultCanvas);
  });
  function drawOverlay(o: NonNullable<typeof overlay>, cv: HTMLCanvasElement) {
    const dispW = Math.min(540, o.w * 2), sc = dispW / o.w, dispH = Math.round(o.h * sc);
    cv.width = dispW; cv.height = dispH;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const tmp = document.createElement('canvas'); tmp.width = o.w; tmp.height = o.h;
    const tctx = tmp.getContext('2d'); if (!tctx) return;
    const id = tctx.createImageData(o.w, o.h);
    for (let i = 0; i < o.w * o.h; i++) { const v = o.img[i]; id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
    tctx.putImageData(id, 0, 0);
    ctx.drawImage(tmp, 0, 0, dispW, dispH);
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#2ecc71'; ctx.fillStyle = 'rgba(46,204,113,0.55)';
    for (const p of o.pts) { ctx.beginPath(); ctx.arc(p.x * sc, p.y * sc, Math.max(2.5, sc * 1.6), 0, 6.283); ctx.fill(); ctx.stroke(); }
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
        <div class="al-camwrap">
          {#if phase === 'result'}
            <canvas bind:this={resultCanvas} class="al-preview"></canvas>
            {#if overlay}<div class="al-badge ok">{overlay.pts.length} / {numLeds} found</div>{/if}
          {:else}
            <canvas bind:this={preview} class="al-preview"></canvas>
            {#if phase === 'tune'}
              <div class="al-badge">Finding brightness…</div>
            {:else if phase === 'capture'}
              <div class="al-badge">{capLabel}{#if progress > 0} {Math.round(progress * 100)}%{/if}</div>
              {#if progress > 0}<div class="al-bar"><div class="al-bar-fill" style="width:{Math.round(progress * 100)}%"></div></div>{/if}
            {/if}
          {/if}
        </div>
        {#if phase === 'frame'}
          {#if zoomCap}
            <label class="al-slider">🔍 <input type="range" min={zoomCap.min} max={zoomCap.max} step={zoomCap.step} value={zoom} oninput={(e) => applyZoom(parseFloat(e.currentTarget.value))} /></label>
          {/if}
          <div class="al-detrow">
            <button class="btn primary" onclick={() => capture()}>Capture</button>
            <button class="btn" onclick={record} title="Save the raw capture for offline debugging">⏺ Record</button>
          </div>
        {/if}
      </div>
      <div class="al-controls">
        <p class="al-status">{status}</p>
        {#if phase === 'result' && layout}
          <div class="al-rotate">Rotate
            <button class="btn small" onclick={() => (turns = (turns + 3) % 4)}>⟲</button>
            <button class="btn small" onclick={() => (turns = (turns + 1) % 4)}>⟳</button>
            <span>{turns * 90}°</span>
          </div>
          {#if wiring}
            <label class="cb"><input type="checkbox" bind:checked={useWiring} /> Recognised a {wiring.cols}×{wiring.rows}{wiring.serpentine ? ' serpentine' : ''} matrix</label>
          {/if}
          {#if !wiring || !useWiring}
            <label class="al-slider">Snap <input type="range" min="0" max="1" step="0.05" bind:value={snap} /></label>
            <label class="cb"><input type="checkbox" bind:checked={rectify} /> Force to rectangle</label>
          {/if}
          <div class="al-result">{layout.width}×{layout.height}, {decodedCount} LEDs</div>
          <LayoutPreview width={layout.width} height={layout.height} map={layout.map} />
          <label class="al-slider">☀️ <input type="range" min="2" max="255" step="1" bind:value={calBright} /><span>{calBright}</span></label>
          <div class="al-actions">
            <button class="btn" onclick={reframe}>Reframe</button>
            <button class="btn" onclick={recapture}>Recapture</button>
            <button class="btn primary" onclick={use}>Use this map</button>
          </div>
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
    background: rgba(255,255,255,0.08); color: #e9eaee; font-size: 0.9rem; font-weight: 600; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  @media (hover: hover) { .al-panel .btn:hover:not(:disabled) { background: rgba(255,255,255,0.14); } }
  .al-panel .btn:disabled { opacity: 0.5; cursor: default; }
  .al-panel .btn.primary { background: linear-gradient(135deg, #3b82f6, #1d4ed8); border-color: transparent; color: #fff; }
  .al-panel .btn.small { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 0.85rem 1.1rem; border-bottom: 1px solid rgba(255,255,255,0.1); }
  header h2 { margin: 0; font-size: 1.1rem; }
  .al-close { background: none; border: none; color: #aaa; font-size: 1.7rem; line-height: 1; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .al-body { display: flex; gap: 1rem; padding: 1rem 1.1rem; flex-wrap: wrap; }
  .al-cam { flex: 1 1 280px; display: flex; flex-direction: column; gap: 0.85rem; }
  .al-camwrap { position: relative; line-height: 0; }
  .al-preview { width: 100%; border-radius: 8px; background: #000; aspect-ratio: 4/3; object-fit: contain; }
  /* Info drawn ON the camera view */
  .al-badge { position: absolute; top: 8px; left: 8px; padding: 3px 9px; border-radius: 9px;
    background: rgba(0,0,0,0.6); color: #fff; font-size: 0.9rem; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .al-badge.ok { color: #2ecc71; }
  .al-bar { position: absolute; left: 8px; right: 8px; bottom: 8px; height: 6px; border-radius: 3px; background: rgba(0,0,0,0.55); overflow: hidden; }
  .al-bar-fill { height: 100%; background: linear-gradient(90deg, #3b82f6, #60a5fa); transition: width 0.1s linear; }
  .al-slider { display: flex; align-items: center; gap: 0.6rem; font-size: 0.95rem; padding: 0.5rem 0; }
  .al-slider span { min-width: 2.5em; text-align: right; opacity: 0.8; font-variant-numeric: tabular-nums; }
  /* Big circular knobs + generous touch height so they're easy to grab with a finger. */
  .al-slider input[type="range"] { flex: 1; -webkit-appearance: none; appearance: none; height: 30px; background: transparent; cursor: pointer; }
  .al-slider input[type="range"]::-webkit-slider-runnable-track { height: 6px; border-radius: 3px; background: rgba(255,255,255,0.25); }
  .al-slider input[type="range"]::-moz-range-track { height: 6px; border-radius: 3px; background: rgba(255,255,255,0.25); }
  .al-slider input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 30px; height: 30px; margin-top: -12px; border-radius: 50%; background: #3b82f6; border: 2px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.5); }
  .al-slider input[type="range"]::-moz-range-thumb { width: 30px; height: 30px; border-radius: 50%; background: #3b82f6; border: 2px solid #fff; }
  .al-controls { flex: 1 1 280px; display: flex; flex-direction: column; gap: 0.85rem; }
  .al-status { font-size: 0.9rem; opacity: 0.9; min-height: 2.4em; }
  .al-rotate { display: flex; align-items: center; gap: 0.4rem; font-size: 0.9rem; }
  .al-result { font-size: 0.85rem; opacity: 0.9; }
  .al-detrow { display: flex; gap: 0.5rem; }
  .al-actions { display: flex; gap: 0.5rem; }
  .al-actions .btn { flex: 1; }
  .cb { display: flex; align-items: center; gap: 0.45rem; font-size: 0.85rem; }
</style>
