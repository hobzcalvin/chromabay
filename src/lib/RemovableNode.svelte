<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  export let id: string;
  export let data: { label: string; onDelete?: (id: string) => void };
</script>

<div class="removable-node">
  <button class="close-btn" on:click={() => data.onDelete?.(id)}>×</button>
  {#if typeof data.label === 'string'}
    <span>{data.label}</span>
  {:else}
    <svelte:component this={data.label} />
  {/if}
  <Handle type="target" position={Position.Top} />
  <Handle type="source" position={Position.Bottom} />
</div>

<style>
  .removable-node {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .close-btn {
    position: absolute;
    top: -6px;
    left: -6px;
    background: #ef4444;
    color: white;
    border: none;
    border-radius: 50%;
    width: 16px;
    height: 16px;
    font-size: 12px;
    line-height: 16px;
    padding: 0;
    cursor: pointer;
  }
</style>
