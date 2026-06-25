<script lang="ts">
  import type { LedConfiguration, LedStripConfig } from '$lib/ble';
  import { LedChipsets, ColorOrders, uploadStripLayout, getStripLayout } from '$lib/ble';
  import { getRotation, getFlipH, getSerpentine, setRotation, setFlipH, setSerpentine } from '$lib/ble';
  import LayoutPreview from './LayoutPreview.svelte';
  import AutoLayoutModal from './AutoLayoutModal.svelte';

  let autoLayoutStrip: number | null = $state(null);

  // Parse a strip's layout JSON for the live preview (null if invalid / empty).
  function parsedLayout(index: number): { width: number; height: number; map: number[] } | null {
    try {
      const p = JSON.parse(layoutJson[index] ?? '');
      if (!Array.isArray(p.map)) return null;
      const strip = settings.ledConfig.strips[index];
      const width = p.width || strip?.width || 0;
      const height = p.height || strip?.height || 0;
      if (!width || !height) return null;
      return { width, height, map: p.map };
    } catch { return null; }
  }

  async function loadCurrentLayout(index: number) {
    layoutMsg[index] = 'Reading…';
    try {
      const r = await getStripLayout(deviceId, index);
      if (r) {
        layoutJson[index] = JSON.stringify({ width: r.width, height: r.height, map: r.map });
        layoutMsg[index] = `Loaded ${r.width}×${r.height} (${r.map.length} cells)`;
      } else {
        layoutMsg[index] = 'No layout on device (grid mapping)';
      }
    } catch (e: any) {
      layoutMsg[index] = 'Error: ' + (e?.message || e);
    }
  }

  // Per-strip arbitrary-layout (WLED ledmap) upload state.
  let layoutJson: Record<number, string> = $state({});
  let layoutMsg: Record<number, string> = $state({});

  async function applyLayout(index: number) {
    try {
      const parsed = JSON.parse(layoutJson[index] ?? '');
      if (!Array.isArray(parsed.map)) throw new Error('JSON needs a "map" array');
      const strip = settings.ledConfig.strips[index];
      const width = parsed.width || strip?.width || 0;
      const height = parsed.height || strip?.height || 0;
      if (!width || !height) throw new Error('Provide width and height');
      await uploadStripLayout(deviceId, index, { width, height, map: parsed.map });
      layoutMsg[index] = `Applied ${width}×${height} (${parsed.map.length} cells)`;
    } catch (e: any) {
      layoutMsg[index] = 'Error: ' + (e?.message || e);
    }
  }
  async function clearLayout(index: number) {
    try {
      await uploadStripLayout(deviceId, index, null);
      layoutMsg[index] = 'Layout cleared (grid mapping)';
    } catch (e: any) {
      layoutMsg[index] = 'Error: ' + (e?.message || e);
    }
  }

  // Props. `settings` is the parent's deeply-reactive $state, so binding the strip
  // inputs below mutates it directly and the UI updates in place — no manual refresh
  // callback needed.
  let {
    settings,
    deviceId,
    idPrefix = '', // '' for mobile, 'web-' for web
    onAddStrip,
    onRemoveStrip,
    onSaveConfig
  }: {
    settings: any;
    deviceId: string;
    idPrefix?: string;
    onAddStrip: (deviceId: string) => void;
    onRemoveStrip: (deviceId: string, index: number) => void;
    onSaveConfig: (deviceId: string) => void;
  } = $props();

  // Build ID with prefix
  function buildId(base: string, stripIndex?: number): string {
    const prefix = idPrefix ? `${idPrefix}-` : '';
    if (stripIndex !== undefined) {
      return `${base}-${prefix}${deviceId}-${stripIndex}`;
    }
    return `${base}-${prefix}${deviceId}`;
  }

  // --- Dimension hand-holding ---
  // numLeds / width / height start blank on a new strip. We keep width*height >= numLeds
  // and as small as possible, auto-filling whichever field the user isn't editing.
  function parseField(raw: string): number | null {
    if (raw === '') return null;
    const n = parseInt(raw, 10);
    return (isNaN(n) || n < 1) ? null : n;
  }

  function onNumLeds(strip: any, raw: string) {
    strip.numLeds = parseField(raw);
    const n = strip.numLeds;
    if (n == null) return;
    const haveWH = strip.width != null && strip.width >= 1 && strip.height != null && strip.height >= 1;
    if (!haveWH) {
      // Nothing set yet: square-ish matrix.
      strip.width = Math.ceil(Math.sqrt(n));
      strip.height = Math.ceil(n / strip.width);
    } else {
      // Keep width, grow/shrink height to just cover numLeds.
      strip.height = Math.ceil(n / strip.width);
      // A single row that's wider than needed → tighten the width to numLeds.
      if (strip.height === 1 && strip.width > n) strip.width = n;
    }
  }

  function onWidth(strip: any, raw: string) {
    strip.width = parseField(raw);
    if (strip.numLeds != null && strip.width != null) {
      strip.height = Math.ceil(strip.numLeds / strip.width);
    }
  }

  function onHeight(strip: any, raw: string) {
    strip.height = parseField(raw);
    if (strip.numLeds != null && strip.height != null) {
      strip.width = Math.ceil(strip.numLeds / strip.height);
    }
  }

  // Per-channel gain a white-balance color picks: the channel byte / 255.
  // `offset` is the hex string index of the channel (R=1, G=3, B=5).
  function gain(whitePoint: string | undefined, offset: number): string {
    const hex = whitePoint ?? '#ffffff';
    return (parseInt(hex.slice(offset, offset + 2), 16) / 255).toFixed(2);
  }
