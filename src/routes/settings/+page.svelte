<script lang="ts">
  import { onMount } from 'svelte';
  
  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;
  let operatorId: number = -1;
  let animationId: number;
  let wasmModule: any = null;
  
  const NUM_LEDS = 100;
  const LED_WIDTH = 4;
  const LED_HEIGHT = 20;
  const LED_SPACING = 2;
  
  // Simple buffer management - 3 CRGB buffers (always 3 bytes each)
  let buffer0Ptr: number = 0;  // Input buffer 1
  let buffer1Ptr: number = 0;  // Output buffer  
  let buffer2Ptr: number = 0;  // Input buffer 2
  const BYTES_PER_PIXEL = 3; // CRGB is always RGB (3 bytes)
  const BUFFER_SIZE = NUM_LEDS * BYTES_PER_PIXEL;
  
  // FPS tracking
  let fps = 0;
  let frameCount = 0;
  let lastFpsUpdate = Date.now();
  let frameTime = 0;
  let lastFrameTime = Date.now();
  let animationStartTime = 0;
  
  onMount(() => {
    // Initialize canvas
    const canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) return;
    ctx = canvasCtx;
    
    // Wait for WASM to be ready
    if (window.isWasmReady && window.isWasmReady()) {
      initializeWasm();
    } else {
      window.addEventListener('wasmReady', initializeWasm);
    }
    
    return () => {
      if (animationId) {
        cancelAnimationFrame(animationId);
      }
      if (operatorId !== -1 && wasmModule) {
        wasmModule.ccall('destroyOperatorInstance', null, ['number'], [operatorId]);
      }
      // Clean up allocated WASM memory
      if (buffer0Ptr && wasmModule) wasmModule._free(buffer0Ptr);
      if (buffer1Ptr && wasmModule) wasmModule._free(buffer1Ptr);
      if (buffer2Ptr && wasmModule) wasmModule._free(buffer2Ptr);
    };
  });
  
  function initializeWasm() {
    wasmModule = window.getWasmModule();
    if (!wasmModule) {
      console.error('WASM module not available');
      return;
    }
    
    try {
      // Allocate CRGB buffers directly (3 bytes each)
      buffer0Ptr = wasmModule._malloc(NUM_LEDS * 3);  // Input buffer 1  
      buffer1Ptr = wasmModule._malloc(NUM_LEDS * 3);  // Output buffer
      buffer2Ptr = wasmModule._malloc(NUM_LEDS * 3);  // Input buffer 2
      
      // Create NoiseBlendOperator instance
      operatorId = wasmModule.ccall('createOperatorInstance', 'number', ['string'], ['NoiseBlendOperator']);
      
      if (operatorId !== -1) {
        console.log('NoiseBlendOperator created with ID:', operatorId);
        
        // Set initial parameters
        wasmModule.ccall('setOperatorFloatParameter', null, ['number', 'number', 'number'], [operatorId, 0, 1.5]);
        wasmModule.ccall('setOperatorIntParameter', null, ['number', 'number', 'number'], [operatorId, 1, 0]);
        wasmModule.ccall('setOperatorFloatParameter', null, ['number', 'number', 'number'], [operatorId, 2, 0.7]);
        
        // Set up input buffer pattern
        wasmModule.ccall('clearBuffer', null, ['number', 'number'], [buffer0Ptr, NUM_LEDS]);
        
        // Create input pattern
        const inputData = new Uint8Array(BUFFER_SIZE);
        for (let i = 0; i < NUM_LEDS; i++) {
          if (i % 10 === 0) {
            inputData[i * 3] = 50;     // R
            inputData[i * 3 + 1] = 0;  // G  
            inputData[i * 3 + 2] = 100; // B
          } else {
            inputData[i * 3] = 0;
            inputData[i * 3 + 1] = 0;
            inputData[i * 3 + 2] = 0;
          }
        }
        
        wasmModule.HEAPU8.set(inputData, buffer0Ptr);
        
        // Initialize timing
        animationStartTime = Date.now();
        lastFrameTime = animationStartTime;
        lastFpsUpdate = animationStartTime;
        
        // Start animation loop
        animate();
      } else {
        console.error('Failed to create NoiseBlendOperator');
      }
    } catch (error) {
      console.error('Error initializing WASM:', error);
    }
  }
  
  function animate() {
    if (!wasmModule || operatorId === -1) return;
    
    try {
      const now = Date.now();
      
      // Calculate frame time
      frameTime = now - lastFrameTime;
      lastFrameTime = now;
      
      // Update FPS counter
      frameCount++;
      if (now - lastFpsUpdate >= 1000) {
        fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
        frameCount = 0;
        lastFpsUpdate = now;
      }
      
      // Render the operator with direct buffer pointers
      const renderStart = performance.now();
      const deltaTime = frameTime || 16;
      const relativeTimestamp = now - animationStartTime;
      
      wasmModule.ccall('renderOperator', null, 
        ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'], 
        [operatorId, buffer0Ptr, buffer2Ptr, buffer1Ptr, NUM_LEDS, 1, relativeTimestamp, deltaTime]);
      const renderTime = performance.now() - renderStart;
      
      // Read output and draw to canvas
      const drawStart = performance.now();
      drawLeds();
      const drawTime = performance.now() - drawStart;
      
      animationId = requestAnimationFrame(animate);
    } catch (error) {
      console.error('Animation error:', error);
    }
  }
  
  function drawLeds() {
    if (!ctx || !buffer1Ptr) return;
    
    // Clear canvas
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    let outputData: Uint8Array;
    
    outputData = new Uint8Array(wasmModule.HEAPU8.buffer, buffer1Ptr, NUM_LEDS * 3);
    
    // Use ImageData for fast rendering
    const imageData = ctx.createImageData(canvas.width, LED_HEIGHT);
    const pixels = imageData.data;
    
    // Fill ImageData buffer
    for (let i = 0; i < NUM_LEDS; i++) {
      const r = outputData[i * 3];
      const g = outputData[i * 3 + 1]; 
      const b = outputData[i * 3 + 2];
      
      const startX = i * (LED_WIDTH + LED_SPACING);
      const endX = startX + LED_WIDTH;
      
      // Fill LED rectangle in ImageData
      for (let x = startX; x < endX && x < canvas.width; x++) {
        for (let y = 0; y < LED_HEIGHT; y++) {
          const pixelIndex = (y * canvas.width + x) * 4;
          pixels[pixelIndex] = r;     // Red
          pixels[pixelIndex + 1] = g; // Green  
          pixels[pixelIndex + 2] = b; // Blue
          pixels[pixelIndex + 3] = 255; // Alpha
        }
      }
    }
    
    // Single operation to draw entire frame
    ctx.putImageData(imageData, 0, 10);
  }
  
  function updateSpeed(event: Event) {
    const target = event.target as HTMLInputElement;
    const speed = parseFloat(target.value);
    if (wasmModule && operatorId !== -1) {
      wasmModule.ccall('setOperatorFloatParameter', null, ['number', 'number', 'number'], [operatorId, 0, speed]);
    }
  }
  
  function updateHue(event: Event) {
    const target = event.target as HTMLInputElement;
    const hue = parseInt(target.value);
    if (wasmModule && operatorId !== -1) {
      wasmModule.ccall('setOperatorIntParameter', null, ['number', 'number', 'number'], [operatorId, 1, hue]);
    }
  }
  
  function updateBlend(event: Event) {
    const target = event.target as HTMLInputElement;
    const blend = parseFloat(target.value);
    if (wasmModule && operatorId !== -1) {
      wasmModule.ccall('setOperatorFloatParameter', null, ['number', 'number', 'number'], [operatorId, 2, blend]);
    }
  }
