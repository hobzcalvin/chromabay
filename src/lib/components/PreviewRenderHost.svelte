<script lang="ts">
  // Mounted ONCE (in the root layout). Renders exactly one hidden PatternRenderSource per
  // unique pattern that any PatternPreview is currently showing, so each pattern renders once
  // no matter how many places it appears.
  import { activePreviews } from '$lib/stores/previewRender';
  import PatternRenderSource from './PatternRenderSource.svelte';
</script>

<div class="preview-render-host" aria-hidden="true">
  {#each $activePreviews as e (e.key)}
    <PatternRenderSource pattern={e.pattern} pkey={e.key} />
  {/each}
</div>

<style>
  .preview-render-host { display: none; }
</style>
