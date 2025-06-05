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
    <span class="badge" class:green={connected>0} class:red={connected===0}>{connected}</span>
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
    /* Ensure the viewport extends into safe areas */
    padding: 0;
  }

  :global(html) {
    /* Support older iOS versions */
    padding-top: constant(safe-area-inset-top);
    padding-top: env(safe-area-inset-top);
  }

  /* Universal main content safe area handling */
  :global(main) {
    max-width: 1000px;
    margin: 0 auto;
    /* Base padding with safe area support */
    padding: 2rem;
    
    /* AGGRESSIVE NOTCH FIX - Use much larger top padding */
    padding-top: max(4rem, env(safe-area-inset-top, 4rem));
    
    padding-right: max(2rem, env(safe-area-inset-right, 2rem));
    padding-bottom: max(6rem, env(safe-area-inset-bottom, 6rem)); /* Extra bottom for nav */
    padding-left: max(2rem, env(safe-area-inset-left, 2rem));
    
    color: white;
    
    /* Ensure minimum top padding for notched devices */
    min-height: calc(100vh - env(safe-area-inset-top) - env(safe-area-inset-bottom));
  }

  /* Additional safe area support for mobile devices */
  @supports (padding: max(0px)) {
    :global(main) {
      /* iOS 11.0+ with aggressive top padding */
      padding-top: max(4rem, env(safe-area-inset-top));
      padding-right: max(2rem, env(safe-area-inset-right));
      padding-bottom: max(6rem, env(safe-area-inset-bottom, 6rem));
      padding-left: max(2rem, env(safe-area-inset-left));
    }
  }

  /* Even more aggressive fallbacks for notched devices */
  @media screen and (device-aspect-ratio: 375/812) {
    /* iPhone X, XS */
    :global(main) { padding-top: max(5rem, env(safe-area-inset-top, 5rem)); }
  }
  
  @media screen and (device-aspect-ratio: 414/896) {
    /* iPhone XR, XS Max, 11, 11 Pro Max */
    :global(main) { padding-top: max(5rem, env(safe-area-inset-top, 5rem)); }
  }
  
  @media screen and (device-aspect-ratio: 390/844) {
    /* iPhone 12, 12 Pro, 13, 13 Pro, 14 */
    :global(main) { padding-top: max(5rem, env(safe-area-inset-top, 5rem)); }
  }
  
  @media screen and (device-aspect-ratio: 428/926) {
    /* iPhone 12 Pro Max, 13 Pro Max, 14 Plus */
    :global(main) { padding-top: max(5rem, env(safe-area-inset-top, 5rem)); }
  }
  
  @media screen and (device-aspect-ratio: 393/852) {
    /* iPhone 14 Pro */
    :global(main) { padding-top: max(5rem, env(safe-area-inset-top, 5rem)); }
  }
  
  @media screen and (device-aspect-ratio: 430/932) {
    /* iPhone 14 Pro Max, 15 Pro Max */
    :global(main) { padding-top: max(5rem, env(safe-area-inset-top, 5rem)); }
  }

  @media (max-width: 768px) {
    :global(main) {
      padding: 1rem;
      /* Maintain safe area support on mobile */
      padding-top: max(3rem, env(safe-area-inset-top, 3rem));
      padding-bottom: max(5rem, env(safe-area-inset-bottom, 5rem));
    }
  }

  .bottom-nav {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    justify-content: space-around;
    background: rgba(0,0,0,0.8);
    padding: 0.5rem 0;
    /* Safe area support for bottom navigation */
    padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0.5rem));
  }
  
  .bottom-nav a {
    color: white;
    text-decoration: none;
    padding: 0.5rem;
    font-size: 0.9rem;
    position: relative;
  }
  
  .bottom-nav a.active {
    font-weight: bold;
  }
  
  .badge {
    position: absolute;
    top: 0;
    right: 0;
    transform: translate(50%,-50%);
    padding: 0 6px;
    border-radius: 9999px;
    font-size: 0.7rem;
    color: #fff;
  }
  
  .badge.green {
    background-color: #16a34a;
  }
  
  .badge.red {
    background-color: #dc2626;
  }
</style>