</script>

<div class="settings-section">
  <h4>LED Configuration</h4>
  {#if settings.ledConfigLoading}
    <p>Loading...</p>
  {:else if settings.ledConfig}
    <div class="led-config">
      <div class="strips-section">
        <div class="section-header">
          <h5>LED Strips ({settings.ledConfig.strips.length})</h5>
          <button class="btn primary small" onclick={() => onAddStrip(deviceId)}>Add Strip</button>
        </div>

        {#each settings.ledConfig.strips as strip, index}
          {@const pl = parsedLayout(index)}
          <div class="strip-card">
            <div class="strip-header">
              <h6>Strip {index + 1}</h6>
              <button class="btn danger small" onclick={() => onRemoveStrip(deviceId, index)} disabled={settings.ledConfig.strips.length <= 1}>Remove</button>
            </div>
            <div class="strip-controls">
              <div class="control-row">
                <label>
                  Chipset:
                  <select id={buildId('chipset', index)} name="chipset" bind:value={strip.chipset}>
                    <option value={LedChipsets.WS2812_RGB}>WS2812 RGB</option>
                    <option value={LedChipsets.SK6812_RGBW}>SK6812 RGBW</option>
                    <option value={LedChipsets.TM1814_RGBW}>TM1814 RGBW</option>
                    <option value={LedChipsets.WS2811_400KHZ}>WS2811 400KHz</option>
                    <option value={LedChipsets.TM1829_RGB}>TM1829 RGB</option>
                    <option value={LedChipsets.UCS8903_RGB}>UCS8903 RGB</option>
                    <option value={LedChipsets.UCS8904_RGBW}>UCS8904 RGBW</option>
                    <option value={LedChipsets.APA106_RGB}>APA106 RGB</option>
                    <option value={LedChipsets.FW1906_RGBCW}>FW1906 RGBCW</option>
                    <option value={LedChipsets.WS2805_RGBCW}>WS2805 RGBCW</option>
                    <option value={LedChipsets.TM1914_RGB}>TM1914 RGB</option>
                    <option value={LedChipsets.SM16825_RGBCW}>SM16825 RGBCW</option>
                  </select>
                </label>
                <label>
                  Color Order:
                  <select id={buildId('colororder', index)} name="colororder" bind:value={strip.colorOrder}>
                    <option value={ColorOrders.RGB}>RGB</option>
                    <option value={ColorOrders.RBG}>RBG</option>
                    <option value={ColorOrders.GRB}>GRB</option>
                    <option value={ColorOrders.GBR}>GBR</option>
                    <option value={ColorOrders.BRG}>BRG</option>
                    <option value={ColorOrders.BGR}>BGR</option>
                  </select>
                </label>
                <label>
                  Pin:
                  <input id={buildId('pin', index)} name="pin" type="number" min="0" max="39" bind:value={strip.pin} />
                </label>
              </div>
              <div class="control-row">
                <label>
                  LEDs:
                  <input id={buildId('numleds', index)} name="numleds" type="number" min="1" max="1000"
                    placeholder="count" value={strip.numLeds ?? ''} oninput={(e) => onNumLeds(strip, e.currentTarget.value)} />
                </label>
                <label>
                  Width:
                  <input id={buildId('width', index)} name="width" type="number" min="1" max="500"
                    placeholder="auto" value={strip.width ?? ''} oninput={(e) => onWidth(strip, e.currentTarget.value)} />
                </label>
                <label>
                  Height:
                  <input id={buildId('height', index)} name="height" type="number" min="1" max="500"
                    placeholder="auto" value={strip.height ?? ''} oninput={(e) => onHeight(strip, e.currentTarget.value)} />
                </label>
              </div>
              <div class="control-row">
                <label>
                  Rotation:
                  <select id={buildId('rotation', index)} name="rotation" value={getRotation(strip.orientation).toString()} onchange={(e) => { strip.orientation = setRotation(strip.orientation, parseInt(e.currentTarget.value)); }}>
                    <option value="0">0° (No rotation)</option>
                    <option value="1">90° Clockwise</option>
                    <option value="2">180°</option>
                    <option value="3">270° Clockwise</option>
                  </select>
                </label>
                <label class="checkbox-label">
                  <input id={buildId('flip', index)} name="flip" type="checkbox" checked={getFlipH(strip.orientation)} onchange={(e) => { strip.orientation = setFlipH(strip.orientation, e.currentTarget.checked); }} />
                  Flip Horizontally
                </label>
                <label class="checkbox-label">
                  <input id={buildId('serpentine', index)} name="serpentine" type="checkbox" checked={getSerpentine(strip.orientation)} onchange={(e) => { strip.orientation = setSerpentine(strip.orientation, e.currentTarget.checked); }} />
                  Serpentine Layout
                </label>
                <label>
                  Gamma (1.0 = none, ~2.5 max correction)
                  <input id={buildId('gamma', index)} name="gamma" type="number" min="1.0" max="3.0" step="0.1"
                    value={strip.gamma ?? 1.0} oninput={(e) => { strip.gamma = parseFloat(e.currentTarget.value) || 1.0; }} />
                </label>
                <label class="whitepoint-label">
                  White balance
                  <span class="whitepoint-row">
                    <input id={buildId('whitepoint', index)} name="whitepoint" type="color"
                      value={strip.whitePoint ?? '#ffffff'} oninput={(e) => { strip.whitePoint = e.currentTarget.value; }} />
                    <span class="whitepoint-gains">
                      White → R×{gain(strip.whitePoint, 1)} G×{gain(strip.whitePoint, 3)} B×{gain(strip.whitePoint, 5)}
                    </span>
                  </span>
                </label>
              </div>
              <details class="layout-section">
                <summary>Arbitrary layout (WLED ledmap)</summary>
                <p class="layout-hint">
                  Paste a WLED ledmap: <code>{'{ "width": W, "height": H, "map": [ledIndex per cell, -1 = gap] }'}</code>.
                  (width/height fall back to this strip's matrix size if omitted.) Sent live; max ~250 cells for now.
                </p>
                <textarea
                  class="layout-json"
                  rows="3"
                  placeholder={'{ "width": 8, "height": 4, "map": [0,1,2,...] }'}
                  bind:value={layoutJson[index]}></textarea>
                <div class="layout-actions">
                  <button class="btn primary small" onclick={() => applyLayout(index)}>Apply layout</button>
                  <button class="btn small" onclick={() => loadCurrentLayout(index)}>Load current</button>
                  <button class="btn small" onclick={() => clearLayout(index)}>Clear layout</button>
                  <button class="btn small" onclick={() => (autoLayoutStrip = index)}>📷 Auto-map (camera)</button>
                  {#if layoutMsg[index]}<span class="layout-msg">{layoutMsg[index]}</span>{/if}
                </div>
                {#if pl}
                  <LayoutPreview width={pl.width} height={pl.height} map={pl.map} />
                {/if}
              </details>
            </div>
          </div>
        {/each}
      </div>

      <button class="btn primary" onclick={() => onSaveConfig(deviceId)} disabled={settings.ledConfigLoading}>
        Save Configuration
      </button>
    </div>
  {:else}
    <p>Loading LED configuration automatically...</p>
  {/if}
</div>

{#if autoLayoutStrip !== null}
  <AutoLayoutModal
    deviceId={deviceId}
    stripIndex={autoLayoutStrip}
    numLeds={settings.ledConfig?.strips?.[autoLayoutStrip]?.numLeds ?? 0}
    onClose={() => (autoLayoutStrip = null)}
  />
{/if}

<style>
  .settings-section {
    margin-bottom: 2rem;
    padding: 1rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
  }

  .settings-section h4 {
    margin: 0 0 1rem 0;
    font-size: 1.1rem;
  }

  .led-config label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .section-header h5 {
    margin: 0;
  }

  .strip-card {
    background: rgba(255, 255, 255, 0.03);
    border-radius: 6px;
    padding: 1rem;
    margin-bottom: 1rem;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .strip-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .strip-header h6 {
    margin: 0;
  }

  .control-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1rem;
  }

  .control-row label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  /* Checkboxes read better as [box] label on one line. */
  .control-row label.checkbox-label {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
  }
  .control-row label.checkbox-label input {
    width: auto;
  }

  .control-row input,
  .control-row select {
    padding: 0.4rem;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.3);
    color: white;
    font-size: 0.9rem;
  }

  .control-row input:focus,
  .control-row select:focus {
    outline: 1px solid var(--accent-color);
    border-color: var(--accent-color);
  }

  /* White-balance: color swatch beside its computed per-channel gains. */
  .whitepoint-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .whitepoint-row input[type='color'] {
    width: 3rem;
    height: 2rem;
    padding: 0.1rem;
    cursor: pointer;
  }
  .whitepoint-gains {
    font-size: 0.8rem;
    opacity: 0.8;
    font-variant-numeric: tabular-nums;
  }

  /* Mobile responsiveness */
  @media (max-width: 768px) {
    .control-row {
      grid-template-columns: 1fr;
    }
  }
</style> 