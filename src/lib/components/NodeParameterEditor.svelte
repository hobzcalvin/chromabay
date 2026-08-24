<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { getNodeDefinition, setNodeParameter, getNodeParameter, deleteNode, nodeParameters, type Parameter } from '../flowStore';
  import { getParameterInteractive, setParameterInteractive, MAX_INTERACTIVE_PARAMS, interactiveParameters } from '../stores/interactiveStore';
  import { modulators, getModulator, setModulator, clearModulator, modulatorSeed, SHAPES, type ModulatorConfig, type ModField } from '../stores/modulatorStore';
  import { flattenSvgPath, encodedToPath, PRESETS } from '../svgFlatten';
  import ColorWheel from './ColorWheel.svelte';
  import { findColorGroups, colorGroupOwned, hexToHueSat, hueSatToHex, type ColorGroup } from '../color';
  import type { Node } from '@xyflow/svelte';

  export let node: Node;
  export let onClose: () => void;
  // Changed to const as per svelte-check warning if only for external reference / initial value
  export const nodeElement: HTMLElement = undefined as any; // Initialized by parent
  export const viewport: { x: number; y: number; zoom: number } = { x: 0, y: 0, zoom: 1 }; // Initialized by parent
  export let visible: boolean = true;
  export let top: number | undefined = undefined;
  export let left: number | undefined = undefined;
  // Caret: points at the node the popover belongs to. caretX/caretY are the node centre (screen
  // px); caretSide is the direction the caret points (chosen by the editor's placement).
  export let caretX: number | undefined = undefined;
  export let caretY: number | undefined = undefined;
  export let caretSide: 'top' | 'bottom' | 'left' | 'right' | undefined = undefined;
  // Max height the editor allotted for this placement (the free space on the chosen side, so the
  // popover expands to fill it without overlapping the node). Falls back to the full column.
  export let maxHeight: number | undefined = undefined;
  export let right: number | undefined = undefined;
  export let bottom: number | undefined = undefined;
  export let deleteConfirmState: boolean = false;
  export let deleteTimeout: ReturnType<typeof setTimeout> | undefined = undefined;

  let popoverElement: HTMLElement;
  $: nodeDefinition = getNodeDefinition(node.data.type as string);
  
  // Reactive helper to get interactive state (subscribes to store changes)
  $: getParameterInteractiveReactive = (nodeId: string, paramName: string): boolean => {
    const nodeParams = $interactiveParameters.get(nodeId);
    if (nodeParams?.has(paramName)) {
      return nodeParams.get(paramName) || false;
    }
    return false;
  };

  // Calculate popover position
  function getPopoverPosition() {
    // Use provided position props, fallback to fixed position on the left side of screen
    return { 
      top: top ?? 80, 
      left: left ?? 20,
      right: right,
      bottom: bottom
    };
  }

  // Keep the popover fully on-screen. The parent anchors it below the node, but its height changes
  // (e.g. opening the taller automation panel), so we clamp its top/left to its ACTUAL measured
  // size on every resize — sliding it up/left as needed. Only when it's taller than the whole
  // viewport does the CSS max-height + scroll kick in. clampedTop/Left override the anchor once
  // measured; null until then.
  let clampedTop: number | null = null;
  let clampedLeft: number | null = null;
  let clampedMaxH: number | null = null;
  let caretStyle: string | null = null; // absolute position for the caret (px), or null to hide
  let resizeObserver: ResizeObserver | null = null;

  // Intersect the viewport with every overflow-clipping ancestor (the flow canvas has
  // `overflow: hidden`). Chrome clips this position:fixed popover to that region even though
  // no ancestor is its containing block, so clamping to the WINDOW isn't enough — it'd still
  // be cut off at the canvas edge. We clamp to the real visible box instead.
  function visibleBounds() {
    let top = 0, left = 0, right = window.innerWidth, bottom = window.innerHeight;
    for (let a = popoverElement?.parentElement; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        const r = a.getBoundingClientRect();
        top = Math.max(top, r.top); left = Math.max(left, r.left);
        right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
      }
    }
    return { top, left, right, bottom };
  }

  function clampToViewport() {
    if (!popoverElement || !visible || typeof window === 'undefined') return;
    const m = 8; // margin inside the visible box
    const b = visibleBounds();
    const p = getPopoverPosition();
    // Height is the editor's allotment for the chosen side (the free space beside/above/below the
    // node); fall back to the full visible column. Content scrolls past the cap.
    const availH = maxHeight ?? Math.max(160, (b.bottom - b.top) - 2 * m);
    clampedMaxH = availH;
    const r = popoverElement.getBoundingClientRect();
    const h = Math.min(r.height, availH); // effective height once max-height applies
    if (p.top !== undefined) clampedTop = Math.max(b.top + m, Math.min(p.top, b.bottom - h - m));
    if (p.left !== undefined) clampedLeft = Math.max(b.left + m, Math.min(p.left, b.right - r.width - m));
    // Caret sits on the popover edge nearest the node, offset to line up with the node centre
    // (clamped inside the rounded corners). Position depends on which side the editor chose.
    const fLeft = clampedLeft ?? p.left ?? 0;
    const fTop = clampedTop ?? p.top ?? 0;
    if (caretSide && (caretX != null || caretY != null)) {
      if (caretSide === 'top' || caretSide === 'bottom') {
        const cx = Math.max(14, Math.min((caretX ?? fLeft) - fLeft, r.width - 14));
        const y = caretSide === 'top' ? fTop - 8 : fTop + r.height - 1;
        caretStyle = `left: ${fLeft + cx - 8}px; top: ${y}px;`;
      } else {
        const cy = Math.max(14, Math.min((caretY ?? fTop) - fTop, r.height - 14));
        const x = caretSide === 'left' ? fLeft - 8 : fLeft + r.width - 1;
        caretStyle = `top: ${fTop + cy - 8}px; left: ${x}px;`;
      }
    } else {
      caretStyle = null;
    }
  }
  // NOTE: these MUST be reactive `$:` values, not functions. The style attribute below reads
  // `effTop`/`effLeft`; Svelte only re-renders it when identifiers it references change. A
  // function call `effTop()` hides `clampedTop` inside the body, so updating clampedTop would
  // never repaint the DOM (the clamp ran but the popover never moved — a bug we hit before).
  $: effTop = clampedTop ?? top ?? 80;
  $: effLeft = clampedLeft ?? left ?? 20;
  $: effMaxH = clampedMaxH ?? maxHeight ?? null;

  // Re-clamp after any content/anchor change (tick lets the DOM settle first). The ResizeObserver
  // (set up in onMount) covers content-driven size changes like opening the automation panel.
  $: if (visible && (top || left || caretX || caretY || caretSide || maxHeight || node || automating)) tick().then(clampToViewport);

  function getParameterValue(param: Parameter): any {
    const nodeParams = $nodeParameters.get(node.id);
    if (nodeParams && nodeParams.has(param.name)) {
      return nodeParams.get(param.name);
    }
    return param.default;
  }

  function updateParameter(param: Parameter, value: any) {
    setNodeParameter(node.id, param.name, value);

    // Transform's scale lock is a UI constraint, not a renderer shortcut: either scale slider
    // becomes the master while locked and the paired stored value follows it. Keeping both
    // values equal also means unlocking starts from the exact shape currently on screen.
    if (node.data.type === 'transform' && (param.name === 'scaleX' || param.name === 'scaleY')) {
      const def = nodeDefinition?.params.find((p) => p.name === 'lockScale');
      const locked = Number($nodeParameters.get(node.id)?.get('lockScale') ?? def?.default ?? 1) !== 0;
      if (locked) setNodeParameter(node.id, param.name === 'scaleX' ? 'scaleY' : 'scaleX', value);
    }
  }

  // Double-click / double-tap a slider to snap it back to the operator's default.
  function resetParam(param: Parameter) {
    setNodeParameter(node.id, param.name, param.default);
  }

  // SVG Fill: the `path` param stores a flattened polygon blob, not the raw SVG. The user
  // pastes a `d` string or picks a preset; we flatten in-browser and store the blob.
  let svgText = '';
  // Seed the paste field from the stored path when the popover opens for a new svgfill node,
  // so it shows the current shape (as flattened polygons) instead of being blank. Only re-seeds
  // when the node changes — typing mutates svgText without being clobbered.
  let svgInitFor = '';
  $: if (node?.data?.type === 'svgfill' && svgInitFor !== node.id) {
    svgInitFor = node.id;
    const pathParam = nodeDefinition?.params.find((p) => p.name === 'path');
    const stored = pathParam ? getParameterValue(pathParam) : '';
    svgText = typeof stored === 'string' ? encodedToPath(stored) : '';
  }
  function applySvgPath(param: Parameter, d: string) {
    try { const enc = flattenSvgPath(d); if (enc.length > 2) updateParameter(param, enc); } catch { /* ignore bad paths */ }
  }
  function applySvgPreset(param: Parameter, name: string) {
    if (!name || !(name in PRESETS)) return;
    svgText = PRESETS[name];
    applySvgPath(param, PRESETS[name]);
  }

  function handleRangeChange(param: Parameter, event: Event) {
    const input = event.target as HTMLInputElement;
    const value = param.type === 'integer' ? parseInt(input.value) : parseFloat(input.value);
    updateParameter(param, value);
  }

  function handleBooleanChange(param: Parameter, event: Event) {
    const input = event.target as HTMLInputElement;
    updateParameter(param, input.checked ? 1 : 0);
    // On locking, make X authoritative immediately so the two visible sliders agree.
    if (node.data.type === 'transform' && param.name === 'lockScale' && input.checked) {
      const scaleX = nodeDefinition?.params.find((p) => p.name === 'scaleX');
      const x = scaleX ? getParameterValue(scaleX) : 1;
      setNodeParameter(node.id, 'scaleY', x);
    }
  }

  function handleSelectChange(param: Parameter, event: Event) {
    const select = event.target as HTMLSelectElement;
    // A SELECT is an enum: its option values ARE the integer index (see flowStore
    // convertWasmParameter). Store a number so it travels over the wire as an int.
    updateParameter(param, parseInt(select.value, 10));
  }

  function handleDeleteNode() {
    // Don't allow deletion of output node
    if (node.data.type === 'output') {
      return;
    }
    
    if (!deleteConfirmState) {
      // First click - show "Really?" state
      deleteConfirmState = true;
      
      // Reset after 3 seconds if not clicked again
      clearTimeout(deleteTimeout);
      deleteTimeout = setTimeout(() => {
        deleteConfirmState = false;
      }, 3000);
    } else {
      // Second click - actually delete
      clearTimeout(deleteTimeout);
      deleteConfirmState = false;
      
      // Delete the node (this will handle rewiring automatically)
      deleteNode(node.id);
      
      // Close the parameter editor
      onClose();
    }
  }

  // Reset all params to their operator defaults (+ clear any automation). Two-click "Really?"
  // confirm, mirroring Delete, since it's destructive to the node's tuning.
  let resetConfirmState = false;
  let resetTimeout: ReturnType<typeof setTimeout> | undefined;
  function handleResetNode() {
    if (!resetConfirmState) {
      resetConfirmState = true;
      clearTimeout(resetTimeout);
      resetTimeout = setTimeout(() => { resetConfirmState = false; }, 3000);
    } else {
      clearTimeout(resetTimeout);
      resetConfirmState = false;
      if (nodeDefinition) {
        for (const p of nodeDefinition.params) {
          setNodeParameter(node.id, p.name, p.default);
          clearModulator(node.id, p.name);
        }
      }
      svgText = '';
    }
  }

  function handleClose() {
    // Cleanup is now handled by the parent component
    onClose();
  }

  function handleDocumentClick(event: MouseEvent) {
    if (popoverElement && event.target && !popoverElement.contains(event.target as Element)) {
      handleClose();
    }
  }

  onMount(() => {
    // Add backdrop click handler
    document.addEventListener('click', handleDocumentClick);
    modRaf = requestAnimationFrame(tickLive); // drive the automated-slider thumbs
    // Re-fit whenever the popover's size changes (e.g. opening the automation panel).
    resizeObserver = new ResizeObserver(() => clampToViewport());
    if (popoverElement) resizeObserver.observe(popoverElement);
    clampToViewport();

    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  });

  onDestroy(() => {
    clearTimeout(deleteTimeout);
    cancelAnimationFrame(modRaf);
    resizeObserver?.disconnect();
  });

  function getUniqueInputId(paramName: string): string {
    return `param-input-${node.id}-${paramName}`;
  }

  function handleInteractiveToggle(param: Parameter, event: Event) {
    const checkbox = event.target as HTMLInputElement;
    const wantsInteractive = checkbox.checked;

    const success = setParameterInteractive(node.id, param.name, wantsInteractive);

    if (!success) {
      // Revert the checkbox state
      checkbox.checked = false;
      // Show error message
      alert(`Maximum of ${MAX_INTERACTIVE_PARAMS} interactive parameters allowed. Please uncheck other parameters first.`);
    } else if (wantsInteractive) {
      // Interactive and automated are mutually exclusive.
      clearModulator(node.id, param.name);
    }
  }

  // ---- Parameter automation (LFO / noise / random) ----
  let automating: Parameter | null = null;              // param whose automation sub-panel is open
  let liveValues: Record<string, number> = {};          // live modulated value per param (moving thumb)
  let modRaf = 0;

  const SLIDER_TYPES = new Set(['float', 'integer', 'range', 'hue']);
  const isSlider = (p: Parameter) => SLIDER_TYPES.has(p.type as string);
  // Interactive (a knob on the Interact page) also works for enums — the knob steps through the
  // options. Automation (an LFO) still only makes sense for a continuous slider.
  const canInteract = (p: Parameter) => isSlider(p) || (p.type as string) === 'select' || p.type === 'color';

  // Every colour an operator exposes gets the same wheel: a "#rrggbb" COLOR param, a hue+sat
  // pair, or a prefixed set like Gradient's start_/end_. A group's *_val keeps its own slider
  // (the wheel has no brightness axis) and the hue param stays automatable underneath.
  $: colorGroups = nodeDefinition ? findColorGroups(nodeDefinition.params) : [];
  $: colorOwned = colorGroupOwned(colorGroups);
  // Where the wheel sits now, in hue/sat terms, whichever way the operator spells its colour.
  function wheelPos(g: ColorGroup): { hue: number; sat: number } {
    if (g.hex) return hexToHueSat(getParameterValue(g.hex));
    return { hue: Number(getParameterValue(g.hue!)), sat: Number(getParameterValue(g.sat!)) };
  }
  function setWheel(g: ColorGroup, hue: number, sat: number) {
    if (g.hex) { updateParameter(g.hex, hueSatToHex(hue, sat)); return; }
    if (g.hue) updateParameter(g.hue, hue);
    if (g.sat) updateParameter(g.sat, sat);
  }
  // Convolve: the 9 kernel cells (k1..k9) are edited in a 3×3 grid, not as 9 sliders. Hide
  // them from the normal list, and show the grid only under the "Custom" preset (index 0).
  $: isConvolve = node?.data?.type === 'convolve';
  $: kernelParams = isConvolve && nodeDefinition ? nodeDefinition.params.filter((p) => /^k[1-9]$/.test(p.name)) : [];
  $: presetParam = isConvolve && nodeDefinition ? (nodeDefinition.params.find((p) => p.name === 'preset') ?? null) : null;
  $: convolveCustom = isConvolve && presetParam
    ? String($nodeParameters.get(node.id)?.get('preset') ?? presetParam.default ?? 1) === '0'
    : false;
  // Plain params first; the colour wheels (each with its own value slider under it) render
  // after them, because a param declared after a colour would otherwise sit below a tall wheel.
  $: visibleParams = nodeDefinition
    ? nodeDefinition.params.filter((p) => {
        if (colorOwned.has(p.name)) return false;                  // shown in / under a wheel
        if (isConvolve && /^k[1-9]$/.test(p.name)) return false;   // shown in the kernel grid
        return true;
      })
    : [];
  // Reactive modulator lookup (subscribes to the store).
  $: getModReactive = (paramName: string): ModulatorConfig | null => $modulators.get(node.id)?.get(paramName) ?? null;

  function paramRange(p: Parameter) { return { lo: p.min ?? 0, hi: p.max ?? ((p.type === 'hue') ? 255 : 1) }; }

  function openAutomation(param: Parameter) {
    if (!getModulator(node.id, param.name)) {
      const { lo, hi } = paramRange(param);
      setModulator(node.id, param.name, { shape: 0, min: lo, max: hi, period: 5 });
      if (getParameterInteractive(node.id, param.name)) setParameterInteractive(node.id, param.name, false); // exclusive
    }
    automating = param;
  }
  function stopAutomation(param: Parameter) { clearModulator(node.id, param.name); automating = null; }
  function updateMod(param: Parameter, patch: Partial<ModulatorConfig>) {
    const cur = getModulator(node.id, param.name); if (!cur) return;
    setModulator(node.id, param.name, { ...cur, ...patch });
  }
  // Any automation field (envelope/min/max/period) can be exposed as its own live control
  // on the Interact page. These toggle membership in the modulator's `interactive` set.
  function modInteractive(cfg: ModulatorConfig | null | undefined, field: ModField): boolean {
    return !!cfg?.interactive?.includes(field);
  }
  function toggleModInteractive(param: Parameter, field: ModField) {
    const cur = getModulator(node.id, param.name); if (!cur) return;
    const set = new Set(cur.interactive ?? []);
    if (set.has(field)) set.delete(field); else set.add(field);
    updateMod(param, { interactive: Array.from(set) });
  }

  // Tiny SVG waveform for each shape (viewBox 0 0 32 14).
  function shapePath(s: number): string {
    switch (s) {
      case 0: return 'M0 7 Q4 0 8 7 T16 7 T24 7 T32 7';                 // sine
      case 1: return 'M0 13 L8 1 L16 13 L24 1 L32 13';                  // triangle
      case 2: return 'M0 13 L14 1 L14 13 L28 1 L28 13';                 // sawtooth
      case 3: return 'M0 13 L0 1 L16 1 L16 13 L32 13 L32 1';            // square
      case 4: return 'M0 10 L8 10 L8 3 L16 3 L16 13 L24 13 L24 6 L32 6';// random
      case 5: return 'M0 8 Q6 3 12 7 T24 6 T32 9';                      // perlin
      default: return 'M0 7 L32 7';
    }
  }

  // Live value for the moving thumb — evaluated via the shared WASM math (same as preview+device).
  function tickLive() {
    const m: any = (typeof window !== 'undefined') ? (window as any).getWasmModule?.() : null;
    const nodeMods = $modulators.get(node.id);
    if (m && nodeMods && nodeMods.size && nodeDefinition) {
      const t = Math.floor(performance.now()) % 1000000;
      for (const p of nodeDefinition.params) {
        const cfg = nodeMods.get(p.name);
        // Same per-instance seed the preview + device use, so the thumb readout matches.
        if (cfg) liveValues[p.name] = m.ccall('evalModulator', 'number',
          ['number','number','number','number','number','number'], [cfg.shape, cfg.min, cfg.max, cfg.period, t, modulatorSeed(node.id, p.name)]);
      }
      liveValues = liveValues; // reactivity
    }
    modRaf = requestAnimationFrame(tickLive);
  }
