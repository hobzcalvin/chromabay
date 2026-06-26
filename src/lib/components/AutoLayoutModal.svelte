<script lang="ts">
  // Camera auto-layout. Point the phone at the strip, Scan → the device flashes a coded
  // sequence, we decode each LED's position, then tune snap / rectify / rotation against a
  // live preview and upload. The CV decode (cameraDecode.ts) is a first pass to tune on HW.
  import { onMount } from 'svelte';
  import { startCalibration, stopCalibration, uploadStripLayout } from '$lib/ble';
  import { captureAndDecode, captureRawFrames, type DecodeDebug } from '$lib/cameraDecode';
  import { buildLedmap, rectifyPoints, rotateLedmap, type Pt, type Ledmap } from '$lib/autoLayout';
  import LayoutPreview from './LayoutPreview.svelte';

  let { deviceId, stripIndex, numLeds, onClose }:
    { deviceId: string; stripIndex: number; numLeds: number; onClose: () => void } = $props();

  const FRAME_MS = 220; // must match firmware CALIB_FRAME_MS
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, numLeds))));

  let video: HTMLVideoElement;
  let stream: MediaStream | null = null;
  let points: (Pt | null)[] = $state([]);
  let snap = $state(1);
  let rectify = $state(false);
  let turns = $state(0);
  let status = $state('Point the camera at the strip, then Scan.');
  let busy = $state(false);
  let debug: DecodeDebug | null = $state(null);
  let dbgCanvas: HTMLCanvasElement | undefined = $state();

  // Tweakable decode knobs (so you can iterate without changing code).
  let calBright = $state(40);   // calibration flash brightness — LOW so LEDs don't saturate/bloom into a blob
  let relThr = $state(0.35);    // detection threshold, fraction of swing (lower = more sensitive)
  let cycles = $state(4);       // flash cycles to capture (more = robust, slower)
  let minBlobPx = $state(0);    // min pixels per LED cluster (0 = auto from strip size)
  let procWidth = $state(240);  // capture resolution (higher separates merged dots)

  // Recompute the ledmap reactively from points + controls.
  const layout = $derived.by((): Ledmap | null => {
    if (!points.length) return null;
    const src = rectify ? rectifyPoints(points) : points;
    return rotateLedmap(buildLedmap(src, snap), turns);
  });
  const decodedCount = $derived(points.filter(Boolean).length);

  onMount(() => {
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (video) { video.srcObject = stream; await video.play().catch(() => {}); }
      } catch (e: any) { status = 'Camera error: ' + (e?.message || e); }
    })();
    return () => { stream?.getTracks().forEach((t) => t.stop()); };
  });

  async function scan() {
    busy = true; points = []; debug = null;
    try {
      status = 'Calibrating + capturing (hold steady)…';
      await startCalibration(deviceId, stripIndex, calBright);
      await new Promise((r) => setTimeout(r, FRAME_MS * 2)); // let the device enter the cycle
      const res = await captureAndDecode(video, {
        bits, frameMs: FRAME_MS, cycles, relThr, minBlobPx: minBlobPx || undefined, procWidth, onLog: (m) => (status = m)
      });
      await stopCalibration(deviceId);
      debug = res.debug ?? null;
      if (!res.ok) {
        points = [];
        status = `Couldn't map: ${res.reason}`;
      } else {
        points = res.points;
        status = `Decoded ${res.points.filter(Boolean).length}/${numLeds} LEDs. Tune snap / rectify / rotation, then Use this map.`;
      }
    } catch (e: any) {
      status = 'Scan failed: ' + (e?.message || e);
      try { await stopCalibration(deviceId); } catch {}
    } finally { busy = false; }
  }

  // Draw the diagnostic: the temporal-range image (what blinked) + detected blob centroids
  // (cyan) and decoded LEDs (green, with index). Phase-independent, so it shows the truth
  // even when the decode is wrong.
  $effect(() => {
    const d = debug; const cv = dbgCanvas;
    if (!cv || !d) return;
    cv.width = d.w; cv.height = d.h;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const img = ctx.createImageData(d.w, d.h);
    for (let i = 0, j = 0; i < d.range.length; i++, j += 4) {
      const v = d.range[i]; img.data[j] = v; img.data[j + 1] = v; img.data[j + 2] = v; img.data[j + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    for (const b of d.blobs) { ctx.strokeStyle = '#00d0ff'; ctx.lineWidth = 0.7; ctx.beginPath(); ctx.arc(b.x, b.y, 2.5, 0, 6.283); ctx.stroke(); }
    for (const dd of d.decoded) { ctx.fillStyle = '#2ecc71'; ctx.beginPath(); ctx.arc(dd.x, dd.y, 1.6, 0, 6.283); ctx.fill(); }
  });

  // Record a calibration session to a .bin (exact frames the decoder sees + metadata) for
  // offline decode tuning. Format: 'CBC1', u16 w,h,bits,frameMs,numLeds,frameCount (LE),
  // then per frame: f32 t (LE) + w*h grayscale bytes.
  async function record() {
    busy = true; debug = null;
    try {
      status = 'Recording calibration (~12s, hold steady)…';
      await startCalibration(deviceId, stripIndex, calBright);
      await new Promise((r) => setTimeout(r, FRAME_MS * 2));
      const recCycles = 4;
      // The device holds OFF longer than other slots, so a cycle runs longer than nominal — capture 2× to be safe.
      const ms = (2 + bits) * FRAME_MS * recCycles * 2 + FRAME_MS;
      const frames = await captureRawFrames(video, ms, procWidth);
      await stopCalibration(deviceId);
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
      status = `Recorded ${n} frames (${w}×${h}, ${(buf.byteLength / 1e6).toFixed(1)} MB). Downloaded ${a.download}.`;
    } catch (e: any) {
      status = 'Record failed: ' + (e?.message || e);
      try { await stopCalibration(deviceId); } catch {}
    } finally { busy = false; }
  }

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

<div class="al-overlay" role="button" tabindex="-1"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }} onkeydown={() => {}}>
  <div class="al-panel">
    <header><h2>Auto-map strip {stripIndex + 1} ({numLeds} LEDs)</h2>
      <button class="al-close" aria-label="Close" onclick={onClose}>×</button></header>
    <div class="al-body">
      <div class="al-cam">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={video} playsinline muted></video>
        <div class="al-scanrow">
          <button class="btn primary" disabled={busy} onclick={scan}>{busy ? 'Scanning…' : 'Scan'}</button>
          <button class="btn" disabled={busy} onclick={record} title="Download the raw capture for offline decode tuning">⏺ Record</button>
        </div>
        {#if debug}
          <div class="al-debug">
            <canvas bind:this={dbgCanvas} class="al-dbgcanvas"></canvas>
            <div class="al-counts">
              {debug.frames} frames · {debug.roiCount} blinking px · {debug.blobs.length} blobs · {debug.decoded.length} decoded
              <br />swing {debug.maxRange}/255
            </div>
            <div class="al-legend">debug: gray = what blinked · <span style="color:#00d0ff">○</span> blob · <span style="color:#2ecc71">●</span> decoded</div>
          </div>
        {/if}
        <details class="al-settings">
          <summary>Decode settings</summary>
          <label>Flash brightness <input type="range" min="6" max="160" step="2" bind:value={calBright} /><span>{calBright} (lower = less bloom)</span></label>
          <label>Sensitivity <input type="range" min="0.1" max="0.8" step="0.05" bind:value={relThr} /><span>{relThr.toFixed(2)} (lower = detect more)</span></label>
          <label>Cycles <input type="range" min="1" max="6" step="1" bind:value={cycles} /><span>{cycles}</span></label>
          <label>Min cluster px <input type="range" min="0" max="40" step="1" bind:value={minBlobPx} /><span>{minBlobPx || 'auto'}</span></label>
          <label>Resolution <input type="range" min="120" max="480" step="20" bind:value={procWidth} /><span>{procWidth}px</span></label>
        </details>
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
  .al-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(3px);
    z-index: 3000; display: flex; align-items: center; justify-content: center; padding: 3vh 3vw; }
  .al-panel { width: 100%; max-width: 760px; max-height: 92vh; overflow-y: auto; background: #14161c;
    border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; box-shadow: 0 24px 70px rgba(0,0,0,0.7); }
  header { display: flex; align-items: center; justify-content: space-between; padding: 0.85rem 1.1rem;
    border-bottom: 1px solid rgba(255,255,255,0.1); }
  header h2 { margin: 0; font-size: 1.1rem; }
  .al-close { background: none; border: none; color: #aaa; font-size: 1.7rem; line-height: 1; cursor: pointer; }
  .al-body { display: flex; gap: 1rem; padding: 1rem 1.1rem; flex-wrap: wrap; }
  .al-cam { flex: 1 1 280px; display: flex; flex-direction: column; gap: 0.5rem; }
  .al-cam video { width: 100%; border-radius: 8px; background: #000; aspect-ratio: 4/3; object-fit: cover; }
  .al-scanrow { display: flex; gap: 0.5rem; }
  .al-scanrow .btn { flex: 1; }
  .al-controls { flex: 1 1 280px; display: flex; flex-direction: column; gap: 0.6rem; }
  .al-controls label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; }
  .al-controls label.cb { flex-direction: row; align-items: center; gap: 0.45rem; }
  .al-status { font-size: 0.85rem; opacity: 0.85; min-height: 2.4em; }
  .al-result { font-size: 0.85rem; opacity: 0.9; }
  .al-rotate { display: flex; align-items: center; gap: 0.4rem; font-size: 0.9rem; }
  .al-debug { display: flex; flex-direction: column; gap: 0.3rem; }
  .al-dbgcanvas { width: 100%; image-rendering: pixelated; background: #000; border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.15); }
  .al-counts { font-size: 0.78rem; opacity: 0.85; font-variant-numeric: tabular-nums; }
  .al-legend { font-size: 0.72rem; opacity: 0.6; }
  .al-settings { font-size: 0.85rem; }
  .al-settings summary { cursor: pointer; opacity: 0.8; }
  .al-settings label { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.4rem; }
  .al-settings label input[type='range'] { flex: 1; }
  .al-settings label span { min-width: 6.5em; text-align: right; opacity: 0.8; }
</style>
