import { writable } from 'svelte/store';
import type { Node, Edge, Connection } from '@xyflow/svelte';
import { NATIVE_PATTERN_DEFINITIONS, renderNativePattern } from './wasmPatterns';

// Global start time for synchronized animations across all nodes
export const globalStartTime = writable<number>(performance.now());

// Parameter types
export type ParameterType = 'float' | 'range' | 'integer' | 'hue' | 'color' | 'select';

export interface Parameter {
  label: string;
  name: string;
  type: ParameterType;
  default: any;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

// Store for parameter values - keyed by nodeId, then by parameter name
export const nodeParameters = writable<Map<string, Map<string, any>>>(new Map());

// Helper function to get parameter value for a node
export function getNodeParameter(nodeId: string, paramName: string, defaultValue: any): any {
  let currentParams: Map<string, Map<string, any>> = new Map();
  nodeParameters.subscribe(params => currentParams = params)();
  
  const nodeParams = currentParams.get(nodeId);
  if (nodeParams && nodeParams.has(paramName)) {
    return nodeParams.get(paramName);
  }
  return defaultValue;
}

// Helper function to set parameter value for a node
export function setNodeParameter(nodeId: string, paramName: string, value: any): void {
  nodeParameters.update(params => {
    if (!params.has(nodeId)) {
      params.set(nodeId, new Map());
    }
    params.get(nodeId)!.set(paramName, value);
    return params;
  });
}

// Helper function to ensure all parameters are initialized for a node
export function ensureNodeParametersInitialized(nodeId: string, nodeType: string): void {
  const nodeDefinition = getNodeDefinition(nodeType);
  if (!nodeDefinition) return;
  
  nodeParameters.update(params => {
    if (!params.has(nodeId)) {
      params.set(nodeId, new Map());
    }
    
    const nodeParams = params.get(nodeId)!;
    
    // Initialize any missing parameters with their default values
    nodeDefinition.params.forEach(param => {
      if (!nodeParams.has(param.name)) {
        nodeParams.set(param.name, param.default);
      }
    });
    
    return params;
  });
}

// Helper function for HSL to RGB conversion
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h * 6) % 2 - 1));
  const m = l - c / 2;
  
  let r = 0, g = 0, b = 0;
  
  if (0 <= h && h < 1/6) {
    r = c; g = x; b = 0;
  } else if (1/6 <= h && h < 2/6) {
    r = x; g = c; b = 0;
  } else if (2/6 <= h && h < 3/6) {
    r = 0; g = c; b = x;
  } else if (3/6 <= h && h < 4/6) {
    r = 0; g = x; b = c;
  } else if (4/6 <= h && h < 5/6) {
    r = x; g = 0; b = c;
  } else if (5/6 <= h && h < 1) {
    r = c; g = 0; b = x;
  }
  
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255)
  ];
}

// Helper function for HSV to RGB conversion
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs((h * 6) % 2 - 1));
  const m = v - c;
  
  let r = 0, g = 0, b = 0;
  
  if (0 <= h && h < 1/6) {
    r = c; g = x; b = 0;
  } else if (1/6 <= h && h < 2/6) {
    r = x; g = c; b = 0;
  } else if (2/6 <= h && h < 3/6) {
    r = 0; g = c; b = x;
  } else if (3/6 <= h && h < 4/6) {
    r = 0; g = x; b = c;
  } else if (4/6 <= h && h < 5/6) {
    r = x; g = 0; b = c;
  } else if (5/6 <= h && h < 1) {
    r = c; g = 0; b = x;
  }
  
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255)
  ];
}

// Helper function to convert hex color to RGB
function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? [
    parseInt(result[1], 16),
    parseInt(result[2], 16),
    parseInt(result[3], 16)
  ] : [255, 255, 255];
}

// Type for render function parameters
export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  totalTime: number; // Total elapsed time in seconds since start
  deltaTime: number; // Time elapsed since last frame in seconds
  width: number;
  height: number;
  getInputNodes: () => any;
  getNodeOutput: (nodeId: string) => ImageData | null;
  nodeId: string;
}

// Type for node definition
export interface NodeDefinition {
  name: string;
  type: string;
  params: Parameter[];
  render: (context: RenderContext) => void;
}

