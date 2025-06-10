import { writable } from 'svelte/store';
import type { Node, Edge } from '@xyflow/svelte';

// Define LED pattern node types
export const NODE_TYPES = [
  { name: 'Rainbow', emoji: '🌙', color: '#10b981', type: 'rainbow' },
  { name: 'Gradient', emoji: '🌈', color: '#3b82f6', type: 'gradient' },
  { name: 'Perlin Noise', emoji: '🌊', color: '#8b5cf6', type: 'perlin_noise' },
  { name: 'Moving Blob', emoji: '💧', color: '#f59e0b', type: 'moving_blob' },
  { name: 'Raindrops', emoji: '🌧️', color: '#06b6d4', type: 'raindrops' },
  { name: 'Strobe', emoji: '⚡', color: '#ef4444', type: 'strobe' },
  { name: 'Sparkle', emoji: '✨', color: '#ec4899', type: 'sparkle' },
  { name: 'Fade', emoji: '🌅', color: '#84cc16', type: 'fade' },
  { name: 'Chase', emoji: '🏃', color: '#f97316', type: 'chase' },
  { name: 'Twinkle', emoji: '⭐', color: '#6366f1', type: 'twinkle' },
  { name: 'Blend', emoji: '🎨', color: '#8b5cf6', type: 'blend' }
];

// Define the 3 vertical lanes for node snapping
const LANES = {
  LEFT: 25,
  CENTER: 175,
  RIGHT: 325
};

// Define initial nodes for the pattern editor with lane positioning and fixed width
const initialNodes: Node[] = [
  {
    id: '1',
    type: 'pattern',
    position: { x: LANES.CENTER, y: 100 },
    data: { 
      label: `${NODE_TYPES[0].emoji} ${NODE_TYPES[0].name}`,
      type: NODE_TYPES[0].type
    },
    style: ''
  },
  {
    id: '2',
    type: 'pattern',
    position: { x: LANES.CENTER, y: 250 },
    data: { 
      label: '🏁 Output',
      type: 'output'
    },
    style: ''
  }
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