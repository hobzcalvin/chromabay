<script lang="ts">
  import { onMount } from 'svelte';
  import PatternRenderer from '$lib/components/PatternRenderer.svelte';
  import RotaryKnob from '$lib/components/RotaryKnob.svelte';

  let showNotification = true;
  let notificationVisible = true;
  let knobValue = 50;

  function handleKnobChange(event: CustomEvent<number>) {
    knobValue = event.detail;
    console.log('Knob value:', knobValue);
  }

  onMount(() => {
    // Start fade out after 2 seconds, then hide after transition
    setTimeout(() => {
      notificationVisible = false;
    }, 2000);
    
    setTimeout(() => {
      showNotification = false;
    }, 3000);
  });
</script>

<!-- Full-screen pattern renderer -->
<PatternRenderer fullscreen={true} />

<!-- Rotary knob overlay -->
<div class="knob-overlay">
  <RotaryKnob
    bind:value={knobValue}
    min={0}
    max={100}
    step={0.1}
    size={250}
    on:change={handleKnobChange}
  />
</div>

<!-- Temporary notification -->
{#if showNotification}
  <div class="notification" class:fade-out={!notificationVisible}>
    Use swipe or browser back to leave Interact mode
  </div>
{/if}

<style>
  .knob-overlay {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 10;
    pointer-events: auto;
  }

  .notification {
    position: fixed;
    top: 20%;
    left: 50%;
    transform: translate(-50%, -50%);
    background-color: rgba(0, 0, 0, 0.8);
    color: white;
    padding: 16px 24px;
    border-radius: 12px;
    font-size: 16px;
    font-weight: 500;
    text-align: center;
    z-index: 1000;
    pointer-events: none;
    backdrop-filter: blur(4px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    opacity: 1;
    transition: opacity 1s ease-out;
  }

  .notification.fade-out {
    opacity: 0;
  }
</style>