</script>

<main>
  <h1>Settings</h1>
  <p>Coming soon: application settings.</p>
  
  <section class="wasm-demo">
    <h2>🎨 WASM Operator Demo</h2>
    <p>Real-time C++ NoiseBlendOperator running in WebAssembly</p>
    
    <canvas 
      bind:this={canvas}
      width={NUM_LEDS * (LED_WIDTH + LED_SPACING)}
      height={50}
      class="led-strip"
    ></canvas>
    
    <div class="performance-stats">
      <div class="stat">
        <span class="stat-label">FPS:</span>
        <span class="stat-value" class:slow={fps < 30} class:medium={fps >= 30 && fps < 50} class:fast={fps >= 50}>{fps}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Frame Time:</span>
        <span class="stat-value">{frameTime}ms</span>
      </div>
    </div>
    
    <div class="controls">
      <label>
        Speed: 
        <input type="range" min="0.1" max="5.0" step="0.1" value="1.5" on:input={updateSpeed} />
      </label>
      
      <label>
        Hue Offset: 
        <input type="range" min="0" max="255" step="1" value="0" on:input={updateHue} />
      </label>
      
      <label>
        Blend Amount: 
        <input type="range" min="0" max="1" step="0.1" value="0.7" on:input={updateBlend} />
      </label>
    </div>
  </section>
</main>

<style>
  main {
    padding: 2rem;
    max-width: 800px;
    margin: 0 auto;
  }
  
  .wasm-demo {
    margin-top: 3rem;
    padding: 2rem;
    border: 2px solid #333;
    border-radius: 8px;
    background: #111;
  }
  
  .wasm-demo h2 {
    margin-top: 0;
    color: #4CAF50;
  }
  
  .led-strip {
    border: 1px solid #444;
    background: #000;
    margin: 1rem 0;
    display: block;
  }
  
  .controls {
    display: flex;
    gap: 2rem;
    flex-wrap: wrap;
  }
  
  .controls label {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    color: #ddd;
  }
  
  .controls input[type="range"] {
    width: 150px;
  }
  
  .performance-stats {
    display: flex;
    gap: 2rem;
    margin: 1rem 0;
    padding: 1rem;
    background: #222;
    border-radius: 4px;
    border: 1px solid #444;
  }
  
  .stat {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  
  .stat-label {
    color: #aaa;
    font-size: 0.9rem;
  }
  
  .stat-value {
    font-family: 'Courier New', monospace;
    font-weight: bold;
    font-size: 1.1rem;
    min-width: 60px;
    text-align: right;
  }
  
  .stat-value.slow {
    color: #ff4444;
  }
  
  .stat-value.medium {
    color: #ffaa00;
  }
  
  .stat-value.fast {
    color: #44ff44;
  }
</style>
