<script lang="ts">
  import { page } from '$app/stores';
  import { base } from '$app/paths';
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { connectedDevices } from '$lib/stores/deviceStore';
  import { loadPatterns, currentPattern } from '$lib/stores/patternsStore';
  import { loadSerializedPattern, initializeDefaultPattern } from '$lib/flowStore';
  import { SvelteFlowProvider } from '@xyflow/svelte';
  import '$lib/patternSync'; // activates cloud library sync (inert unless signed in)

  $: connected = $connectedDevices.size;

  // Load the current pattern into the flow store app-wide on startup. Connecting to a
  // device syncs whatever's in the flow store (serializeCurrentPattern), and the
  // Devices page never populated it — so connecting there used to push an empty
  // pattern until you visited Editor/Patterns. Loading here makes the current pattern
  // available no matter which page you land on.
  async function loadCurrentPatternIntoFlow() {
    try {
      await loadPatterns();
      const current = get(currentPattern);
      if (current) await loadSerializedPattern(current);
      else initializeDefaultPattern();
    } catch (e) {
      console.error('Layout: failed to load current pattern into flow store', e);
    }
  }

  onMount(() => {
    loadCurrentPatternIntoFlow();

    // iOS Safari viewport height fix
    function setVHProperty() {
      let vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty('--vh', `${vh}px`);
    }
    
    // Set initial value
    setVHProperty();
    
    // Update on resize and orientation change
    window.addEventListener('resize', setVHProperty);
    window.addEventListener('orientationchange', () => {
      // Delay to account for browser UI changes
      setTimeout(setVHProperty, 100);
    });
    
    return () => {
      window.removeEventListener('resize', setVHProperty);
      window.removeEventListener('orientationchange', setVHProperty);
    };
  });
</script>

<SvelteFlowProvider>
  <div class="app-container">
    <div class="content-area">
      <slot />
    </div>
    
    <nav class="bottom-nav" class:hidden={$page.url.pathname.startsWith(`${base}/interact`)}>
      <a href="{base}/devices" class:active={$page.url.pathname.startsWith(`${base}/devices`)}>
        <span class="emoji-wrap">
          <span class="emoji">💡</span>
          <span
            class="badge"
            class:green={connected>0}
            class:red={connected===0}
            data-single-digit={connected >= 0 && connected <= 9 ? 'true' : 'false'}
          >{connected}</span>
        </span>
        <span class="label">Devices</span>
      </a>
      <a href="{base}/patterns" class:active={$page.url.pathname.startsWith(`${base}/patterns`)}>
        <span class="emoji">🌈</span>
        <span class="label">Patterns</span>
      </a>
      <a href="{base}/editor" class:active={$page.url.pathname.startsWith(`${base}/editor`)}>
        <span class="emoji">✏️</span>
        <span class="label">Editor</span>
      </a>
      <a href="{base}/account" class:active={$page.url.pathname.startsWith(`${base}/account`)}>
        <span class="emoji">👤</span>
        <span class="label">Account</span>
      </a>
    </nav>
  </div>
</SvelteFlowProvider>

<style>
  /* Reset and base styles. The page itself never scrolls — html/body are locked to
     the viewport and only .content-area scrolls. This pins the bottom nav, kills the
     whole-app pan/rubber-band on iOS, and removes horizontal scrolling entirely. */
  :global(html), :global(body) {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;            /* no page scroll on either axis */
    overscroll-behavior: none;   /* no rubber-band / scroll chaining */
  }

  :global(body) {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: black;
    /* Disable Safari double-tap zoom and touch behaviors */
    touch-action: manipulation;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }

  /* iOS Safari specific body adjustments */
  @supports (-webkit-touch-callout: none) {
    :global(body) {
      /* Fix for iOS Safari - use fill-available when supported */
      min-height: -webkit-fill-available;
    }
  }

  /* App container using CSS Grid - this is the bulletproof layout */
  .app-container {
    display: grid;
    grid-template-rows: 1fr auto;
    grid-template-areas:
      "content"
      "navigation";
    height: 100%;
    width: 100%;
    /* Handle safe areas properly */
    padding-top: env(safe-area-inset-top, 0px);
    padding-left: env(safe-area-inset-left, 0px);
    padding-right: env(safe-area-inset-right, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
    box-sizing: border-box;
    /* Ensure proper stacking on iOS */
    position: relative;
    z-index: 0;
  }

  /* iOS Safari specific fixes for app container */
  @supports (-webkit-touch-callout: none) {
    .app-container {
      height: calc(var(--vh, 1vh) * 100);
    }
  }

  /* Content area - this will naturally size to fill available space */
  .content-area {
    grid-area: content;
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch; /* momentum scroll within the content only */
    overscroll-behavior: contain;      /* don't chain scroll to the locked body */
    min-height: 0;                     /* let the grid row shrink so this scrolls, not the page */
    /* Max width and centering for large screens */
    max-width: 1000px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
    /* Text styles */
    color: white;
    /* Purple gradient background for the main content area */
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  }

  /* Bottom navigation - fixed height, takes only what it needs */
  .bottom-nav {
    grid-area: navigation;
    display: flex;
    justify-content: space-around;
    align-items: stretch;
    background: rgba(0, 0, 0, 0.95);
    backdrop-filter: blur(20px);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    padding: 0.75rem 0.5rem;
    box-sizing: border-box;
    min-height: 60px;
    /* Ensure it stays at bottom on all devices */
    position: relative;
  }
  
  /* Navigation links */
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
  
  /* Emoji and label styles */
  .bottom-nav .emoji {
    font-size: 1.2rem;
    margin-bottom: 0.2rem;
    display: block;
  }
  
  .bottom-nav .label {
    font-size: 0.85rem;
    display: block;
  }
  
  /* Mobile responsive navigation */
  @media (max-width: 480px) {
    .bottom-nav a {
      padding: 0.5rem 0.25rem;
    }
    
    .bottom-nav .emoji {
      font-size: 1rem;
      margin-bottom: 0.15rem;
    }
    
    .bottom-nav .label {
      font-size: 0.75rem;
    }
  }
  
  @media (max-width: 320px) {
    .bottom-nav a {
      padding: 0.5rem 0.1rem;
    }
    
    .bottom-nav .emoji {
      font-size: 0.9rem;
      margin-bottom: 0.1rem;
    }
    
    .bottom-nav .label {
      font-size: 0.7rem;
    }
  }
  
  /* Emoji+badge wrapper: gives the badge a positioning context tied to the lightbulb,
     so the count sits just off the emoji's top-right instead of the tab's corner. */
  .emoji-wrap {
    position: relative;
    display: inline-block;
    line-height: 1;
  }

  /* Badge styles */
  .badge {
    position: absolute;
    top: -7px;
    /* Anchor the badge's LEFT edge at the bulb's right edge so it sits up-and-right
       with only a small corner overlap — not centered over the glyph. */
    left: calc(100% - 4px);
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

  .hidden {
    display: none !important;
  }

  /* Remove all global main styling since we now have proper layout */
  :global(main) {
    /* Reset any previous global styles */
    margin: 0 !important;
    padding: 0 1rem 1rem 1rem !important; /* top: 0, right: 1rem, bottom: 1rem, left: 1rem */
    max-width: none !important;
    min-height: auto !important;
    color: inherit !important;
    box-sizing: border-box !important;
  }
</style>
