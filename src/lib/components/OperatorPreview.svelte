<script lang="ts">
  // Live WASM render of a single operator at its DEFAULT settings, for the Add-Node modal.
  // Generators render with no input (their canonical look); modifiers are fed the duck as
  // input 1 and the RGB venn as input 2 (single-input ops ignore input 2; Blend uses both).
  // Operators read params via getX(params, i, default), so setting NO params == defaults.
  // Only animates while on-screen (IntersectionObserver) to keep many previews cheap.
  import { onMount } from 'svelte';
  import { getDuckInput, getRgbVennInput } from '$lib/previewImages';

  let { op, isGenerator }: { op: string; isGenerator: boolean } = $props();

  const W = 96, H = 72, N = W * H * 3;
  let canvas: HTMLCanvasElement;

  onMount(() => {
    let raf = 0;
    let last = 0;
    let visible = false;
    let disposed = false;
    let inst = -1;
    let outPtr = 0, in1Ptr = 0, in2Ptr = 0;
    let m: any = null;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(W, H);

    function copyImageDataToBuffer(src: ImageData, ptr: number) {
      const heap = m.HEAPU8;
      for (let i = 0, j = ptr; i < src.data.length; i += 4, j += 3) {
        heap[j] = src.data[i];
        heap[j + 1] = src.data[i + 1];
        heap[j + 2] = src.data[i + 2];
      }
    }

    function setup() {
      m = window.getWasmModule?.();
      if (!m) return false;
      inst = m.ccall('createOperatorInstance', 'number', ['string'], [op]);
      if (inst < 0) return false;
      outPtr = m._malloc(N);
      if (!isGenerator) {
        in1Ptr = m._malloc(N);
        in2Ptr = m._malloc(N);
        copyImageDataToBuffer(getDuckInput(W, H), in1Ptr);
        copyImageDataToBuffer(getRgbVennInput(W, H), in2Ptr);
      }
      return true;
    }

    function frame(now: number) {
      raf = 0;
      if (disposed || !visible) return;
      if (now - last >= 45) { // ~22 fps
        last = now;
        const ts = Math.floor(now) % 1000000;
        m.ccall('renderOperator', null,
          ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
          [inst, in1Ptr, in2Ptr, outPtr, W, H, ts, 16]);
        const heap = m.HEAPU8;
        for (let i = 0, j = outPtr; i < img.data.length; i += 4, j += 3) {
          img.data[i] = heap[j];
          img.data[i + 1] = heap[j + 1];
          img.data[i + 2] = heap[j + 2];
          img.data[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
      }
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (disposed || raf) return;
      if (!m && !setup()) {
        // WASM not ready yet — retry once it loads.
        window.addEventListener('wasmReady', () => { if (!disposed && visible) start(); }, { once: true });
        return;
      }
      raf = requestAnimationFrame(frame);
    }

    const io = new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (visible) start();
      else if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }, { rootMargin: '100px' });
    io.observe(canvas);

    return () => {
      disposed = true;
      io.disconnect();
      if (raf) cancelAnimationFrame(raf);
      if (m && inst >= 0) {
        m.ccall('destroyOperatorInstance', null, ['number'], [inst]);
        if (outPtr) m._free(outPtr);
        if (in1Ptr) m._free(in1Ptr);
        if (in2Ptr) m._free(in2Ptr);
      }
    };
  });
</script>

<canvas bind:this={canvas} width={W} height={H} class="op-preview"></canvas>

<style>
  .op-preview {
    width: 100%;
    aspect-ratio: 96 / 72;
    height: auto;
    display: block;
    background: #000;
    border-radius: 6px;
  }
</style>
