<script lang="ts">
  import { onMount } from 'svelte';
  import PatternRenderer from '$lib/components/PatternRenderer.svelte';
  import RotaryKnob from '$lib/components/RotaryKnob.svelte';

  let showNotification = true;
  let notificationVisible = true;
  let knobValue1 = 50;
  let knobValue2 = 75;

  function handleKnob1Change(event: CustomEvent<number>) {
    knobValue1 = event.detail;
    console.log('Knob 1 value:', knobValue1);
  }

  function handleKnob2Change(event: CustomEvent<number>) {
    knobValue2 = event.detail;
    console.log('Knob 2 value:', knobValue2);
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

<!-- Rotary knobs overlay -->
<div class="knobs-overlay">
  <div class="knob-container">
    <RotaryKnob
      bind:value={knobValue1}
      min={0}
      max={100}
      step={0.1}
      size={200}
      preciseMode={false}
      on:change={handleKnob1Change}
    />
    <div class="knob-label">Speed</div>
  </div>
  
  <div class="knob-container">
    <RotaryKnob
      bind:value={knobValue2}
      min={0}
      max={100}
      step={0.1}
      size={200}
      preciseMode={false}
      on:change={handleKnob2Change}
    />
    <div class="knob-label">Intensity</div>
  </div>
</div>

<!-- Temporary notification -->
{#if showNotification}
  <div class="notification" class:fade-out={!notificationVisible}>
    Use swipe or browser back to leave Interact mode
  </div>
{/if}

<style>
  .knobs-overlay {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 10;
    pointer-events: auto;
    display: flex;
    gap: 60px;
    align-items: center;
  }

  .knob-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }

  .knob-label {
    color: white;
    font-size: 18px;
    font-weight: 500;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.8);
    text-align: center;
    pointer-events: none;
  }

  /* Responsive design for mobile */
  @media (max-width: 768px) {
    .knobs-overlay {
      flex-direction: column;
      gap: 40px;
    }
    
    .knob-container {
      gap: 12px;
    }
    
    .knob-label {
      font-size: 16px;
    }
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
