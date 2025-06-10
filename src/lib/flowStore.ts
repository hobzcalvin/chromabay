import { writable } from 'svelte/store';
import type { Node, Edge } from '@xyflow/svelte';

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

// Type for render function parameters
export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  time: number;
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
  render: (context: RenderContext) => void;
}

// Define LED pattern node types with their render functions
export const NODE_TYPES: NodeDefinition[] = [
  {
    name: 'Rainbow',
    type: 'rainbow',
    render: ({ ctx, time, width, height }) => {
      for (let i = 0; i < width; i++) {
        const hue = (i / width + time * 0.1) % 1;
        const [r, g, b] = hslToRgb(hue, 1, 0.5);
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(i, 0, 1, height);
      }
    }
  },
  {
    name: 'Gradient',
    type: 'gradient',
    render: ({ ctx, width, height }) => {
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, '#3b82f6');
      gradient.addColorStop(1, '#8b5cf6');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }
  },
  {
    name: 'Perlin Noise',
    type: 'perlin_noise',
    render: ({ ctx, time, width, height }) => {
      for (let x = 0; x < width; x += 2) {
        for (let y = 0; y < height; y += 2) {
          const noise = Math.sin(x * 0.1 + time) * Math.cos(y * 0.1 + time);
          const intensity = Math.floor((noise + 1) * 127.5);
          ctx.fillStyle = `rgb(${intensity}, ${intensity}, ${intensity})`;
          ctx.fillRect(x, y, 2, 2);
        }
      }
    }
  },
  {
    name: 'Moving Blob',
    type: 'moving_blob',
    render: ({ ctx, time, width, height }) => {
      const centerX = width/2 + Math.sin(time * 2) * (width * 0.2);
      const centerY = height/2 + Math.cos(time * 1.5) * (height * 0.2);
      const innerRadius = Math.min(width, height) * 0.06;
      const outerRadius = Math.min(width, height) * 0.25;
      const radialGradient = ctx.createRadialGradient(centerX, centerY, innerRadius, centerX, centerY, outerRadius);
      radialGradient.addColorStop(0, '#00ffff');
      radialGradient.addColorStop(1, 'transparent');
      ctx.fillStyle = radialGradient;
      ctx.fillRect(0, 0, width, height);
    }
  },
  {
    name: 'Raindrops',
    type: 'raindrops',
    render: ({ ctx, time, width, height }) => {
      const dropCount = Math.floor(width / 16);
      for (let i = 0; i < dropCount; i++) {
        const x = (i * (width / dropCount) + width / (dropCount * 2)) % width;
        const y = ((time * 50 + i * 10) % (height + 10)) - 10;
        if (y >= 0 && y <= height) {
          ctx.fillStyle = '#4fc3f7';
          ctx.beginPath();
          const dropWidth = width * 0.025;
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
    render: ({ ctx, time, width, height }) => {
      const intensity = Math.sin(time * 8) > 0.7 ? 1 : 0;
      if (intensity > 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.fillRect(0, 0, width, height);
      }
    }
  },
  {
    name: 'Sparkle',
    type: 'sparkle',
    render: ({ ctx, time, width, height }) => {
      const sparkleCount = Math.floor(width / 10);
      for (let i = 0; i < sparkleCount; i++) {
        const x = (width / sparkleCount) * 0.2 + i * (width / sparkleCount);
        const y = height/2 + Math.sin(i * 2) * (height * 0.32);
        const alpha = Math.abs(Math.sin(time * 3 + i)) * 0.8 + 0.2;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        const sparkleRadius = Math.min(width, height) * 0.025;
        ctx.arc(x, y, sparkleRadius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  },
  {
    name: 'Fade',
    type: 'fade',
    render: ({ ctx, time, width, height }) => {
      const fadeIntensity = (Math.sin(time) + 1) * 0.5;
      ctx.globalAlpha = fadeIntensity;
      ctx.fillStyle = '#ff6b35';
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;
    }
  },
  {
    name: 'Chase',
    type: 'chase',
    render: ({ ctx, time, width, height }) => {
      const position = (time * 20) % width;
      ctx.fillStyle = '#00ff00';
      ctx.beginPath();
      const chaseRadius = Math.min(width, height) * 0.1;
      ctx.arc(position, height/2, chaseRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  {
    name: 'Twinkle',
    type: 'twinkle',
    render: ({ ctx, time, width, height }) => {
      const twinkleCount = Math.floor(width * height / 200);
      for (let i = 0; i < twinkleCount; i++) {
        const x = (i * (width / 6)) % width;
        const y = (height * 0.4) + (i % 3) * (height * 0.4);
        const alpha = Math.sin(time * 4 + i * 0.5) > 0.5 ? 0.9 : 0.1;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#ffff88';
        ctx.beginPath();
        const twinkleRadius = Math.min(width, height) * 0.0125;
        ctx.arc(x, y, twinkleRadius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  },
  {
    name: 'Blend',
    type: 'blend',
    render: ({ ctx, width, height, getInputNodes, getNodeOutput }) => {
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
          
          // Simple additive blend
          data[i] = Math.min(255, r1 + r2);
          data[i + 1] = Math.min(255, g1 + g2);
          data[i + 2] = Math.min(255, b1 + b2);
          data[i + 3] = 255;
        }
        
        ctx.putImageData(imageData, 0, 0);
      }
    }
  },
  {
    name: 'Output',
    type: 'output',
    render: () => {
      // Output node doesn't render anything - it just passes through input
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
  createNodeFromType(NODE_TYPES[0], '1', { x: LANES.CENTER, y: 100 }),        // First pattern node
  createNodeFromType(NODE_TYPES[NODE_TYPES.length - 1], '2', { x: LANES.CENTER, y: 250 })  // Output node (last in array)
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