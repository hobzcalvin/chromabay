<script lang="ts">
  // Hidden, one per UNIQUE pattern (see previewRender.ts). Runs the full render pipeline
  // (hidden SvelteFlow graph + WASM operators) once and publishes each output frame to the
  // shared registry; visible PatternPreview instances just blit those frames. This is the old
  // PatternPreview's rendering half, minus the visible canvas.
  import { onDestroy, setContext } from 'svelte';
  import { writable } from 'svelte/store';
  import type { SerializedPattern } from '$lib/patternSerializer';
  import { deserializePatternWhenReady } from '$lib/patternSerializer';
  import { clearNodeModulators } from '$lib/stores/modulatorStore';
  import { publishPreviewFrame } from '$lib/stores/previewRender';
  import ContextualPatternNode from './ContextualPatternNode.svelte';
  import { SvelteFlow, type Node, type Edge } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';

  export let pattern: SerializedPattern;
  export let pkey: string;

  const nodeTypes = { pattern: ContextualPatternNode };

  // LOCAL stores for this source only — isolated from global state.
  const localFlowNodes = writable<Node[]>([]);
  const localFlowEdges = writable<Edge[]>([]);
  const localNodeOutputs = writable<Map<string, ImageData>>(new Map());
  const localNodeParameters = writable<Map<string, any>>(new Map());
  const localGlobalStartTime = writable<number>(Date.now());
  setContext('flowNodes', localFlowNodes);
  setContext('flowEdges', localFlowEdges);
  setContext('nodeOutputs', localNodeOutputs);
  setContext('nodeParameters', localNodeParameters);
  setContext('globalStartTime', localGlobalStartTime);

  let animationFrame: number | null = null;
  let modulatedNodeIds: string[] = [];
  let loadedPattern: SerializedPattern | null = null;

  $: outputNodeId = $localFlowNodes.find(n => n.data.type === 'output')?.id ?? '';

  function animate() {
    if (outputNodeId) {
      const data = $localNodeOutputs.get(outputNodeId);
      if (data) publishPreviewFrame(pkey, data);
    }
    animationFrame = requestAnimationFrame(animate);
  }

  function loadPattern(p: SerializedPattern) {
    for (const id of modulatedNodeIds) clearNodeModulators(id);
    modulatedNodeIds = [];
    deserializePatternWhenReady(p, 5000, { applyInteractiveParameters: false, applyModulators: true })
      .then(({ nodes, edges, nodeParameters }) => {
        if (p !== pattern) return;
        localFlowNodes.set(nodes);
        localFlowEdges.set(edges);
        localNodeParameters.set(nodeParameters);
        modulatedNodeIds = nodes.map((n) => n.id);
      })
      .catch((err) => console.warn('PatternRenderSource: failed to deserialize', err));
  }

  $: if (pattern && pattern !== loadedPattern) { loadedPattern = pattern; loadPattern(pattern); }

  // Start the frame loop immediately (module context is available synchronously).
  if (typeof requestAnimationFrame !== 'undefined') animationFrame = requestAnimationFrame(animate);

  onDestroy(() => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    for (const id of modulatedNodeIds) clearNodeModulators(id);
  });
</script>

<div class="hidden-flow">
  <SvelteFlow
    bind:nodes={$localFlowNodes}
    bind:edges={$localFlowEdges}
    {nodeTypes}
    proOptions={{ hideAttribution: true }}
    nodesConnectable={false}
    edgesFocusable={false}
    nodesDraggable={false}
    elementsSelectable={false}
    panOnDrag={false}
    zoomOnScroll={false}
    zoomOnDoubleClick={false}
    zoomOnPinch={false}
  />
</div>

<style>
  .hidden-flow { display: none; }
</style>
