<script lang="ts">
  import { onMount } from 'svelte';
  import PatternRenderer from '$lib/components/PatternRenderer.svelte';

  let showNotification = true;
  let notificationVisible = true;

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

<!-- Temporary notification -->
{#if showNotification}
  <div class="notification" class:fade-out={!notificationVisible}>
    Use swipe or browser back to leave Interact mode
  </div>
{/if}

<style>
  .notification {
    position: fixed;
    top: 50%;
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
