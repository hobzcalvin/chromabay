<script lang="ts">
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  
  let { data }: NodeProps = $props();
</script>

<div class="blend-node">
  <div class="blend-content">
    {data.label}
  </div>
  
  <!-- Two target handles on top -->
  <Handle type="target" position={Position.Top} id="input-1" style="left: 30%" />
  <Handle type="target" position={Position.Top} id="input-2" style="left: 70%" />
  
  <!-- One source handle on bottom -->
  <Handle type="source" position={Position.Bottom} id="output" style="left: 50%" />
</div>

<style>
  .blend-node {
    position: relative;
    background: #8b5cf6;
    color: white;
    border: none;
    font-weight: bold;
    width: 100px;
    height: 50px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  
  .blend-content {
    text-align: center;
    font-size: 12px;
  }
</style> 