<script lang="ts">
  import { tick } from 'svelte';
  import { onboardingStep, closeOnboarding } from '$lib/stores/onboardingStore';

  // One step per bottom-nav tab; `target` matches the tab's data-tour attribute in +layout.svelte.
  const steps = [
    {
      target: 'devices',
      title: 'Connect your lights',
      body: 'Find ChromaBay controllers over Bluetooth or Wi-Fi, set up your LED strips, and update firmware. Starting from scratch? Install ChromaBay on an ESP32 over USB, or convert a WLED device, from the bottom of this page.',
    },
    {
      target: 'patterns',
      title: 'Pick a pattern',
      body: 'Your pattern library, with live previews. Tap one to play it on every connected device, share it as a link, or import from the online gallery. Turn on Cycle to let devices rotate through their saved patterns on their own.',
    },
    {
      target: 'interact',
      title: 'Play with it live',
      body: 'Big knobs and colour wheels for the current pattern’s controls, made for tweaking in real time.',
    },
    {
      target: 'editor',
      title: 'Build your own',
      body: 'Patterns are graphs of generators and effects. Add nodes, wire them together, and watch the preview update as you go. The preview runs the same engine as the device.',
    },
    {
      target: 'account',
      title: 'Sync (optional)',
      body: 'Sign in to sync your library between phone and web and to publish to the gallery. Everything else works without an account. You can replay this tour from here.',
    },
  ];

  let step = $derived($onboardingStep);
  let tourIndex = $derived(typeof step === 'number' ? step : -1);
  let current = $derived(tourIndex >= 0 ? steps[tourIndex] : null);

  // Geometry of the highlighted tab, re-measured on each step and on resize/rotation.
  let rect = $state<DOMRect | null>(null);
  let vw = $state(0);
  let vh = $state(0);
  let primaryBtn = $state<HTMLButtonElement | null>(null);

  function measure() {
    vw = window.innerWidth;
    vh = window.innerHeight;
    rect = current ? document.querySelector(`[data-tour="${current.target}"]`)?.getBoundingClientRect() ?? null : null;
  }

  $effect(() => {
    // Re-run whenever the step changes: measure the new target, then move focus to the
    // primary action so keyboard and screen-reader users land inside the dialog.
    void step;
    if (step === null) return;
    measure();
    tick().then(() => primaryBtn?.focus());
  });

  const CARD_W = 340;
  const GUTTER = 16;
  let cardW = $derived(Math.min(CARD_W, vw - GUTTER * 2));
  let cardLeft = $derived(
    rect ? Math.max(GUTTER, Math.min(vw - GUTTER - cardW, rect.left + rect.width / 2 - cardW / 2)) : GUTTER
  );
  let arrowLeft = $derived(rect ? rect.left + rect.width / 2 - cardLeft : cardW / 2);
  let cardBottom = $derived(rect ? vh - rect.top + 14 : 96);
  // Ring around the tab, padded 4px but kept on-screen so the edge tabs aren't clipped.
  let spot = $derived(
    rect && {
      left: Math.max(2, rect.left - 4),
      top: rect.top - 4,
      right: Math.min(vw - 2, rect.right + 4),
      bottom: Math.min(vh - 2, rect.bottom + 4),
    }
  );

  function startTour() { onboardingStep.set(0); }
  function next() {
    if (tourIndex >= steps.length - 1) closeOnboarding();
    else onboardingStep.set(tourIndex + 1);
  }
  function back() {
    if (tourIndex > 0) onboardingStep.set(tourIndex - 1);
    else onboardingStep.set('welcome');
  }

  function onKey(e: KeyboardEvent) {
    if (step === null) return;
    if (e.key === 'Escape') { e.preventDefault(); closeOnboarding(); }
    else if (tourIndex >= 0 && e.key === 'ArrowRight') next();
    else if (tourIndex >= 0 && e.key === 'ArrowLeft') back();
  }
</script>

<svelte:window onkeydown={onKey} onresize={() => step !== null && measure()} />

