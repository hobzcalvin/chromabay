<script lang="ts">
  import type { LedConfiguration, LedStripConfig } from '$lib/ble';
  import { LedChipsets, ColorOrders } from '$lib/ble';
  import { getRotation, getFlipH, getSerpentine, setRotation, setFlipH, setSerpentine } from '$lib/ble';

  // Props
  export let settings: any;
  export let deviceId: string;
  export let idPrefix: string = ''; // '' for mobile, 'web-' for web
  export let onAddStrip: (deviceId: string) => void;
  export let onRemoveStrip: (deviceId: string, index: number) => void;
  export let onSaveConfig: (deviceId: string) => void;
  export let onReactivityUpdate: () => void;

  // Build ID with prefix
  function buildId(base: string, stripIndex?: number): string {
    const prefix = idPrefix ? `${idPrefix}-` : '';
    if (stripIndex !== undefined) {
      return `${base}-${prefix}${deviceId}-${stripIndex}`;
    }
    return `${base}-${prefix}${deviceId}`;
  }
</script>

<div class="settings-section">
  <h4>LED Configuration</h4>
  {#if settings.ledConfigLoading}
    <p>Loading...</p>
  {:else if settings.ledConfig}
    <div class="led-config">
      <label>
        Global Brightness:
        <input type="range" min="0" max="255" bind:value={settings.ledConfig.globalBrightness} on:change={onReactivityUpdate} />
        <span>{settings.ledConfig.globalBrightness}</span>
      </label>

      <div class="strips-section">
        <div class="section-header">
          <h5>LED Strips ({settings.ledConfig.strips.length})</h5>
          <button class="btn primary small" on:click={() => onAddStrip(deviceId)}>Add Strip</button>
        </div>

        {#each settings.ledConfig.strips as strip, index}
          <div class="strip-card">
            <div class="strip-header">
              <h6>Strip {index + 1}</h6>
              <button class="btn danger small" on:click={() => onRemoveStrip(deviceId, index)} disabled={settings.ledConfig.strips.length <= 1}>Remove</button>
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
                  Pin:
                  <input id={buildId('pin', index)} name="pin" type="number" min="0" max="39" bind:value={strip.pin} />
                </label>
                <label>
                  LEDs:
                  <input id={buildId('numleds', index)} name="numleds" type="number" min="1" max="1000" bind:value={strip.numLeds} />
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
                  RMT Channel:
                  <input id={buildId('rmtchannel', index)} name="rmtchannel" type="number" min="0" max="7" bind:value={strip.rmtChannel} />
                </label>
              </div>
              <div class="control-row">
                <label>
                  Width (0 = linear):
                  <input id={buildId('width', index)} name="width" type="number" min="0" max="500" bind:value={strip.width} />
                </label>
                <label>
                  Height (0 = linear):
                  <input id={buildId('height', index)} name="height" type="number" min="0" max="500" bind:value={strip.height} />
                </label>
              </div>
              {#if strip.width > 0 && strip.height > 0}
                {@const currentRotation = getRotation(strip.orientation).toString()}
                <div class="matrix-controls">
                  <h6>Matrix Layout Settings</h6>
                  <div class="control-row">
                    <label>
                      Rotation:
                      <select id={buildId('rotation', index)} name="rotation" value={currentRotation} on:change={(e) => { strip.orientation = setRotation(strip.orientation, parseInt(e.currentTarget.value)); onReactivityUpdate(); }}>
                        <option value="0">0° (No rotation)</option>
                        <option value="1">90° Clockwise</option>
                        <option value="2">180°</option>
                        <option value="3">270° Clockwise</option>
                      </select>
                    </label>
                    <label>
                      <input id={buildId('flip', index)} name="flip" type="checkbox" checked={getFlipH(strip.orientation)} on:change={(e) => { strip.orientation = setFlipH(strip.orientation, e.currentTarget.checked); onReactivityUpdate(); }} />
                      Flip Horizontally
                    </label>
                    <label>
                      <input id={buildId('serpentine', index)} name="serpentine" type="checkbox" checked={getSerpentine(strip.orientation)} on:change={(e) => { strip.orientation = setSerpentine(strip.orientation, e.currentTarget.checked); onReactivityUpdate(); }} />
                      Serpentine Layout
                    </label>
                  </div>
                </div>
              {/if}
            </div>
          </div>
        {/each}
      </div>

      <button class="btn primary" on:click={() => onSaveConfig(deviceId)} disabled={settings.ledConfigLoading}>
        Save Configuration
      </button>
    </div>
  {:else}
    <p>Loading LED configuration automatically...</p>
  {/if}
</div>

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

  .led-config label span {
    min-width: 3rem;
    text-align: right;
    font-family: monospace;
    font-size: 0.9rem;
  }

  .led-config input[type="range"] {
    flex: 1;
    margin: 0 0.5rem;
    -webkit-appearance: none;
    appearance: none;
    height: 6px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.3);
    outline: none;
    cursor: pointer;
  }

  .led-config input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #3b82f6;
    cursor: pointer;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }

  .led-config input[type="range"]::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #3b82f6;
    cursor: pointer;
    border: none;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
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

  /* Matrix configuration styling */
  .matrix-controls {
    margin-top: 1rem;
    padding: 1rem;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .matrix-controls h6 {
    margin: 0 0 0.75rem 0;
    color: var(--accent-color);
    font-size: 0.9rem;
  }

  /* Mobile responsiveness */
  @media (max-width: 768px) {
    .control-row {
      grid-template-columns: 1fr;
    }
  }
</style> 