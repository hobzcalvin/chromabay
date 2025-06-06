<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { getConnectedDeviceCount } from '$lib/ble';

  let connected = 0;
  let interval: any;
  onMount(() => {
    connected = getConnectedDeviceCount();
    interval = setInterval(() => {
      connected = getConnectedDeviceCount();
    }, 1000);
    return () => clearInterval(interval);
  });
</script>

<slot />

<nav class="bottom-nav">
  <a href="/devices" class:active={$page.url.pathname.startsWith('/devices')}
    >Devices
    <span 
      class="badge" 
      class:green={connected>0} 
      class:red={connected===0}
      data-single-digit={connected >= 0 && connected <= 9 ? 'true' : 'false'}
    >{connected}</span>
  </a>
  <a href="/patterns" class:active={$page.url.pathname.startsWith('/patterns')}>Patterns</a>
  <a href="/editor" class:active={$page.url.pathname.startsWith('/editor')}>Editor</a>
  <a href="/interact" class:active={$page.url.pathname.startsWith('/interact')}>Interact</a>
  <a href="/settings" class:active={$page.url.pathname.startsWith('/settings')}>Settings</a>
</nav>

<style>
  /* Universal safe area support for all pages */
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
    padding: 0;
  }

  /* ONE clean safe area implementation */
  :global(main) {
    max-width: 1000px !important;
    margin: 0 auto !important;
    padding: 1rem !important; /* 16px on all sides */
    
    /* Simple: just use safe area insets */
    padding-top: env(safe-area-inset-top, 0px) !important;
    padding-right: max(1rem, env(safe-area-inset-right, 1rem)) !important;
    padding-bottom: max(5rem, env(safe-area-inset-bottom, 5rem)) !important;
    padding-left: max(1rem, env(safe-area-inset-left, 1rem)) !important;
    
    color: white !important;
    min-height: calc(100vh - env(safe-area-inset-top) - env(safe-area-inset-bottom)) !important;
  }

  .bottom-nav {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    justify-content: space-around;
    align-items: stretch;
    background: rgba(0, 0, 0, 0.95);
    backdrop-filter: blur(20px);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    padding: 0.75rem 0.5rem;
    padding-bottom: max(0.75rem, calc(env(safe-area-inset-bottom, 0px) + 0.5rem));
    box-sizing: border-box;
    min-height: 60px;
  }
  
  .bottom-nav a {
    color: rgba(255, 255, 255, 0.7);
    text-decoration: none;
    padding: 0.75rem 0.5rem;
    font-size: 0.85rem;
    position: relative;
    border-radius: 12px;
    font-weight: 500;
    flex: 1;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-width: 0;
    box-sizing: border-box;
  }
  
  .bottom-nav a.active {
    font-weight: 900;
    color: white;
    background: rgba(102, 126, 234, 0.3);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(102, 126, 234, 0.5);
    box-shadow: 0 2px 8px rgba(102, 126, 234, 0.2);
  }
  
  @media (max-width: 480px) {
    .bottom-nav a {
      font-size: 0.75rem;
      padding: 0.5rem 0.25rem;
    }
  }
  
  @media (max-width: 320px) {
    .bottom-nav a {
      font-size: 0.7rem;
      padding: 0.5rem 0.1rem;
    }
  }
  
  .badge {
    position: absolute;
    top: 2px;
    right: 8px;
    transform: translate(50%,-50%);
    padding: 2px;
    border-radius: 50%;
    font-size: 0.7rem;
    color: #fff;
    min-width: 18px;
    min-height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    font-weight: 600;
    pointer-events: none;
    width: auto;
    height: 18px;
    line-height: 1;
  }
  
  .badge:not(:empty) {
    padding: 2px 6px;
    border-radius: 9px;
  }
  
  .badge[data-single-digit="true"] {
    border-radius: 50%;
    padding: 2px;
    min-width: 18px;
    width: 18px;
  }
  
  .badge.green {
    background-color: #16a34a;
    box-shadow: 0 0 8px rgba(22, 163, 74, 0.4);
  }
  
  .badge.red {
    background-color: #dc2626;
    box-shadow: 0 0 8px rgba(220, 38, 38, 0.4);
  }
</style>
