<script lang="ts">
  import { onMount } from 'svelte';
  import { getWasmOperatorManager, NODE_TYPES, type NodeDefinition } from '$lib/flowStore';
  
  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;
  let operatorId: number = -1;
  let animationId: number;
  let wasmModule: any = null;
  
  // 100x100 pixel grid (testing larger size)
  const GRID_WIDTH = 100;
  const GRID_HEIGHT = 100;
  const CANVAS_SCALE = 3; // Scale up for visibility
  
  // Simple buffer management - 3 CRGB buffers (always 3 bytes each)
  let buffer0Ptr: number = 0;  // Input buffer 1
  let buffer1Ptr: number = 0;  // Output buffer  
  let buffer2Ptr: number = 0;  // Input buffer 2
  const BYTES_PER_PIXEL = 3; // CRGB is always RGB (3 bytes)
  const BUFFER_SIZE = GRID_WIDTH * GRID_HEIGHT * BYTES_PER_PIXEL;
  
  // Operator management
  let availableOperators: string[] = [];
  let selectedOperator: string = '';
  let operatorParameters: any[] = [];
  let parameterValues: { [key: number]: any } = {};
  
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
    
    // Disable image smoothing for crisp pixels
    ctx.imageSmoothingEnabled = false;
    
    // Wait for WASM to be ready
    if (window.isWasmReady && window.isWasmReady()) {
      initializeWasm();
    } else {
      window.addEventListener('wasmReady', initializeWasm);
    }
    
    // Also listen for operator loading completion
    const checkOperatorsLoaded = () => {
      if (NODE_TYPES.length > 1) { // More than just output node
        console.log('NODE_TYPES loaded, updating operators...');
        if (wasmModule) {
          loadAvailableOperators();
        }
      }
    };
    
    // Check periodically for operator loading
    const operatorCheckInterval = setInterval(() => {
      checkOperatorsLoaded();
      if (NODE_TYPES.length > 1) {
        clearInterval(operatorCheckInterval);
      }
    }, 100);
    
    // Clean up interval on unmount
    return () => {
      if (animationId) {
        cancelAnimationFrame(animationId);
      }
      clearInterval(operatorCheckInterval);
      cleanup();
    };
  });
  
  function cleanup() {
    if (operatorId !== -1 && wasmModule) {
      wasmModule.ccall('destroyOperatorInstance', null, ['number'], [operatorId]);
    }
    // Clean up allocated WASM memory
    if (buffer0Ptr && wasmModule) wasmModule._free(buffer0Ptr);
    if (buffer1Ptr && wasmModule) wasmModule._free(buffer1Ptr);
    if (buffer2Ptr && wasmModule) wasmModule._free(buffer2Ptr);
  }
  
  function initializeWasm() {
    wasmModule = window.getWasmModule();
    if (!wasmModule) {
      console.error('WASM module not available');
      return;
    }
    
    try {
      // Load available operators
      loadAvailableOperators();
      
      // Debug: Log buffer size and available memory
      console.log(`Buffer size calculation: ${GRID_WIDTH}x${GRID_HEIGHT} = ${BUFFER_SIZE} bytes per buffer`);
      console.log(`Total memory needed: ${BUFFER_SIZE * 3} bytes for 3 buffers`);
      
      // Allocate CRGB buffers directly (3 bytes each) - one at a time for debugging
      console.log('Allocating buffer0...');
      buffer0Ptr = wasmModule._malloc(BUFFER_SIZE);  // Input buffer 1  
      console.log('Buffer0 allocated at:', buffer0Ptr);
      
      console.log('Allocating buffer1...');
      buffer1Ptr = wasmModule._malloc(BUFFER_SIZE);  // Output buffer
      console.log('Buffer1 allocated at:', buffer1Ptr);
      
      console.log('Allocating buffer2...');
      buffer2Ptr = wasmModule._malloc(BUFFER_SIZE);  // Input buffer 2
      console.log('Buffer2 allocated at:', buffer2Ptr);
      
      // Set up input buffer pattern (gradient for testing)
      setupInputBuffer();
      
    } catch (error) {
      console.error('Error initializing WASM:', error);
      console.error('Failed at buffer allocation phase');
    }
  }
  
  function loadAvailableOperators() {
    // Use the centralized operator manager instead of direct WASM calls
    const manager = getWasmOperatorManager();
    if (!manager) {
      console.error('WASM operator manager not available');
      return;
    }
    
    try {
      // Get operators from the centralized system (excluding output node)
      const operators = NODE_TYPES.filter(op => op.type !== 'output');
      availableOperators = operators.map(op => op.type);
      
      console.log(`Loaded ${availableOperators.length} operators for Settings page:`, availableOperators);
      
      // Select first operator by default
      if (availableOperators.length > 0) {
        selectedOperator = availableOperators[0];
        loadOperatorParameters();
        createOperatorInstance();
      }
    } catch (error) {
      console.error('Error loading operators in Settings page:', error);
    }
  }
  
  function loadOperatorParameters() {
    if (!selectedOperator) return;
    
    try {
      // Get parameter definitions from the centralized system
      const operatorDef = NODE_TYPES.find(op => op.type === selectedOperator);
      if (!operatorDef) {
        console.error(`Operator definition not found for: ${selectedOperator}`);
        return;
      }
      
      operatorParameters = [];
      parameterValues = {};
      
      operatorDef.params.forEach((param, i) => {
        // Convert from flowStore Parameter to Settings page format
        const paramInfo = {
          name: param.name,
          label: param.label,
          type: getParameterTypeNumber(param.type),
          default: param.default,
          min: param.min,
          max: param.max,
          options: param.options?.map(opt => opt.label) || []
        };
        
        operatorParameters.push(paramInfo);
        
        // Set default values with proper typing
        let defaultValue = param.default;
        if (param.type === 'float' || param.type === 'range') {
          defaultValue = parseFloat(defaultValue) || 0.0;
        } else if (param.type === 'integer') {
          defaultValue = parseInt(defaultValue) || 0;
        } else if (param.type === 'color') {
          defaultValue = defaultValue || '#ffffff';
        }
        
        parameterValues[i] = defaultValue;
        console.log(`Parameter ${i} (${param.label}): ${defaultValue} (type: ${param.type})`);
      });
      
    } catch (error) {
      console.error(`Error loading parameters for ${selectedOperator}:`, error);
    }
  }
  
  // Convert parameter type string to number for WASM compatibility
  function getParameterTypeNumber(type: string): number {
    switch (type) {
      case 'float':
      case 'range': return 0;
      case 'integer': return 1;
      case 'hue': return 2;  // Treat hue as bool for now
      case 'color': return 3;
      case 'select': return 4;
      default: return 0;
    }
  }
  
  function createOperatorInstance() {
    const manager = getWasmOperatorManager();
    if (!manager || !wasmModule) {
      console.error('WASM manager or module not available');
      return;
    }
    
    try {
      // Destroy existing operator
      if (operatorId !== -1) {
        wasmModule.ccall('destroyOperatorInstance', null, ['number'], [operatorId]);
        operatorId = -1;
      }
      
      // Create new operator instance using direct WASM call (Settings page manages its own instances)
      operatorId = wasmModule.ccall('createOperatorInstance', 'number', ['string'], [selectedOperator]);
      
      if (operatorId !== -1) {
        console.log(`${selectedOperator} created with ID:`, operatorId);
        
        // Set initial parameters
        setAllParameters();
        
        // Initialize timing and start animation
        animationStartTime = Date.now();
        lastFrameTime = animationStartTime;
        lastFpsUpdate = animationStartTime;
        
        if (!animationId) {
          animate();
        }
      } else {
        console.error(`Failed to create ${selectedOperator}`);
      }
    } catch (error) {
      console.error(`Error creating operator instance for ${selectedOperator}:`, error);
    }
  }
  
  function setAllParameters() {
    operatorParameters.forEach((param, index) => {
      const value = parameterValues[index];
      switch (param.type) {
        case 0: // FLOAT
          wasmModule.ccall('setOperatorFloatParameter', null, ['number', 'number', 'number'], [operatorId, index, value]);
          break;
        case 1: // INT
          wasmModule.ccall('setOperatorIntParameter', null, ['number', 'number', 'number'], [operatorId, index, value]);
          break;
        case 2: // BOOL
          wasmModule.ccall('setOperatorBoolParameter', null, ['number', 'number', 'number'], [operatorId, index, value ? 1 : 0]);
          break;
        case 3: // COLOR
          // TODO: Implement color parameter setting
          break;
        case 4: // SELECT
          wasmModule.ccall('setOperatorStringParameter', null, ['number', 'number', 'string'], [operatorId, index, value]);
          break;
      }
    });
  }
  
  function setupInputBuffer() {
    // Create a simple gradient pattern in the input buffer
    const inputData = new Uint8Array(BUFFER_SIZE);
    for (let y = 0; y < GRID_HEIGHT; y++) {
      for (let x = 0; x < GRID_WIDTH; x++) {
        const index = (y * GRID_WIDTH + x) * 3;
        // Create a subtle gradient
        inputData[index] = Math.floor((x / GRID_WIDTH) * 100);     // R
        inputData[index + 1] = Math.floor((y / GRID_HEIGHT) * 100); // G  
        inputData[index + 2] = 50;                                   // B
      }
    }
    
    console.log(`Created input buffer with ${inputData.length} bytes`);
    
    // Copy directly to CRGB buffer
    wasmModule.HEAPU8.set(inputData, buffer0Ptr);
    console.log('Input buffer copied to WASM memory');
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
      const deltaTime = frameTime || 16;
      const relativeTimestamp = now - animationStartTime;
      
      wasmModule.ccall('renderOperator', null, 
        ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'], 
        [operatorId, buffer0Ptr, buffer2Ptr, buffer1Ptr, GRID_WIDTH, GRID_HEIGHT, relativeTimestamp, deltaTime]);
      
      // Draw to canvas
      drawGrid();
      
      animationId = requestAnimationFrame(animate);
    } catch (error) {
      console.error('Animation error:', error);
    }
  }
  
  function drawGrid() {
    if (!ctx || !buffer1Ptr) return;
    
    // Read output buffer directly as RGB data
    const outputData = new Uint8Array(wasmModule.HEAPU8.buffer, buffer1Ptr, BUFFER_SIZE);
    
    // Create ImageData for the grid
    const imageData = ctx.createImageData(GRID_WIDTH, GRID_HEIGHT);
    const pixels = imageData.data;
    
    // Copy RGB data to ImageData
    for (let i = 0; i < GRID_WIDTH * GRID_HEIGHT; i++) {
      const pixelIndex = i * 4;
      const rgbIndex = i * 3;
      
      pixels[pixelIndex] = outputData[rgbIndex];         // Red
      pixels[pixelIndex + 1] = outputData[rgbIndex + 1]; // Green  
      pixels[pixelIndex + 2] = outputData[rgbIndex + 2]; // Blue
      pixels[pixelIndex + 3] = 255;                      // Alpha
    }
    
    // Draw scaled up to canvas
    ctx.putImageData(imageData, 0, 0);
  }
  
  function handleOperatorChange() {
    loadOperatorParameters();
    createOperatorInstance();
  }
  
  function handleParameterChange(paramIndex: number, value: any) {
    parameterValues[paramIndex] = value;
    if (operatorId !== -1) {
      const param = operatorParameters[paramIndex];
      switch (param.type) {
        case 0: // FLOAT
          wasmModule.ccall('setOperatorFloatParameter', null, ['number', 'number', 'number'], [operatorId, paramIndex, parseFloat(value)]);
          break;
        case 1: // INT
          wasmModule.ccall('setOperatorIntParameter', null, ['number', 'number', 'number'], [operatorId, paramIndex, parseInt(value)]);
          break;
        case 2: // BOOL
          wasmModule.ccall('setOperatorBoolParameter', null, ['number', 'number', 'number'], [operatorId, paramIndex, value ? 1 : 0]);
          break;
      }
    }
  }