</script>

<!-- Caret pointing at the node. A sibling (not a child) because the popover clips overflow. -->
{#if visible && caretStyle}
  <div class="popover-caret caret-{caretSide}" style="position: fixed; {caretStyle}"></div>
{/if}

<div
  bind:this={popoverElement}
  class="parameter-popover"
  style="position: fixed; top: {effTop}px; left: {effLeft}px; max-height: {effMaxH ? effMaxH + 'px' : 'calc(100vh - 16px)'}; visibility: {visible ? 'visible' : 'hidden'}; opacity: {visible ? '1' : '0'}; transition: opacity 0.2s ease;"
  onclick={(e) => e.stopPropagation()}
  onkeydown={(e) => e.stopPropagation()}
  role="dialog"
  aria-labelledby="popover-header-title"
  tabindex="-1"
>
  <div class="popover-header">
    <h3 id="popover-header-title">{node.data.label} Parameters</h3>
    <div class="header-buttons">
      {#if node.data.type !== 'output'}
        <button
          class="reset-btn"
          class:reset-confirm={resetConfirmState}
          onclick={handleResetNode}
        >
          {resetConfirmState ? 'Really?' : 'Reset'}
        </button>
        <button
          class="delete-btn"
          class:delete-confirm={deleteConfirmState}
          onclick={handleDeleteNode}
        >
          {deleteConfirmState ? 'Really?' : 'Delete'}
        </button>
      {/if}
      <button class="close-btn" onclick={handleClose} aria-label="Close parameter editor">×</button>
    </div>
  </div>
  
  <div class="popover-content">
    {#if automating}
      {@const p = automating}
      {@const cfg = getModReactive(p.name)}
      <div class="automation-panel">
        <button type="button" class="back-btn" onclick={() => (automating = null)}>← Back</button>
        <h4 class="auto-title">Automate: {p.label}</h4>
        {#if cfg}
          {#snippet handBtn(field: ModField)}
            <span class="interactive-checkbox">
              <input type="checkbox" id="mod-iv-{p.name}-{field}" checked={modInteractive(cfg, field)} onchange={() => toggleModInteractive(p, field)} />
              <label for="mod-iv-{p.name}-{field}" class="hand-emoji" title="Interactive">🖐️</label>
            </span>
          {/snippet}
          <div class="mod-field"><span class="mod-label">Envelope {@render handBtn('shape')}</span></div>
          <div class="shape-grid">
            {#each SHAPES as name, si}
              <button type="button" class="shape-btn" class:sel={cfg.shape === si} title={name} onclick={() => updateMod(p, { shape: si })}>
                <svg viewBox="0 0 32 14" width="36" height="16" aria-hidden="true"><path d={shapePath(si)} fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
                <span>{name}</span>
              </button>
            {/each}
          </div>
          <!-- Min/Max are sliders over the SAME range as the parameter being automated (so you
               can't type an invalid/blank value or a stray "-", which used to NaN-break the
               operator). For a hue param this is just a 0–255 hue range. -->
          {@const rng = paramRange(p)}
          {@const mstep = Math.max((rng.hi - rng.lo) / 100, 1e-6)}
          <div class="mod-field"><span class="mod-label">Min {@render handBtn('min')}</span>
            <input type="range" min={rng.lo} max={rng.hi} step={mstep} value={cfg.min}
              oninput={(e) => updateMod(p, { min: parseFloat(e.currentTarget.value) })} />
            <span class="mod-val">{(+cfg.min).toFixed(2)}</span></div>
          <div class="mod-field"><span class="mod-label">Max {@render handBtn('max')}</span>
            <input type="range" min={rng.lo} max={rng.hi} step={mstep} value={cfg.max}
              oninput={(e) => updateMod(p, { max: parseFloat(e.currentTarget.value) })} />
            <span class="mod-val">{(+cfg.max).toFixed(2)}</span></div>
          <div class="mod-field"><span class="mod-label">Period (s) {@render handBtn('period')}</span> <input type="number" min="0.1" step="0.1" value={cfg.period} oninput={(e) => updateMod(p, { period: Math.max(0.1, parseFloat(e.currentTarget.value) || 0.1) })} /></div>
          <button type="button" class="stop-btn" onclick={() => stopAutomation(p)}>Stop automating</button>
        {/if}
      </div>
    {:else if nodeDefinition && nodeDefinition.params.length > 0}
      <!-- One row per parameter. Rendered from the list below, and again for the value slider
           that belongs under a colour wheel. -->
      {#snippet paramRow(param: Parameter)}
        {@const inputId = getUniqueInputId(param.name)}
        <div class="parameter-group">
          <div class="parameter-header">
            <label class="parameter-label" for={inputId}>{param.label}</label>
            <!-- Interact (🖐️) works for sliders AND enums (knob steps the options); Automate (🔄)
                 is slider-only (an LFO can't sensibly drive a bool/string/color). -->
            {#if canInteract(param)}
              <div class="interactive-checkbox">
                <input
                  type="checkbox"
                  id="interactive-{inputId}"
                  checked={getParameterInteractiveReactive(node.id, param.name)}
                  onchange={(e) => handleInteractiveToggle(param, e)}
                />
                <label for="interactive-{inputId}" class="hand-emoji" title="Interactive parameter (shows knob on interact page)">🖐️</label>
              </div>
            {/if}
            {#if isSlider(param)}
              <button type="button" class="automate-btn" class:active={!!getModReactive(param.name)}
                title="Automate this parameter (LFO / noise / random)" onclick={() => openAutomation(param)}>🔄</button>
            {/if}
          </div>
          
          {#if isSlider(param) && getModReactive(param.name)}
            {@const cfg = getModReactive(param.name)!}
            <div class="automated-control" role="button" tabindex="0" title="Edit automation"
              onclick={() => openAutomation(param)} onkeydown={(e) => { if (e.key === 'Enter') openAutomation(param); }}>
              <input type="range" min={param.min ?? 0} max={param.max ?? (param.type === 'hue' ? 255 : 1)} step="any"
                value={liveValues[param.name] ?? cfg.min} disabled />
              <span class="auto-tag">🔄 {SHAPES[cfg.shape]} · {(+cfg.min).toFixed(1)}–{(+cfg.max).toFixed(1)} · {cfg.period}s</span>
            </div>
          {:else if param.type === 'float'}
            <div class="float-control">
              <input
                id={inputId}
                type="range"
                min={param.min ?? 0}
                max={param.max ?? 1}
                step={((param.max ?? 1) - (param.min ?? 0)) / 100}
                value={getParameterValue(param)}
                title="Double-click to reset to default"
                oninput={(e) => handleRangeChange(param, e)}
                onchange={(e) => handleRangeChange(param, e)}
                ondblclick={() => resetParam(param)}
                ontouchstart={(e) => e.stopPropagation()}
                ontouchmove={(e) => e.stopPropagation()}
                ontouchend={(e) => e.stopPropagation()}
              />
              <span class="value-display">{getParameterValue(param).toFixed(2)}</span>
            </div>
          {:else if param.type === 'boolean'}
            <div class="boolean-control">
              <input
                id={inputId}
                type="checkbox"
                checked={Number(getParameterValue(param)) !== 0}
                onchange={(e) => handleBooleanChange(param, e)}
                ontouchstart={(e) => e.stopPropagation()}
              />
            </div>
          {:else if param.type === 'range'}
            <div class="range-control">
              <input
                id={inputId}
                type="range"
                min={param.min || 0}
                max={param.max || 100}
                step="1"
                value={getParameterValue(param)}
                title="Double-click to reset to default"
                oninput={(e) => handleRangeChange(param, e)}
                onchange={(e) => handleRangeChange(param, e)}
                ondblclick={() => resetParam(param)}
                ontouchstart={(e) => e.stopPropagation()}
                ontouchmove={(e) => e.stopPropagation()}
                ontouchend={(e) => e.stopPropagation()}
              />
              <span class="value-display">{getParameterValue(param)}</span>
            </div>
          {:else if param.type === 'integer'}
            <div class="integer-control">
              <input
                id={inputId}
                type="range"
                min={param.min || 0}
                max={param.max || 100}
                step="1"
                value={getParameterValue(param)}
                title="Double-click to reset to default"
                oninput={(e) => handleRangeChange(param, e)}
                onchange={(e) => handleRangeChange(param, e)}
                ondblclick={() => resetParam(param)}
                ontouchstart={(e) => e.stopPropagation()}
                ontouchmove={(e) => e.stopPropagation()}
                ontouchend={(e) => e.stopPropagation()}
              />
              <span class="value-display">{getParameterValue(param)}</span>
            </div>
          {:else if param.type === 'hue'}
            <div class="hue-control">
              <input
                id={inputId}
                type="range"
                min="0"
                max="360"
                step="1"
                value={getParameterValue(param)}
                title="Double-click to reset to default"
                oninput={(e) => handleRangeChange(param, e)}
                onchange={(e) => handleRangeChange(param, e)}
                ondblclick={() => resetParam(param)}
                ontouchstart={(e) => e.stopPropagation()}
                ontouchmove={(e) => e.stopPropagation()}
                ontouchend={(e) => e.stopPropagation()}
                style="background: linear-gradient(to right, 
                  hsl(0, 100%, 50%), hsl(60, 100%, 50%), hsl(120, 100%, 50%), 
                  hsl(180, 100%, 50%), hsl(240, 100%, 50%), hsl(300, 100%, 50%), 
                  hsl(360, 100%, 50%));"
              />
              <span class="value-display">{getParameterValue(param)}°</span>
            </div>
          {:else if param.type === 'select'}
            <div class="select-control">
              <select
                id={inputId}
                value={String(getParameterValue(param))}
                onchange={(e) => handleSelectChange(param, e)}
              >
                {#if param.options}
                  {#each param.options as option (option.value)}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                {/if}
              </select>
            </div>
          {:else if param.type === 'string'}
            {#if node.data.type === 'svgfill' && param.name === 'path'}
              <div class="svg-input">
                <select class="svg-preset" onchange={(e) => applySvgPreset(param, (e.currentTarget as HTMLSelectElement).value)}>
                  <option value="">Preset…</option>
                  {#each Object.keys(PRESETS) as name}<option value={name}>{name}</option>{/each}
                </select>
                <textarea
                  class="svg-d"
                  rows="3"
                  placeholder="Paste an SVG path (the d=&quot;…&quot; value)"
                  bind:value={svgText}
                  oninput={() => applySvgPath(param, svgText)}
                ></textarea>
              </div>
            {:else}
              <input
                id={inputId}
                class="text-input"
                type="text"
                maxlength="4096"
                value={String(getParameterValue(param) ?? '')}
                oninput={(e) => updateParameter(param, (e.target as HTMLInputElement).value)}
              />
            {/if}
          {/if}
        </div>
      {/snippet}

      {#each visibleParams as param (param.name)}
        {@render paramRow(param)}
      {/each}

      {#each colorGroups as g (g.key)}
        {@const pos = wheelPos(g)}
        {@const anchor = g.hue ?? g.hex}
        {@const hueMod = g.hue ? getModReactive(g.hue.name) : null}
        <div class="parameter-group">
          <div class="parameter-header">
            <span class="parameter-label">{g.label}</span>
            {#if anchor && canInteract(anchor)}
              <div class="interactive-checkbox">
                <input
                  type="checkbox"
                  id="interactive-{getUniqueInputId(g.key)}"
                  checked={getParameterInteractiveReactive(node.id, anchor.name)}
                  onchange={(e) => handleInteractiveToggle(anchor, e)}
                />
                <label for="interactive-{getUniqueInputId(g.key)}" class="hand-emoji" title="Interactive parameter (shows colour wheel on interact page)">🖐️</label>
              </div>
            {/if}
            {#if g.hue}
              <button type="button" class="automate-btn" class:active={!!hueMod}
                title="Automate the hue (LFO / noise / random)" onclick={() => openAutomation(g.hue!)}>🔄</button>
            {/if}
          </div>
          <div class="color-wheel-wrap">
            <ColorWheel hue={pos.hue} sat={pos.sat} size={150} disabled={!!hueMod}
              on:change={(e) => setWheel(g, e.detail.hue, e.detail.sat)} />
            {#if hueMod}<span class="auto-tag">🔄 hue cycling · {SHAPES[hueMod.shape]} · {hueMod.period}s</span>{/if}
          </div>
        </div>
        {#if g.val}{@render paramRow(g.val)}{/if}
      {/each}
      {#if isConvolve && convolveCustom}
        <div class="parameter-group">
          <div class="parameter-header">
            <label class="parameter-label">Kernel (3×3)</label>
          </div>
          <div class="kernel-grid">
            {#each kernelParams as kp, ki (kp.name)}
              <input
                type="number"
                step="any"
                class="kernel-cell"
                class:center={ki === 4}
                value={getParameterValue(kp)}
                oninput={(e) => updateParameter(kp, parseFloat((e.target as HTMLInputElement).value) || 0)}
                ondblclick={() => resetParam(kp)}
                title={ki === 4 ? 'Center (weight for this pixel)' : 'Weight for the neighbouring pixel'}
              />
            {/each}
          </div>
          <p class="kernel-hint">Center is the pixel itself; the 8 around it are its neighbours. Weights are normalised by their sum (unless the sum is 0, e.g. edge kernels).</p>
        </div>
      {/if}
    {:else}
      <p class="no-parameters">This node has no parameters to configure.</p>
    {/if}
  </div>
</div>

<style>
  .popover-caret {
    width: 0;
    height: 0;
    z-index: 1001;
    pointer-events: none;
  }
  /* Each variant is a triangle in the popover's background colour, pointing toward the node, with
     a drop-shadow on the outward edges to hint the popover's border. */
  .caret-top {    /* popover below node — points up */
    border-left: 8px solid transparent; border-right: 8px solid transparent;
    border-bottom: 9px solid #1f2937; filter: drop-shadow(0 -1px 0 #374151);
  }
  .caret-bottom { /* popover above node — points down */
    border-left: 8px solid transparent; border-right: 8px solid transparent;
    border-top: 9px solid #1f2937; filter: drop-shadow(0 1px 0 #374151);
  }
  .caret-left {   /* popover right of node — points left */
    border-top: 8px solid transparent; border-bottom: 8px solid transparent;
    border-right: 9px solid #1f2937; filter: drop-shadow(-1px 0 0 #374151);
  }
  .caret-right {  /* popover left of node — points right */
    border-top: 8px solid transparent; border-bottom: 8px solid transparent;
    border-left: 9px solid #1f2937; filter: drop-shadow(1px 0 0 #374151);
  }

  .parameter-popover {
    background: #1f2937;
    border: 1px solid #374151;
    border-radius: 8px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    width: 300px;
    max-width: calc(100vw - 16px);   /* never wider than the viewport */
    /* Fallback cap; the inline style refines this to the space below/above the anchor so the
       popover is always fully on-screen. The content area (not the header) does the scrolling. */
    max-height: calc(100vh - 16px);
    display: flex;
    flex-direction: column;
    overflow: hidden;                /* clip to the rounded corners; .popover-content scrolls */
    z-index: 1000;
    color: white;
  }

  .popover-header { flex: 0 0 auto; }

  .popover-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid #374151;
    background: #111827;
    border-radius: 8px 8px 0 0;
  }

  .popover-header h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .header-buttons {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .close-btn {
    background: none;
    border: none;
    color: #9ca3af;
    font-size: 16px;
    cursor: pointer;
    padding: 2px;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
  }

  .close-btn:hover {
    background: #374151;
    color: white;
  }

  .delete-btn {
    background: #ef4444;
    border: none;
    color: white;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    padding: 4px 8px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    min-width: 50px;
    transition: background-color 0.2s ease;
  }

  .delete-btn:hover {
    background: #dc2626;
  }

  .delete-btn.delete-confirm {
    background: #f59e0b;
    animation: pulse 0.5s ease-in-out;
  }

  .delete-btn.delete-confirm:hover {
    background: #d97706;
  }

  .reset-btn {
    background: #374151;
    border: none;
    color: #e5e7eb;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    padding: 4px 8px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    min-width: 50px;
    transition: background-color 0.2s ease;
  }

  .reset-btn:hover { background: #4b5563; }

  .reset-btn.reset-confirm {
    background: #f59e0b;
    color: white;
    animation: pulse 0.5s ease-in-out;
  }

  .reset-btn.reset-confirm:hover { background: #d97706; }

  @keyframes pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.05); }
  }

  .popover-content {
    padding: 16px;
    flex: 1 1 auto;
    min-height: 0;        /* allow the flex child to shrink so overflow scrolls */
    overflow-y: auto;     /* scrollbars when the params/automation panel is taller than the popover */
  }

  .parameter-group {
    margin-bottom: 16px;
  }

  .parameter-group:last-child {
    margin-bottom: 0;
  }

  .parameter-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .parameter-label {
    font-size: 12px;
    font-weight: 500;
    color: #d1d5db;
    margin: 0;
  }

  .interactive-checkbox {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .interactive-checkbox input[type="checkbox"] {
    display: none;
  }

  .hand-emoji {
    font-size: 14px;
    cursor: pointer;
    opacity: 0.3;
    transition: opacity 0.2s ease;
    user-select: none;
  }

  .interactive-checkbox input[type="checkbox"]:checked + .hand-emoji {
    opacity: 1;
  }

  .hand-emoji:hover {
    opacity: 0.7;
  }

  .interactive-checkbox input[type="checkbox"]:checked + .hand-emoji:hover {
    opacity: 1;
    transform: scale(1.1);
  }

  .float-control, .range-control, .integer-control, .hue-control {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .float-control input[type="range"],
  .range-control input[type="range"],
  .integer-control input[type="range"],
  .hue-control input[type="range"] {
    flex: 1;
    height: 4px;
    background: #374151;
    border-radius: 2px;
    outline: none;
    -webkit-appearance: none;
    appearance: none; /* Added for broader compatibility */
  }

  .float-control input[type="range"]::-webkit-slider-thumb,
  .range-control input[type="range"]::-webkit-slider-thumb,
  .integer-control input[type="range"]::-webkit-slider-thumb,
  .hue-control input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    background: #3b82f6;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid white;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }

  /* Firefox slider thumb */
  .float-control input[type="range"]::-moz-range-thumb,
  .range-control input[type="range"]::-moz-range-thumb,
  .integer-control input[type="range"]::-moz-range-thumb,
  .hue-control input[type="range"]::-moz-range-thumb {
    width: 20px;
    height: 20px;
    background: #3b82f6;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid white;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }

  /* Increase touch target area on mobile */
  @media (max-width: 768px) {
    .float-control input[type="range"]::-webkit-slider-thumb,
    .range-control input[type="range"]::-webkit-slider-thumb,
    .integer-control input[type="range"]::-webkit-slider-thumb,
    .hue-control input[type="range"]::-webkit-slider-thumb {
      width: 28px;
      height: 28px;
    }

    .float-control input[type="range"]::-moz-range-thumb,
    .range-control input[type="range"]::-moz-range-thumb,
    .integer-control input[type="range"]::-moz-range-thumb,
    .hue-control input[type="range"]::-moz-range-thumb {
      width: 28px;
      height: 28px;
    }

    /* Increase the height of the slider track for better touch interaction */
    .float-control input[type="range"],
    .range-control input[type="range"],
    .integer-control input[type="range"],
    .hue-control input[type="range"] {
      height: 8px;
      padding: 12px 0; /* Add padding around the slider for larger touch area */
    }
  }

  .value-display {
    font-size: 11px;
    color: #9ca3af;
    min-width: 40px;
    text-align: right;
  }

  .select-control {
    display: flex;
    align-items: center;
  }

  .select-control select {
    flex: 1;
    background: #374151;
    border: 1px solid #4b5563;
    border-radius: 4px;
    color: white;
    font-size: 12px;
    padding: 6px 8px;
    cursor: pointer;
    outline: none;
    appearance: none; /* Added for broader compatibility */
    -webkit-appearance: none; /* For Safari */
    -moz-appearance: none; /* For Firefox */
  }

  .select-control select:hover {
    border-color: #6b7280;
  }

  .select-control select:focus {
    border-color: #3b82f6;
    box-shadow: 0 0 0 1px #3b82f6;
  }

  .select-control select option {
    background: #374151;
    color: white;
  }

  .no-parameters {
    color: #6b7280;
    font-style: italic;
    text-align: center;
    margin: 0;
  }

  /* ---- Convolve: 3×3 kernel grid ("boxes around the center") ---- */
  .kernel-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    max-width: 180px;
  }
  .kernel-cell {
    width: 100%;
    box-sizing: border-box;
    text-align: center;
    padding: 6px 2px;
    font-size: 0.9rem;
    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.06);
    color: inherit;
  }
  .kernel-cell.center {
    border-color: rgba(120, 170, 255, 0.9);
    background: rgba(120, 170, 255, 0.14);
    font-weight: 600;
  }
  .kernel-hint {
    color: #6b7280;
    font-size: 0.72rem;
    margin: 6px 0 0;
    line-height: 1.3;
  }

  /* ---- Parameter automation ---- */
  .automate-btn {
    background: none; border: none; cursor: pointer; font-size: 0.95rem;
    opacity: 0.4; padding: 0 2px; line-height: 1; filter: grayscale(1);
  }
  .automate-btn.active { opacity: 1; filter: none; }
  .automated-control { display: flex; flex-direction: column; gap: 4px; cursor: pointer; }
  .automated-control input[type="range"] { width: 100%; accent-color: #22d3ee; opacity: 0.9; }
  .auto-tag { font-size: 0.72rem; color: #22d3ee; font-variant-numeric: tabular-nums; }
  .automation-panel { display: flex; flex-direction: column; gap: 10px; }
  .back-btn { align-self: flex-start; background: none; border: none; color: #93c5fd; cursor: pointer; font-size: 0.85rem; padding: 0; }
  .auto-title { margin: 0; font-size: 0.95rem; color: #e5e7eb; }
  .shape-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .shape-btn {
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    background: #111827; border: 1px solid #374151; border-radius: 6px; color: #9ca3af;
    padding: 6px 2px; cursor: pointer; font-size: 0.7rem;
  }
  .shape-btn.sel { border-color: #22d3ee; color: #22d3ee; background: #0e2a30; }
  .mod-field { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 0.8rem; color: #d1d5db; }
  .mod-label { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .mod-field input { width: 90px; background: #111827; border: 1px solid #374151; border-radius: 4px; color: #e5e7eb; padding: 4px 6px; }
  .mod-field input[type="range"] { flex: 1; min-width: 0; padding: 0; }
  .mod-val { min-width: 44px; text-align: right; font-variant-numeric: tabular-nums; color: #9ca3af; }
  .stop-btn { margin-top: 4px; background: #3f1d1d; border: 1px solid #7f1d1d; color: #fca5a5; border-radius: 6px; padding: 6px; cursor: pointer; font-size: 0.8rem; }
  .svg-input { display: flex; flex-direction: column; gap: 6px; }
  .svg-preset { background: #111827; border: 1px solid #374151; border-radius: 4px; color: #e5e7eb; padding: 4px 6px; font-size: 0.8rem; }
  .svg-d { background: #111827; border: 1px solid #374151; border-radius: 4px; color: #e5e7eb; padding: 6px; font-size: 0.75rem; font-family: monospace; resize: vertical; }
  .color-wheel-wrap { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 6px 0; }
</style> 
