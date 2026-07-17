<script lang="ts">
  import type { LedConfiguration, LedStripConfig } from '$lib/ble';
  import { LedChipsets, ColorOrders, isFourWireChipset, uploadStripLayout, getStripLayout } from '$lib/ble';
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
                <label class="full">
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
                    <option value={LedChipsets.APA102_SPI}>APA102 / DotStar (4-wire)</option>
                    <option value={LedChipsets.SK9822_SPI}>SK9822 (4-wire)</option>
                  </select>
                </label>
              </div>
              <div class="control-row">
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
                  {isFourWireChipset(strip.chipset) ? 'Data Pin:' : 'Pin:'}
                  <input id={buildId('pin', index)} name="pin" type="number" min="0" max="39" bind:value={strip.pin} />
                </label>
                {#if isFourWireChipset(strip.chipset)}
                  <label>
                    Clock Pin:
                    <input id={buildId('clockpin', index)} name="clockpin" type="number" min="0" max="39" bind:value={strip.clockPin} />
                  </label>
                {/if}
              </div>
              <div class="control-row">
                <label>
                  LEDs:
                  <input id={buildId('numleds', index)} name="numleds" type="number" min="1" max="1000"
                    placeholder="count" value={strip.numLeds ?? ''} oninput={(e) => onNumLeds(strip, e.currentTarget.value)} />
                </label>
                <label>
                  Rotation:
                  <select id={buildId('rotation', index)} name="rotation" value={getRotation(strip.orientation).toString()} onchange={(e) => { strip.orientation = setRotation(strip.orientation, parseInt(e.currentTarget.value)); }}>
                    <option value="0">0° (No rotation)</option>
                    <option value="1">90° Clockwise</option>
                    <option value="2">180°</option>
                    <option value="3">270° Clockwise</option>
                  </select>
                </label>
              </div>
              <div class="control-row">
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
                <label class="checkbox-label">
                  <input id={buildId('flip', index)} name="flip" type="checkbox" checked={getFlipH(strip.orientation)} onchange={(e) => { strip.orientation = setFlipH(strip.orientation, e.currentTarget.checked); }} />
                  Flip Horizontally
                </label>
                <label class="checkbox-label">
                  <input id={buildId('serpentine', index)} name="serpentine" type="checkbox" checked={getSerpentine(strip.orientation)} onchange={(e) => { strip.orientation = setSerpentine(strip.orientation, e.currentTarget.checked); }} />
                  Serpentine Layout
                </label>
              </div>
              <details class="sub-section">
                <summary>Color correction</summary>
                <div class="control-row">
                  <label>
                    Gamma (1.0 = none, ~2.5 max)
                    <input id={buildId('gamma', index)} name="gamma" type="number" min="1.0" max="3.0" step="0.1"
                      value={strip.gamma ?? 1.0} oninput={(e) => { strip.gamma = parseFloat(e.currentTarget.value) || 1.0; }} />
                  </label>
                  <label class="whitepoint-label">
                    White balance
                    <span class="whitepoint-row">
                      <input id={buildId('whitepoint', index)} name="whitepoint" type="color"
                        value={strip.whitePoint ?? '#ffffff'} oninput={(e) => { strip.whitePoint = e.currentTarget.value; }} />
                      <span class="whitepoint-gains">
                        R×{gain(strip.whitePoint, 1)} G×{gain(strip.whitePoint, 3)} B×{gain(strip.whitePoint, 5)}
                      </span>
                    </span>
                  </label>
                  <label class="checkbox-label">
                    <input id={buildId('dither', index)} name="dither" type="checkbox"
                      checked={strip.dither ?? true} onchange={(e) => { strip.dither = e.currentTarget.checked; }} />
                    Temporal dithering (smoother low brightness; auto-enables only on small/fast strips)
                  </label>
                </div>
              </details>
              <details class="sub-section">
                <summary>Custom Layout</summary>
                <p class="layout-hint">
                  Paste a layout map: <code>{'{ "width": W, "height": H, "map": [ledIndex per cell, -1 = gap] }'}</code>.
                  (width/height fall back to this strip's matrix size if omitted.) Sent live; max ~250 cells for now.
                </p>
                <textarea
                  class="layout-json"
                  rows="3"
                  placeholder={'{ "width": 8, "height": 4, "map": [0,1,2,...] }'}
                  bind:value={layoutJson[index]}></textarea>
                <div class="layout-actions">
                  <button class="btn primary small" onclick={() => applyLayout(index)}>Apply layout</button>
                  <button class="btn secondary small" onclick={() => loadCurrentLayout(index)}>Load current</button>
                  <button class="btn secondary small" onclick={() => clearLayout(index)}>Clear layout</button>
                  <button class="btn secondary small" onclick={() => (autoLayoutStrip = index)}>📷 Auto-map (camera)</button>
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
  /* Buttons match the devices page. Svelte scopes styles per-file, so this component
     needs its own copy of the .btn rules (the page's don't reach in here). Keep in sync
     with the .btn block in src/routes/devices/+page.svelte. */
  .btn {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 8px;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s ease;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .btn.primary {
    background: linear-gradient(135deg, #3b82f6, #1d4ed8);
    color: white;
  }

  .btn.secondary {
    background: rgba(255, 255, 255, 0.1);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.3);
  }

  .btn.danger {
    background: linear-gradient(135deg, #ef4444, #dc2626);
    color: white;
  }

  .btn.small {
    padding: 0.5rem 1rem;
    font-size: 0.8rem;
  }

  .btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* A section of the device blob — a header + content, not a nested card. */
  .settings-section {
    margin: 0;
    padding: 1.25rem 0 0;
    border-top: 1px solid rgba(255, 255, 255, 0.12);
  }

  .settings-section h4 {
    margin: 0 0 1rem 0;
    font-size: 1.05rem;
    opacity: 0.95;
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

  /* Two compact fields per row so they fit a narrow phone screen without overflowing. */
  .control-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem 1rem;
    margin-bottom: 0.75rem;
    align-items: end;
  }

  /* A field that should take the whole row (e.g. the long Chipset dropdown). */
  .control-row label.full {
    grid-column: 1 / -1;
  }

  .control-row label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    font-size: 0.85rem;
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
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    padding: 0.4rem;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.3);
    color: white;
    font-size: 0.9rem;
  }

  /* Checkboxes are auto-width, sitting inline with their label text. */
  .control-row label.checkbox-label input {
    width: auto;
  }

  /* Collapsible sub-sections (Color correction, Custom Layout). */
  .sub-section {
    margin-top: 0.75rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    padding-top: 0.5rem;
  }
  .sub-section summary {
    cursor: pointer;
    font-size: 0.9rem;
    opacity: 0.85;
    padding: 0.25rem 0;
  }
  .sub-section[open] summary {
    margin-bottom: 0.5rem;
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

  /* Keep two columns on phones too (the whole point — fields shouldn't each get
     their own line); just tighten the gaps. */
  @media (max-width: 768px) {
    .control-row {
      gap: 0.6rem 0.6rem;
    }
  }
</style> 