{#if step === 'welcome'}
  <!-- Clicking the dimmed backdrop dismisses the welcome, same as Skip. -->
  <div class="ob-backdrop" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) closeOnboarding(); }}>
    <div class="ob-welcome" role="dialog" aria-modal="true" aria-labelledby="ob-welcome-title">
      <button class="ob-close" aria-label="Close" onclick={closeOnboarding}>×</button>
      <div class="ob-strip" aria-hidden="true">
        {#each Array(12) as _, i}<span style="--i:{i}"></span>{/each}
      </div>
      <h2 id="ob-welcome-title">Welcome to ChromaBay</h2>
      <p>Design LED patterns on your phone or in the browser, then play them on ESP32-powered lights over Bluetooth or Wi-Fi.</p>
      <p class="ob-muted">No hardware yet? You can still browse, preview and build patterns. Everything here runs without a device or an account.</p>
      <div class="ob-actions">
        <button class="ob-btn ghost" onclick={closeOnboarding}>Skip</button>
        <button class="ob-btn primary" bind:this={primaryBtn} onclick={startTour}>Show me around</button>
      </div>
    </div>
  </div>
{:else if current}
  <!-- Blocks clicks on the page underneath while touring; the card itself always has Skip. -->
  <div class="ob-blocker" role="presentation"></div>
  {#if spot}
    <div
      class="ob-spotlight"
      aria-hidden="true"
      style="left:{spot.left}px; top:{spot.top}px; width:{spot.right - spot.left}px; height:{spot.bottom - spot.top}px"
    ></div>
  {/if}
  <div
    class="ob-card"
    role="dialog"
    aria-modal="true"
    aria-labelledby="ob-step-title"
    aria-describedby="ob-step-body"
    style="left:{cardLeft}px; bottom:{cardBottom}px; width:{cardW}px; --arrow-left:{arrowLeft}px"
  >
    <button class="ob-close" aria-label="Close tour" onclick={closeOnboarding}>×</button>
    <p class="ob-count">{tourIndex + 1} of {steps.length}</p>
    <h2 id="ob-step-title">{current.title}</h2>
    <p id="ob-step-body">{current.body}</p>
    <div class="ob-actions">
      <button class="ob-btn link" onclick={closeOnboarding}>Skip tour</button>
      <span class="ob-spacer"></span>
      <button class="ob-btn ghost" onclick={back}>Back</button>
      <button class="ob-btn primary" bind:this={primaryBtn} onclick={next}>
        {tourIndex === steps.length - 1 ? 'Done' : 'Next'}
      </button>
    </div>
  </div>
{/if}

<style>
  .ob-backdrop {
    position: fixed;
    inset: 0;
    z-index: 5000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    animation: ob-fade 0.2s ease-out;
  }
  .ob-blocker { position: fixed; inset: 0; z-index: 5000; }

  .ob-welcome,
  .ob-card {
    position: relative;
    box-sizing: border-box;
    color: #fff;
    background: linear-gradient(160deg, #2a2350 0%, #1a1633 100%);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 16px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
    font-size: 0.95rem;
    line-height: 1.45;
  }
  .ob-welcome {
    width: 100%;
    max-width: 400px;
    padding: 1.5rem 1.4rem 1.2rem;
    animation: ob-rise 0.25s ease-out;
  }
  .ob-card {
    position: fixed;
    z-index: 5002;
    padding: 1rem 1.1rem 0.9rem;
    animation: ob-fade 0.15s ease-out;
  }
  /* Arrow pointing down at the highlighted tab. */
  .ob-card::after {
    content: '';
    position: absolute;
    bottom: -7px;
    left: calc(var(--arrow-left) - 7px);
    width: 14px;
    height: 14px;
    background: #1a1633;
    border-right: 1px solid rgba(255, 255, 255, 0.14);
    border-bottom: 1px solid rgba(255, 255, 255, 0.14);
    transform: rotate(45deg);
  }

  .ob-spotlight {
    position: fixed;
    z-index: 5001;
    border-radius: 14px;
    border: 2px solid #a5b4fc;
    /* The huge spread shadow dims everything except the highlighted tab. */
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.6), 0 0 18px rgba(165, 180, 252, 0.6);
    pointer-events: none;
    transition: left 0.25s ease, top 0.25s ease, width 0.25s ease, height 0.25s ease;
  }

  h2 { margin: 0 0 0.5rem; font-size: 1.2rem; }
  .ob-welcome h2 { font-size: 1.4rem; }
  p { margin: 0 0 0.75rem; }
  .ob-muted { color: rgba(255, 255, 255, 0.72); font-size: 0.88rem; }
  .ob-count {
    margin: 0 0 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #a5b4fc;
  }

  .ob-close {
    position: absolute;
    top: 6px;
    right: 8px;
    width: 36px;
    height: 36px;
    border: none;
    background: none;
    color: rgba(255, 255, 255, 0.6);
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
    border-radius: 8px;
  }
  .ob-close:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }

  .ob-actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 1rem; }
  .ob-welcome .ob-actions { justify-content: flex-end; }
  .ob-spacer { flex: 1; }
  .ob-btn {
    padding: 0.6rem 1rem;
    border-radius: 8px;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    color: #fff;
    border: 1px solid transparent;
  }
  .ob-btn.primary { background: linear-gradient(135deg, #667eea, #764ba2); }
  .ob-btn.ghost { background: rgba(255, 255, 255, 0.08); border-color: rgba(255, 255, 255, 0.2); }
  .ob-btn.link {
    padding: 0.6rem 0;
    background: none;
    color: rgba(255, 255, 255, 0.65);
    font-weight: 500;
    text-decoration: underline;
  }
  .ob-btn:focus-visible, .ob-close:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 2px; }

  /* A little strip of "LEDs" chasing a rainbow across the top of the welcome card. */
  .ob-strip { display: flex; gap: 6px; margin: 0 0 1rem; }
  .ob-strip span {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: hsl(calc(var(--i) * 30), 90%, 60%);
    box-shadow: 0 0 10px hsl(calc(var(--i) * 30), 90%, 60%);
    animation: ob-chase 2.4s linear infinite;
    animation-delay: calc(var(--i) * -0.2s);
  }

  @keyframes ob-chase { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  @keyframes ob-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ob-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }

  @media (prefers-reduced-motion: reduce) {
    .ob-strip span, .ob-backdrop, .ob-welcome, .ob-card { animation: none; }
    .ob-spotlight { transition: none; }
  }
</style>