// Helper function to try rendering with native WASM patterns
async function tryRenderNativePattern(
  patternType: string, 
  totalTime: number, 
  deltaTime: number, 
  width: number, 
  height: number, 
  nodeId: string
): Promise<ImageData | null> {
  try {
    const nativePattern = NATIVE_PATTERN_DEFINITIONS.find(p => p.type === patternType);
    if (!nativePattern) return null;
    
    // Extract parameter values for this node
    const parameters = nativePattern.params.map(param => 
      getNodeParameter(nodeId, param.name, param.default)
    );
    
    // Call the native WASM pattern
    return await renderNativePattern(
      patternType,
      width,
      height,
      totalTime,
      deltaTime,
      parameters
    );
  } catch (error) {
    console.warn('Native pattern render failed:', error);
    return null;
  }
}

// Define LED pattern node types with their render functions
// Note: Output is first (index 0) so it's not shown in dropdown, pattern nodes start from index 1
export const NODE_TYPES: NodeDefinition[] = [
  {
    name: 'Output',
    type: 'output',
    params: [],
    render: () => {
      // Output node doesn't render anything - it just passes through input
    }
  },
  {
    name: 'Rainbow',
    type: 'rainbow',
    params: [
      { label: 'Speed', name: 'speed', type: 'float', default: 0.1 },
      { label: 'Saturation', name: 'saturation', type: 'float', default: 1.0 },
      { label: 'Value', name: 'value', type: 'float', default: 1.0 },
      { label: 'Angle', name: 'angle', type: 'range', default: 0, min: 0, max: 360 }
    ],
    render: ({ ctx, totalTime, width, height, nodeId }) => {
      const speed = getNodeParameter(nodeId, 'speed', 0.1) * 3; // Scale down for reasonable animation speed
      const saturation = getNodeParameter(nodeId, 'saturation', 1.0);
      const value = getNodeParameter(nodeId, 'value', 1.0);
      const angle = getNodeParameter(nodeId, 'angle', 0);
      
      // Convert angle to radians
      const angleRad = (angle * Math.PI) / 180;
      const cosAngle = Math.cos(angleRad);
      const sinAngle = Math.sin(angleRad);
      
      for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
          // Apply rotation to coordinates
          const rotatedX = x * cosAngle - y * sinAngle;
          const rotatedY = x * sinAngle + y * cosAngle;
          
          // Use rotated X coordinate for hue calculation
          const hue = ((rotatedX / width) + totalTime * speed) % 1;
          const [r, g, b] = hsvToRgb(Math.abs(hue), saturation, value);
          ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  },
  {
    name: 'Gradient',
    type: 'gradient',
    params: [
      { label: 'Color 1', name: 'color1', type: 'color', default: '#3b82f6' },
      { label: 'Color 2', name: 'color2', type: 'color', default: '#8b5cf6' },
      { label: 'Speed', name: 'speed', type: 'range', default: 10, min: 0, max: 100 },
      { label: 'Angle', name: 'angle', type: 'range', default: 0, min: 0, max: 360 }
    ],
    render: ({ ctx, totalTime, width, height, nodeId }) => {
      const color1 = getNodeParameter(nodeId, 'color1', '#3b82f6');
      const color2 = getNodeParameter(nodeId, 'color2', '#8b5cf6');
      const speed = getNodeParameter(nodeId, 'speed', 10) / 10;
      const angle = getNodeParameter(nodeId, 'angle', 0);
      
      // Convert angle to radians and calculate gradient direction
      const angleRad = (angle * Math.PI) / 180;
      const gradientLength = Math.sqrt(width * width + height * height);
      
      // Calculate gradient endpoints based on angle
      const centerX = width / 2;
      const centerY = height / 2;
      const halfLength = gradientLength / 2;
      
      const x1 = centerX - Math.cos(angleRad) * halfLength;
      const y1 = centerY - Math.sin(angleRad) * halfLength;
      const x2 = centerX + Math.cos(angleRad) * halfLength;
      const y2 = centerY + Math.sin(angleRad) * halfLength;
      
      // Animate by shifting the gradient colors
      const timeOffset = totalTime * speed;
      const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
      
      // Create multiple color stops to animate the gradient
      const stops = 10;
      for (let i = 0; i <= stops; i++) {
        const position = i / stops;
        const animatedPosition = (position + timeOffset) % 2;
        
        // Oscillate between the two colors
        let color;
        if (animatedPosition <= 1) {
          // Blend from color1 to color2
          const blend = animatedPosition;
          const [r1, g1, b1] = hexToRgb(color1);
          const [r2, g2, b2] = hexToRgb(color2);
          const r = Math.round(r1 * (1 - blend) + r2 * blend);
          const g = Math.round(g1 * (1 - blend) + g2 * blend);
          const b = Math.round(b1 * (1 - blend) + b2 * blend);
          color = `rgb(${r}, ${g}, ${b})`;
        } else {
          // Blend from color2 back to color1
          const blend = animatedPosition - 1;
          const [r1, g1, b1] = hexToRgb(color2);
          const [r2, g2, b2] = hexToRgb(color1);
          const r = Math.round(r1 * (1 - blend) + r2 * blend);
          const g = Math.round(g1 * (1 - blend) + g2 * blend);
          const b = Math.round(b1 * (1 - blend) + b2 * blend);
          color = `rgb(${r}, ${g}, ${b})`;
        }
        
        gradient.addColorStop(position, color);
      }
      
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }
  },
  {
    name: 'Perlin Noise',
    type: 'perlin_noise',
    params: [
      { label: 'Speed', name: 'speed', type: 'range', default: 50, min: 1, max: 200 },
      { label: 'Scale', name: 'scale', type: 'float', default: 0.3 },
      { label: 'Intensity', name: 'intensity', type: 'float', default: 1.0 },
      { label: 'Octaves', name: 'octaves', type: 'integer', default: 3, min: 1, max: 6 }
    ],
    render: ({ ctx, totalTime, width, height, nodeId }) => {
      // Ensure all parameters are initialized for this node
      ensureNodeParametersInitialized(nodeId, 'perlin_noise');
      
      const speed = getNodeParameter(nodeId, 'speed', 50) / 10;
      const scale = getNodeParameter(nodeId, 'scale', 0.3);
      const intensity = getNodeParameter(nodeId, 'intensity', 1.0);
      const octaves = getNodeParameter(nodeId, 'octaves', 3);
      
      // Create more complex noise with multiple octaves
      for (let x = 0; x < width; x += 1) {
        for (let y = 0; y < height; y += 1) {
          let noise = 0;
          let amplitude = 1;
          let frequency = scale;
          let maxValue = 0; // Used for normalizing result to 0-1
          
          // Layer multiple noise octaves for more realistic noise
          for (let i = 0; i < octaves; i++) {
            // Use multiple sine/cosine layers with different phases for more chaotic noise
            const n1 = Math.sin(x * frequency + totalTime * speed) * Math.cos(y * frequency + totalTime * speed * 0.7);
            const n2 = Math.sin(x * frequency * 1.3 + totalTime * speed * 1.5) * Math.cos(y * frequency * 0.8 + totalTime * speed * 0.9);
            const n3 = Math.sin(x * frequency * 0.6 + totalTime * speed * 2.1) * Math.cos(y * frequency * 1.7 + totalTime * speed * 1.3);
            
            const layerNoise = (n1 + n2 * 0.5 + n3 * 0.25) / 1.75; // Mix the layers
            noise += layerNoise * amplitude;
            maxValue += amplitude;
            
            amplitude *= 0.5; // Each octave has half the amplitude
            frequency *= 2.0; // Each octave has double the frequency
          }
          
          // Normalize and apply intensity
          noise = (noise / maxValue); // Now ranges from -1 to 1
          const alpha = Math.abs(noise) * intensity; // Use absolute value for brightness
          
          // Use the noise to create grayscale values instead of just alpha
          const brightness = Math.max(0, Math.min(1, (noise + 1) * 0.5 * intensity));
          const colorValue = Math.round(brightness * 255);
          
          ctx.fillStyle = `rgb(${colorValue}, ${colorValue}, ${colorValue})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  },
  {
    name: 'Moving Blob',
    type: 'moving_blob',
    params: [
      { label: 'Speed', name: 'speed', type: 'float', default: 2.0 },
      { label: 'Size', name: 'size', type: 'float', default: 0.25 },
      { label: 'Color', name: 'color', type: 'color', default: '#ffffff' }
    ],
    render: ({ ctx, totalTime, width, height, nodeId }) => {
      const speed = getNodeParameter(nodeId, 'speed', 2.0);
      const size = getNodeParameter(nodeId, 'size', 0.25);
      const color = getNodeParameter(nodeId, 'color', '#ffffff');
      
      const centerX = width/2 + Math.sin(totalTime * speed) * (width * 0.2);
      const centerY = height/2 + Math.cos(totalTime * speed * 0.75) * (height * 0.2);
      const innerRadius = Math.min(width, height) * 0.06;
      const outerRadius = Math.min(width, height) * size;
      const radialGradient = ctx.createRadialGradient(centerX, centerY, innerRadius, centerX, centerY, outerRadius);
      radialGradient.addColorStop(0, color);
      radialGradient.addColorStop(1, 'transparent');
      ctx.fillStyle = radialGradient;
      ctx.fillRect(0, 0, width, height);
    }
  },
  {
    name: 'Raindrops',
    type: 'raindrops',
    params: [
      { label: 'Speed', name: 'speed', type: 'range', default: 50, min: 10, max: 200 },
      { label: 'Count', name: 'count', type: 'integer', default: 8, min: 2, max: 32 },
      { label: 'Size', name: 'size', type: 'float', default: 0.025 },
      { label: 'Color', name: 'color', type: 'color', default: '#ffffff' }
    ],
    render: ({ ctx, totalTime, width, height, nodeId }) => {
      const speed = getNodeParameter(nodeId, 'speed', 50);
      const count = getNodeParameter(nodeId, 'count', 8);
      const size = getNodeParameter(nodeId, 'size', 0.025);
      const color = getNodeParameter(nodeId, 'color', '#ffffff');
      
      const dropCount = Math.floor(width / (width / count));
      for (let i = 0; i < dropCount; i++) {
        const x = (i * (width / dropCount) + width / (dropCount * 2)) % width;
        const y = ((totalTime * speed + i * 10) % (height + 10)) - 10;
        if (y >= 0 && y <= height) {
          ctx.fillStyle = color;
          ctx.beginPath();
          const dropWidth = width * size;
          const dropHeight = height * 0.08;
          ctx.ellipse(x, y, dropWidth, dropHeight, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  },
  {
    name: 'Strobe',
    type: 'strobe',
    params: [
      { label: 'Frequency', name: 'frequency', type: 'range', default: 8, min: 1, max: 30 },
      { label: 'Intensity', name: 'intensity', type: 'float', default: 0.8 },
      { label: 'Color', name: 'color', type: 'color', default: '#ffffff' }
    ],
    render: ({ ctx, totalTime, width, height, nodeId }) => {
      const frequency = getNodeParameter(nodeId, 'frequency', 8);
      const intensity = getNodeParameter(nodeId, 'intensity', 0.8);
      const color = getNodeParameter(nodeId, 'color', '#ffffff');
      
      const strobeValue = Math.sin(totalTime * frequency) > 0.7 ? 1 : 0;
      if (strobeValue > 0) {
        const [r, g, b] = hexToRgb(color);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${intensity})`;
        ctx.fillRect(0, 0, width, height);
      }
    }
  },
  {
    name: 'Sparkle',
    type: 'sparkle',
    params: [
      { label: 'Speed', name: 'speed', type: 'float', default: 3.0 },
      { label: 'Count', name: 'count', type: 'integer', default: 10, min: 3, max: 50 },
      { label: 'Size', name: 'size', type: 'float', default: 0.025 },
      { label: 'Color', name: 'color', type: 'color', default: '#ffffff' }
    ],
    render: ({ ctx, totalTime, width, height, nodeId }) => {
      const speed = getNodeParameter(nodeId, 'speed', 3.0);
      const count = getNodeParameter(nodeId, 'count', 10);
      const size = getNodeParameter(nodeId, 'size', 0.025);
      const color = getNodeParameter(nodeId, 'color', '#ffffff');
      
      const sparkleCount = Math.floor(width / (width / count));
      for (let i = 0; i < sparkleCount; i++) {
        // Make sparkle positions move around randomly
        const baseX = (width / sparkleCount) * i;
        const baseY = height / 2;
        const x = baseX + Math.sin(totalTime * speed + i * 1.7) * (width * 0.1);
        const y = baseY + Math.cos(totalTime * speed * 0.5 + i * 2.3) * (height * 0.3);
        const alpha = Math.abs(Math.sin(totalTime * speed + i * 0.8)) * 0.8 + 0.2;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.beginPath();
        const sparkleRadius = Math.min(width, height) * size;
        ctx.arc(x, y, sparkleRadius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  },
  {
    name: 'Fade',
    type: 'fade',
    params: [
      { label: 'Speed', name: 'speed', type: 'float', default: 1.0 },
      { label: 'Color', name: 'color', type: 'color', default: '#ff6b35' }
    ],
    render: ({ ctx, totalTime, width, height, nodeId }) => {
      const speed = getNodeParameter(nodeId, 'speed', 1.0);
      const color = getNodeParameter(nodeId, 'color', '#ff6b35');
      
      const fadeIntensity = (Math.sin(totalTime * speed) + 1) * 0.5;
      ctx.globalAlpha = fadeIntensity;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;
    }
  },
  {
    name: 'Chase',
    type: 'chase',
    params: [
      { label: 'Speed', name: 'speed', type: 'range', default: 20, min: 5, max: 100 },
      { label: 'Size', name: 'size', type: 'integer', default: 4, min: 1, max: 20 },
      { label: 'Color', name: 'color', type: 'color', default: '#ffffff' }
    ],
    render: ({ ctx, totalTime, width, height, nodeId }) => {
      const speed = getNodeParameter(nodeId, 'speed', 20);
      const size = getNodeParameter(nodeId, 'size', 4);
      const color = getNodeParameter(nodeId, 'color', '#ffffff');
      
      const position = (totalTime * speed) % width;
      ctx.fillStyle = color;
      ctx.fillRect(position, 0, size, height); // Full vertical bar instead of circle
    }
  },
  {
    name: 'Blend',
    type: 'blend',
    params: [
      { label: 'Opacity', name: 'opacity', type: 'float', default: 0.5 },
      { label: 'Blend Mode', name: 'blendMode', type: 'select', default: 'normal', options: [
        { value: 'normal', label: 'Normal' },
        { value: 'add', label: 'Add' },
        { value: 'multiply', label: 'Multiply' },
        { value: 'screen', label: 'Screen' },
        { value: 'overlay', label: 'Overlay' },
        { value: 'difference', label: 'Difference' }
      ]}
    ],
    render: ({ ctx, width, height, getInputNodes, getNodeOutput, nodeId }) => {
      const opacity = getNodeParameter(nodeId, 'opacity', 0.5);
      const blendMode = getNodeParameter(nodeId, 'blendMode', 'normal');
      const inputs = getInputNodes();
      const input1Data = inputs.input1 ? getNodeOutput(inputs.input1.id) : null;
      const input2Data = inputs.input2 ? getNodeOutput(inputs.input2.id) : null;
      
      if (input1Data || input2Data) {
        // Create blend effect
        const imageData = ctx.createImageData(width, height);
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
          let r1 = 0, g1 = 0, b1 = 0, a1 = 255;
          let r2 = 0, g2 = 0, b2 = 0, a2 = 255;
          
          if (input1Data) {
            r1 = input1Data.data[i];
            g1 = input1Data.data[i + 1];
            b1 = input1Data.data[i + 2];
            a1 = input1Data.data[i + 3];
          }
          
          if (input2Data) {
            r2 = input2Data.data[i];
            g2 = input2Data.data[i + 1];
            b2 = input2Data.data[i + 2];
            a2 = input2Data.data[i + 3];
          }
          
          // Apply blend mode
          let r, g, b;
          
          switch (blendMode) {
            case 'add':
              r = Math.min(255, r1 + r2 * opacity);
              g = Math.min(255, g1 + g2 * opacity);
              b = Math.min(255, b1 + b2 * opacity);
              break;
            case 'multiply':
              r = Math.min(255, r1 * (1 - opacity) + (r1 * r2 / 255) * opacity);
              g = Math.min(255, g1 * (1 - opacity) + (g1 * g2 / 255) * opacity);
              b = Math.min(255, b1 * (1 - opacity) + (b1 * b2 / 255) * opacity);
              break;
            case 'screen':
              r = Math.min(255, r1 * (1 - opacity) + (255 - (255 - r1) * (255 - r2) / 255) * opacity);
              g = Math.min(255, g1 * (1 - opacity) + (255 - (255 - g1) * (255 - g2) / 255) * opacity);
              b = Math.min(255, b1 * (1 - opacity) + (255 - (255 - b1) * (255 - b2) / 255) * opacity);
              break;
            case 'overlay':
              const overlayR = r1 < 128 ? 2 * r1 * r2 / 255 : 255 - 2 * (255 - r1) * (255 - r2) / 255;
              const overlayG = g1 < 128 ? 2 * g1 * g2 / 255 : 255 - 2 * (255 - g1) * (255 - g2) / 255;
              const overlayB = b1 < 128 ? 2 * b1 * b2 / 255 : 255 - 2 * (255 - b1) * (255 - b2) / 255;
              r = Math.min(255, r1 * (1 - opacity) + overlayR * opacity);
              g = Math.min(255, g1 * (1 - opacity) + overlayG * opacity);
              b = Math.min(255, b1 * (1 - opacity) + overlayB * opacity);
              break;
            case 'difference':
              r = Math.min(255, r1 * (1 - opacity) + Math.abs(r1 - r2) * opacity);
              g = Math.min(255, g1 * (1 - opacity) + Math.abs(g1 - g2) * opacity);
              b = Math.min(255, b1 * (1 - opacity) + Math.abs(b1 - b2) * opacity);
              break;
            default: // normal
              r = Math.min(255, r1 * (1 - opacity) + r2 * opacity);
              g = Math.min(255, g1 * (1 - opacity) + g2 * opacity);
              b = Math.min(255, b1 * (1 - opacity) + b2 * opacity);
              break;
          }
          
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
          data[i + 3] = 255;
        }
        
        ctx.putImageData(imageData, 0, 0);
      }
    }
  },
  
  // Add native FastLED patterns
  ...NATIVE_PATTERN_DEFINITIONS.map(nativePattern => ({
    name: nativePattern.name,
    type: nativePattern.type,
    params: nativePattern.params.map(param => ({
      label: param.label,
      name: param.name,
      type: param.type as ParameterType,
      default: param.default,
      min: param.min,
      max: param.max
    })),
    render: ({ ctx, totalTime, deltaTime, width, height, nodeId }: RenderContext) => {
      // For native patterns, we'll render a placeholder that shows they're loading
      // The actual native rendering will be handled elsewhere
      ctx.fillStyle = '#333';
      ctx.fillRect(0, 0, width, height);
      
      // Draw loading text
      ctx.fillStyle = '#fff';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Native Pattern', width / 2, height / 2 - 5);
      ctx.fillText('(Loading WASM)', width / 2, height / 2 + 8);
      
      // Try to render with WASM if available
      tryRenderNativePattern(nativePattern.type, totalTime, deltaTime, width, height, nodeId)
        .then((imageData: ImageData | null) => {
          if (imageData) {
            ctx.putImageData(imageData, 0, 0);
          }
        })
        .catch(() => {
          // Already showing placeholder, no need to handle error
        });
    }
  }))
];

// Helper function to get node definition by type
export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return NODE_TYPES.find(node => node.type === type);
}

// Define the 3 vertical lanes for node snapping
const LANES = {
  LEFT: 25,
  CENTER: 175,
  RIGHT: 325
};

// Helper function to get which buffer/lane a node is in
export function getNodeBuffer(node: Node): number {
  const x = node.position.x;
  const distances = [
    Math.abs(x - LANES.LEFT),
    Math.abs(x - LANES.CENTER), 
    Math.abs(x - LANES.RIGHT)
  ];
  return distances.indexOf(Math.min(...distances)) + 1; // Return 1, 2, or 3
}

// Helper function to validate buffer constraints for connections
export function validateBufferConnection(connection: Edge | Connection, nodes: Node[], edges: Edge[]): boolean {
  const target = nodes.find((node) => node.id === connection.target);
  const source = nodes.find((node) => node.id === connection.source);
  
  if (!target || !source) return false;
  
  const sourceBuffer = getNodeBuffer(source);
  const targetBuffer = getNodeBuffer(target);
  
  // Check if source already outputs to this target's lane
  // Exclude the current connection being validated to avoid self-rejection
  const existingOutputsToTargetLane = edges.filter(edge => {
    if (edge.source !== connection.source) return false;
    if (edge.id === (connection as Edge).id) return false; // Exclude self when validating existing edge
    const edgeTarget = nodes.find(n => n.id === edge.target);
    return edgeTarget && getNodeBuffer(edgeTarget) === targetBuffer;
  });
  
  if (existingOutputsToTargetLane.length > 0) {
    return false;
  }
  
  // Special rules for blend nodes
  if (target.data.type === 'blend') {
    const targetHandleId = connection.targetHandle;
    
    // For blend node's second input (input-2), must be from different buffer
    if (targetHandleId === 'input-2' && sourceBuffer === targetBuffer) {
      return false;
    }
  }
  
  return true;
}

// Enhanced connection validation that includes buffer constraints
export function isValidConnectionWithBuffers(connection: Edge | Connection, nodes: Node[], edges: Edge[]): boolean {
  const target = nodes.find((node) => node.id === connection.target);
  const source = nodes.find((node) => node.id === connection.source);
  
  if (!target || !source) return false;
  
  // Prevent self-loops
  if (target.id === source.id) return false;
  
  // Check buffer constraints first
  if (!validateBufferConnection(connection, nodes, edges)) return false;
  
  // Check existing connection limits
  const targetHandleId = connection.targetHandle;
  const isBlendNode = target.data.type === 'blend';
  
  if (isBlendNode) {
    // For blend nodes, each handle can only have one connection
    const existingConnections = edges.filter(edge => 
      edge.target === connection.target && 
      edge.targetHandle === targetHandleId &&
      edge.id !== (connection as Edge).id // Exclude self when validating existing edge
    );
    if (existingConnections.length >= 1) return false;
  } else {
    // For non-blend nodes, only allow one total input connection
    const allTargetConnections = edges.filter(edge => 
      edge.target === connection.target &&
      edge.id !== (connection as Edge).id // Exclude self when validating existing edge
    );
    if (allTargetConnections.length >= 1) return false;
  }
  
  // Check for cycles (existing logic)
  const hasCycle = (node: Node, visited = new Set<string>()): boolean => {
    if (visited.has(node.id)) return false;
    visited.add(node.id);
    
    for (const edge of edges) {
      if (edge.source === node.id) {
        const outgoer = nodes.find(n => n.id === edge.target);
        if (outgoer) {
          if (outgoer.id === source.id) return true;
          if (hasCycle(outgoer, visited)) return true;
        }
      }
    }
    return false;
  };
  
  if (hasCycle(target)) return false;
  
  return true;
}

// Helper function to create a node from a node type
export function createNodeFromType(nodeType: NodeDefinition, id: string, position: { x: number, y: number }): Node {
  // Initialize node parameters with default values
  const nodeParams = new Map<string, any>();
  nodeType.params.forEach(param => {
    nodeParams.set(param.name, param.default);
  });
  
  // Set the parameters in the store
  nodeParameters.update(params => {
    params.set(id, nodeParams);
    return params;
  });
  
  return {
    id,
    type: 'pattern',
    position,
    data: { 
      label: nodeType.name,
      type: nodeType.type
    },
    style: ''
  };
}

// Create persistent stores for nodes and edges - will be initialized from patterns
export const flowNodes = writable<Node[]>([]);
export const flowEdges = writable<Edge[]>([]);

// Subscribe to changes to check dirty state
let debounceTimeout: ReturnType<typeof setTimeout> | null = null;
function debounceCheckDirty() {
  if (debounceTimeout) clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(checkPatternDirty, 100);
}

flowNodes.subscribe(() => debounceCheckDirty());
flowEdges.subscribe(() => debounceCheckDirty());
nodeParameters.subscribe(() => debounceCheckDirty());

// Keep track of next available ID
export const nextNodeId = writable(3);

// Dirty state tracking
export const isDirty = writable<boolean>(false);
let originalPatternState: string | null = null;

// Mark pattern as clean (after save or load)
export function markPatternClean(): void {
  const currentState = JSON.stringify(serializeCurrentPattern());
  originalPatternState = currentState;
  isDirty.set(false);
}

// Check if pattern is dirty
export function checkPatternDirty(): void {
  if (originalPatternState === null) {
    isDirty.set(false);
    return;
  }
  
  const currentState = JSON.stringify(serializeCurrentPattern());
  isDirty.set(currentState !== originalPatternState);
}

// Shared store for node outputs so nodes can access each other's rendered data
export const nodeOutputs = writable<Map<string, ImageData>>(new Map());

// Export lanes for use in components
export { LANES };

// Helper function to delete a node and handle rewiring
export function deleteNode(nodeId: string): void {
  // Get current state
  let currentNodes: Node[] = [];
  let currentEdges: Edge[] = [];
  
  flowNodes.subscribe(nodes => currentNodes = nodes)();
  flowEdges.subscribe(edges => currentEdges = edges)();
  
  // Find the node to delete
  const nodeToDelete = currentNodes.find(n => n.id === nodeId);
  if (!nodeToDelete) return;
  
  // Check if it's a blend node
  const isBlendNode = nodeToDelete.data.type === 'blend';
  
  // Get edges connected to this node
  const inputEdges = currentEdges.filter(edge => edge.target === nodeId);
  const outputEdges = currentEdges.filter(edge => edge.source === nodeId);
  
  // If not a blend node and has both input and output connections, rewire them
  if (!isBlendNode && inputEdges.length > 0 && outputEdges.length > 0) {
    // For non-blend nodes, there should be only one input edge
    const inputEdge = inputEdges[0];
    
    // Create new edges connecting the input node directly to all output nodes
    const newEdges = outputEdges.map((outputEdge, index) => ({
      id: `e${inputEdge.source}-${outputEdge.target}-${Date.now()}-${index}`,
      source: inputEdge.source,
      target: outputEdge.target,
      sourceHandle: inputEdge.sourceHandle,
      targetHandle: outputEdge.targetHandle
    }));
    
    // Update edges: remove old edges and add new rewired edges
    flowEdges.update(edges => {
      // Remove all edges connected to the deleted node
      const filteredEdges = edges.filter(edge => 
        edge.source !== nodeId && edge.target !== nodeId
      );
      // Add new rewired edges
      return [...filteredEdges, ...newEdges];
    });
  } else {
    // For blend nodes or nodes without both input/output, just remove connected edges
    flowEdges.update(edges => 
      edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId)
    );
  }
  
  // Remove the node
  flowNodes.update(nodes => nodes.filter(n => n.id !== nodeId));
  
  // Clean up node parameters
  nodeParameters.update(params => {
    params.delete(nodeId);
    return params;
  });
} 
// Pattern serialization imports and utilities
import type { SerializedPattern } from './patternSerializer';
import { serializePattern, deserializePattern, estimatePatternSize, compressPattern } from './patternSerializer';
import { syncPatternToAllDevices } from './ble';

// Pattern serialization utilities
export function serializeCurrentPattern(patternName?: string): SerializedPattern {
  let currentNodes: Node[] = [];
  let currentEdges: Edge[] = [];
  let currentParams: Map<string, Map<string, any>> = new Map();

  flowNodes.subscribe(nodes => currentNodes = nodes)();
  flowEdges.subscribe(edges => currentEdges = edges)();
  nodeParameters.subscribe(params => currentParams = params)();

  return serializePattern(currentNodes, currentEdges, currentParams, patternName);
}

export function loadSerializedPattern(serializedPattern: SerializedPattern): void {
  const { nodes, edges, nodeParameters: newNodeParameters } = deserializePattern(serializedPattern);
  
  // Update all stores with new pattern
  nodeParameters.set(newNodeParameters);
  flowNodes.set(nodes);
  flowEdges.set(edges);
  
  // Set next node ID to be higher than any existing node ID
  const numericIds = nodes.map(n => parseInt(n.id.replace(/\D+/g, ''), 10)).filter(v => !isNaN(v));
  const maxId = numericIds.length ? Math.max(...numericIds) : 0;
  nextNodeId.set(maxId + 1);
  
  // Mark pattern as clean after loading
  markPatternClean();
}

// Initialize flow with default pattern if no patterns exist
export function initializeDefaultPattern(): void {
  // Create default nodes
  const defaultNodes: Node[] = [
    createNodeFromType(NODE_TYPES[1], '1', { x: LANES.CENTER, y: 100 }),        // First pattern node (rainbow)
    createNodeFromType(NODE_TYPES[0], '2', { x: LANES.CENTER, y: 250 })         // Output node
  ];

  // Create default edge
  const defaultEdges: Edge[] = [
    { 
      id: 'e1-2', 
      source: '1', 
      target: '2', 
    }
  ];

  // Set the stores
  flowNodes.set(defaultNodes);
  flowEdges.set(defaultEdges);
  nextNodeId.set(3);
  
  // Mark as clean after initialization
  markPatternClean();
}

// Initialize an empty pattern with just the output node (for when all patterns are deleted)
export function initializeEmptyPattern(): void {
  // Reset all stores first
  nodeParameters.set(new Map());
  
  // Create default output node only
  const outputNode: Node = createNodeFromType(NODE_TYPES[0], '1', { x: LANES.CENTER, y: 250 });

  // Set the stores with just the output node
  flowNodes.set([outputNode]);
  flowEdges.set([]);
  nextNodeId.set(2);
  
  // Mark as clean after initialization
  markPatternClean();
}

export function getPatternSizeEstimate(): number {
  const pattern = serializeCurrentPattern();
  return estimatePatternSize(pattern);
}

export function getPatternForBLE(): string {
  const pattern = serializeCurrentPattern();
  return compressPattern(pattern);
}

// Automatic pattern sync when pattern changes
let lastPatternHash: string | null = null;
let syncTimeout: NodeJS.Timeout | null = null;

function syncPatternIfChanged() {
  try {
    const currentPattern = serializeCurrentPattern();
    const currentHash = JSON.stringify(currentPattern);
    
    if (lastPatternHash && lastPatternHash !== currentHash) {
      // Clear existing timeout if any
      if (syncTimeout) {
        clearTimeout(syncTimeout);
      }
      
      // Debounce pattern sync to avoid excessive calls during editing
      syncTimeout = setTimeout(async () => {
        try {
          await syncPatternToAllDevices();
          console.log('Pattern auto-synced to devices');
        } catch (error) {
          console.error('Failed to auto-sync pattern:', error);
        }
      }, 500); // 500ms debounce
    }
    
    lastPatternHash = currentHash;
  } catch (error) {
    console.error('Error in pattern sync check:', error);
  }
}

// Subscribe to pattern changes for auto-sync
flowNodes.subscribe(() => syncPatternIfChanged());
flowEdges.subscribe(() => syncPatternIfChanged());
nodeParameters.subscribe(() => syncPatternIfChanged());
