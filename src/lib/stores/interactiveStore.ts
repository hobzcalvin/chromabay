/**
 * Store for tracking which parameters are marked as interactive
 * Interactive parameters get knobs on the interact page
 */

import { writable, get } from 'svelte/store';

// Store for interactive parameter flags - keyed by nodeId, then by parameter name
export const interactiveParameters = writable<Map<string, Map<string, boolean>>>(new Map());

// Maximum number of interactive parameters allowed
export const MAX_INTERACTIVE_PARAMS = 6;

// Helper function to get if a parameter is interactive
export function getParameterInteractive(nodeId: string, paramName: string): boolean {
  const currentParams = get(interactiveParameters);
  
  const nodeParams = currentParams.get(nodeId);
  if (nodeParams?.has(paramName)) {
    return nodeParams.get(paramName) || false;
  }
  return false;
}

// Helper function to set parameter interactive status
export function setParameterInteractive(nodeId: string, paramName: string, interactive: boolean): boolean {
  const currentParams = get(interactiveParameters);
  
  // If setting to true, check the total count
  if (interactive) {
    const totalInteractive = getTotalInteractiveCount(currentParams);
    const currentlyInteractive = getParameterInteractive(nodeId, paramName);
    
    // If we're already at max and this parameter isn't already interactive, return false
    if (totalInteractive >= MAX_INTERACTIVE_PARAMS && !currentlyInteractive) {
      return false;
    }
  }
  
  interactiveParameters.update(params => {
    if (!params.has(nodeId)) {
      params.set(nodeId, new Map());
    }
    const nodeParams = params.get(nodeId);
    if (nodeParams) {
      nodeParams.set(paramName, interactive);
    }
    return params;
  });
  
  return true;
}

// Helper function to get total count of interactive parameters across all nodes
function getTotalInteractiveCount(params: Map<string, Map<string, boolean>>): number {
  let count = 0;
  for (const nodeParams of params.values()) {
    for (const isInteractive of nodeParams.values()) {
      if (isInteractive) count++;
    }
  }
  return count;
}

// Get total count of interactive parameters (public version)
export function getTotalInteractiveParameterCount(): number {
  const currentParams = get(interactiveParameters);
  return getTotalInteractiveCount(currentParams);
}

// Get all interactive parameters in order (for generating knobs)
export interface InteractiveParameter {
  nodeId: string;
  paramName: string;
  nodeType: string;
  paramLabel: string;
  order: number;
}

export function getAllInteractiveParameters(): InteractiveParameter[] {
  const currentParams = get(interactiveParameters);
  
  const interactiveParams: InteractiveParameter[] = [];
  
  for (const [nodeId, nodeParams] of currentParams.entries()) {
    for (const [paramName, isInteractive] of nodeParams.entries()) {
      if (isInteractive) {
        // We'll need to get node type and param label from the flow store
        // For now, just store the basic info
        interactiveParams.push({
          nodeId,
          paramName,
          nodeType: '', // Will be filled by caller
          paramLabel: paramName, // Will be filled by caller
          order: 0 // Will be set based on serialization order
        });
      }
    }
  }
  
  return interactiveParams;
}

// Clear all interactive parameters for a node (useful when node is deleted)
export function clearNodeInteractiveParameters(nodeId: string): void {
  interactiveParameters.update(params => {
    params.delete(nodeId);
    return params;
  });
}
