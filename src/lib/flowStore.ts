import { writable } from 'svelte/store';
import type { Node, Edge } from '@xyflow/svelte';

// Global start time for synchronized animations across all nodes
export const globalStartTime = writable<number>(performance.now());

// Parameter types
export type ParameterType = 'float' | 'range' | 'integer' | 'hue' | 'color';

export interface Parameter {
  label: string;
  name: string;
  type: ParameterType;
  default: any;
  min?: number;
  max?: number;
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
      { label: 'Lightness', name: 'lightness', type: 'float', default: 0.5 }
    ],
    render: ({ ctx, totalTime, width, height, nodeId }) => {
      const speed = getNodeParameter(nodeId, 'speed', 0.1);
      const saturation = getNodeParameter(nodeId, 'saturation', 1.0);
      const lightness = getNodeParameter(nodeId, 'lightness', 0.5);
      
      for (let i = 0; i < width; i++) {
        const hue = (i / width + totalTime * speed) % 1;
        const [r, g, b] = hslToRgb(hue, saturation, lightness);
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(i, 0, 1, height);
      }
    }
  },
  {
    name: 'Gradient',
    type: 'gradient',
    params: [
      { label: 'Color 1', name: 'color1', type: 'color', default: '#3b82f6' },
      { label: 'Color 2', name: 'color2', type: 'color', default: '#8b5cf6' }
    ],
    render: ({ ctx, width, height, nodeId }) => {
      const color1 = getNodeParameter(nodeId, 'color1', '#3b82f6');
      const color2 = getNodeParameter(nodeId, 'color2', '#8b5cf6');
      
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, color1);
      gradient.addColorStop(1, color2);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }
  },
  {
    name: 'Perlin Noise',
    type: 'perlin_noise',
    params: [
      { label: 'Speed', name: 'speed', type: 'float', default: 1.0 },
      { label: 'Scale', name: 'scale', type: 'float', default: 0.1 },
      { label: 'Intensity', name: 'intensity', type: 'float', default: 1.0 }
    ],
    render: ({ ctx, totalTime, width, height, nodeId }) => {
      const speed = getNodeParameter(nodeId, 'speed', 1.0);
      const scale = getNodeParameter(nodeId, 'scale', 0.1);
      const intensity = getNodeParameter(nodeId, 'intensity', 1.0);
      
      // Create noise overlay
      for (let x = 0; x < width; x += 1) {
        for (let y = 0; y < height; y += 1) {
          const noise = Math.sin(x * scale + totalTime * speed) * Math.cos(y * scale + totalTime * speed);
          const alpha = ((noise + 1) * 0.5) * intensity; // Normalize to 0-1 and apply intensity
          ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
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
      { label: 'Opacity', name: 'opacity', type: 'float', default: 0.5 }
    ],
    render: ({ ctx, width, height, getInputNodes, getNodeOutput, nodeId }) => {
      const opacity = getNodeParameter(nodeId, 'opacity', 0.5);
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
          
          // Blend with opacity control
          data[i] = Math.min(255, r1 * (1 - opacity) + r2 * opacity);
          data[i + 1] = Math.min(255, g1 * (1 - opacity) + g2 * opacity);
          data[i + 2] = Math.min(255, b1 * (1 - opacity) + b2 * opacity);
          data[i + 3] = 255;
        }
        
        ctx.putImageData(imageData, 0, 0);
      }
    }
  }
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

// Define initial nodes for the pattern editor with lane positioning and fixed width
const initialNodes: Node[] = [
  createNodeFromType(NODE_TYPES[1], '1', { x: LANES.CENTER, y: 100 }),        // First pattern node (index 1)
  createNodeFromType(NODE_TYPES[0], '2', { x: LANES.CENTER, y: 250 })         // Output node (index 0)
];

// Define initial edges with better styling
const initialEdges: Edge[] = [
  { 
    id: 'e1-2', 
    source: '1', 
    target: '2', 
  }
];

// Create persistent stores for nodes and edges
export const flowNodes = writable<Node[]>(initialNodes);
export const flowEdges = writable<Edge[]>(initialEdges);

// Keep track of next available ID
export const nextNodeId = writable(3);

// Shared store for node outputs so nodes can access each other's rendered data
export const nodeOutputs = writable<Map<string, ImageData>>(new Map());

// Export lanes for use in components
export { LANES }; 