</script>

<main>
  <h1>Visual Operator Playground</h1>
  <p>Real-time C++ operators running in WebAssembly - {GRID_WIDTH}x{GRID_HEIGHT} pixel grid</p>
  
  <div class="playground">
    <!-- Operator Selection -->
    <div class="controls">
      <div class="control-group">
        <label for="operator-select">Operator:</label>
        <select id="operator-select" bind:value={selectedOperator} on:change={handleOperatorChange}>
          {#each availableOperators as operator}
            <option value={operator}>{wasmModule?.ccall('getOperatorDisplayName', 'string', ['string'], [operator]) || operator}</option>
          {/each}
        </select>
      </div>
      
      <!-- Dynamic Parameter Controls -->
      {#each operatorParameters as param, index}
        <div class="control-group">
          <label for="param-{index}">{param.label}:</label>
          
          {#if param.type === 0}
            <!-- FLOAT -->
                         <input 
               id="param-{index}"
               type="range" 
               min={param.min || 0} 
               max={param.max || 100} 
               step="0.1"
               bind:value={parameterValues[index]}
               on:input={(e) => handleParameterChange(index, (e.target as HTMLInputElement).value)}
             />
                         <span class="value">{typeof parameterValues[index] === 'number' ? parameterValues[index].toFixed(1) : parameterValues[index] || '0.0'}</span>
          {:else if param.type === 1}
            <!-- INT -->
                         <input 
               id="param-{index}"
               type="range" 
               min={param.min || 0} 
               max={param.max || 255} 
               step="1"
               bind:value={parameterValues[index]}
               on:input={(e) => handleParameterChange(index, (e.target as HTMLInputElement).value)}
             />
            <span class="value">{parameterValues[index]}</span>
          {:else if param.type === 2}
            <!-- BOOL -->
                         <input 
               id="param-{index}"
               type="checkbox" 
               bind:checked={parameterValues[index]}
               on:change={(e) => handleParameterChange(index, (e.target as HTMLInputElement).checked)}
             />
          {:else if param.type === 4}
            <!-- SELECT -->
                         <select 
               id="param-{index}"
               bind:value={parameterValues[index]}
               on:change={(e) => handleParameterChange(index, (e.target as HTMLSelectElement).value)}
             >
              {#each param.options as option}
                <option value={option}>{option}</option>
              {/each}
            </select>
          {/if}
        </div>
      {/each}
      
      <!-- Performance Stats -->
      <div class="performance-stats">
        <div class="stat">
          <span class="stat-label">FPS:</span>
          <span class="stat-value" class:slow={fps < 30} class:medium={fps >= 30 && fps < 50} class:fast={fps >= 50}>{fps}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Frame:</span>
          <span class="stat-value">{frameTime}ms</span>
        </div>
      </div>
    </div>
    
    <!-- Visualization Canvas -->
    <div class="visualization">
      <canvas 
        bind:this={canvas}
        width={GRID_WIDTH}
        height={GRID_HEIGHT}
        style="width: {GRID_WIDTH * CANVAS_SCALE}px; height: {GRID_HEIGHT * CANVAS_SCALE}px;"
        class="grid-canvas"
      ></canvas>
      <div class="canvas-info">
        <span>{GRID_WIDTH}x{GRID_HEIGHT} pixels</span>
      </div>
    </div>
  </div>
</main>

<style>
  .playground {
    display: flex;
    gap: 2rem;
    align-items: flex-start;
    margin-top: 2rem;
  }
  
  .controls {
    flex: 0 0 300px;
    background: #f5f5f5;
    padding: 1.5rem;
    border-radius: 8px;
    border: 1px solid #ddd;
  }
  
  .control-group {
    margin-bottom: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  
  .control-group label {
    font-weight: bold;
    font-size: 0.9rem;
    color: #333;
  }
  
  .control-group input[type="range"] {
    width: 100%;
  }
  
  .control-group input[type="checkbox"] {
    width: auto;
  }
  
  .control-group select {
    padding: 0.5rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: white;
  }
  
  .value {
    font-size: 0.8rem;
    color: #666;
    text-align: right;
  }
  
  .visualization {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }
  
  .grid-canvas {
    border: 2px solid #333;
    border-radius: 4px;
    background: #000;
    image-rendering: pixelated;
    image-rendering: -moz-crisp-edges;
    image-rendering: crisp-edges;
  }
  
  .canvas-info {
    font-size: 0.9rem;
    color: #666;
  }
  
  .performance-stats {
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid #ccc;
  }
  
  .stat {
    display: flex;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }
  
  .stat-label {
    font-weight: bold;
    color: #555;
  }
  
  .stat-value {
    font-family: monospace;
  }
  
  .stat-value.slow { color: #e74c3c; }
  .stat-value.medium { color: #f39c12; }
  .stat-value.fast { color: #27ae60; }
</style>
