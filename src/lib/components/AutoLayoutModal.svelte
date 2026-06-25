<script lang="ts">
  // Camera auto-layout. Point the phone at the strip, Scan → the device flashes a coded
  // sequence, we decode each LED's position, then tune snap / rectify / rotation against a
  // live preview and upload. The CV decode (cameraDecode.ts) is a first pass to tune on HW.
  import { onMount } from 'svelte';
  import { startCalibration, stopCalibration, uploadStripLayout } from '$lib/ble';
  import { captureAndDecode } from '$lib/cameraDecode';
  import { buildLedmap, rectifyPoints, rotateLedmap, type Pt, type Ledmap } from '$lib/autoLayout';
  import LayoutPreview from './LayoutPreview.svelte';

  let { deviceId, stripIndex, numLeds, onClose }:
    { deviceId: string; stripIndex: number; numLeds: number; onClose: () => void } = $props();

  const FRAME_MS = 220; // must match firmware CALIB_FRAME_MS
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, numLeds))));

  let video: HTMLVideoElement;
  let stream: MediaStream | null = null;
  let points: Pt[] = $state([]);
  let snap = $state(1);
  let rectify = $state(false);
  let turns = $state(0);
  let status = $state('Point the camera at the strip, then Scan.');
  let busy = $state(false);

  // Recompute the ledmap reactively from points + controls.
  const layout = $derived.by((): Ledmap | null => {
    if (!points.length) return null;
    const src = rectify ? rectifyPoints(points) : points;
    return rotateLedmap(buildLedmap(src, snap), turns);
  });
  const decodedCount = $derived(points.filter((p) => p && (p.x || p.y)).length);

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
    busy = true; points = [];
    try {
      status = 'Calibrating + capturing (hold the camera steady)…';
      await startCalibration(deviceId, stripIndex);
      await new Promise((r) => setTimeout(r, FRAME_MS * 2)); // let the device enter the cycle
      const res = await captureAndDecode(video, { bits, frameMs: FRAME_MS, onLog: (m) => (status = m) });
      await stopCalibration(deviceId);
      if (!res.ok) {
        points = [];
        status = `Couldn't map: ${res.reason}. Aim so the lit strip fills the frame, hold steady, and retry.`;
      } else {
        points = res.points;
        status = `Decoded ${res.points.filter((p) => p && (p.x || p.y)).length}/${numLeds} LEDs. Tune snap / rectify / rotation, then Use this map.`;
      }
    } catch (e: any) {
      status = 'Scan failed: ' + (e?.message || e);
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
        <button class="btn primary" disabled={busy} onclick={scan}>{busy ? 'Scanning…' : 'Scan'}</button>
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
  .al-controls { flex: 1 1 280px; display: flex; flex-direction: column; gap: 0.6rem; }
  .al-controls label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; }
  .al-controls label.cb { flex-direction: row; align-items: center; gap: 0.45rem; }
  .al-status { font-size: 0.85rem; opacity: 0.85; min-height: 2.4em; }
  .al-result { font-size: 0.85rem; opacity: 0.9; }
  .al-rotate { display: flex; align-items: center; gap: 0.4rem; font-size: 0.9rem; }
</style>
