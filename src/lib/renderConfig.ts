import { writable } from 'svelte/store';

// Configuration for rendering dimensions
export interface RenderConfig {
  width: number;
  height: number;
  maxWidth: number; // Cap for very wide screens
  maxHeight: number; // Cap for very tall screens
}

// Default rendering configuration - CONSERVATIVE LIMITS to prevent memory explosion
const DEFAULT_CONFIG: RenderConfig = {
  width: 100,
  height: 50,
  maxWidth: 500, // Conservative limit - 500x500 is plenty for patterns
  maxHeight: 500, // Conservative limit - 500x500 is plenty for patterns
};

// Create a writable store for render configuration
export const renderConfig = writable<RenderConfig>(DEFAULT_CONFIG);

// Helper function to update rendering dimensions
export function setRenderDimensions(width: number, height: number): void {
  renderConfig.update(config => ({
    ...config,
    width: Math.min(width, config.maxWidth),
    height: Math.min(height, config.maxHeight)
  }));
}

// Helper function to set fullscreen dimensions
export function setFullscreenDimensions(screenWidth: number, screenHeight: number): void {
  const config = DEFAULT_CONFIG;
  
  // For fullscreen, use the actual screen dimensions but cap them at reasonable limits
  const width = Math.min(screenWidth, config.maxWidth);
  const height = Math.min(screenHeight, config.maxHeight);
  
  setRenderDimensions(width, height);
}

// Helper function to reset to default dimensions
export function resetToDefaultDimensions(): void {
  renderConfig.set(DEFAULT_CONFIG);
}

// Helper function to get current config synchronously
export function getCurrentRenderConfig(): RenderConfig {
  let config = DEFAULT_CONFIG;
  renderConfig.subscribe(c => {
    config = c;
  })();
  return config;
}
