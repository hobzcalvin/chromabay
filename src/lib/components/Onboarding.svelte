<script lang="ts">
  import { tick, onDestroy, untrack } from 'svelte';
  import { get, type Readable } from 'svelte/store';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { onboardingStep, closeOnboarding } from '$lib/stores/onboardingStore';
  import { connectedDevices } from '$lib/stores/deviceStore';
  import { currentPatternName, patterns, switchToPattern, ensureTourDemoPattern } from '$lib/stores/patternsStore';
  import { flowNodes, nodeParameters, loadSerializedPattern, forceSyncCurrentPattern } from '$lib/flowStore';
  import { interactiveParameters } from '$lib/stores/interactiveStore';
  import { authUser } from '$lib/stores/authStore';

  // A guided task on a tab: point at the real control, let the user use it, and notice when
  // they have. `watch` calls `done` once the thing has happened and returns its cleanup.
  type Task = {
    prepare?: () => Promise<void>;
    target: () => Element | null;
    text: () => string;
    hint?: string; // shorter text for while something the task opened covers the control
    doneText: () => string;
    watch: (done: () => void) => () => void;
  };
  type Step = { target: string; route: string; title: string; body: (knobs: boolean) => string; task: Task };

  const q = (sel: string) => document.querySelector(sel);
  const isNative = () => typeof window !== 'undefined' && !!(window as any).Capacitor?.isNativePlatform?.();
  // Fires `done` the first time `test` passes for a later value of `store` (the value current
  // when watching starts is only the baseline).
  function after<T>(store: Readable<T>, test: (v: T, first: T) => boolean, done: () => void) {
    const first = get(store);
    return store.subscribe((v) => { if (test(v, first)) done(); });
  }
  const hasKnobs = () =>
    [...get(interactiveParameters).values()].some((m) => [...m.values()].some(Boolean));

  let demoLoaded = $state(false);
  let otherPattern = $state(false);

  const steps: Step[] = [
    {
      target: 'devices',
      route: '/devices',
      title: 'Connect your lights',
      body: () => 'Find ChromaBay controllers over Bluetooth or Wi-Fi, set up your LED strips and update firmware. No controller yet? Install ChromaBay on an ESP32 over USB, or convert a WLED device, further down this page.',
      task: {
        target: () => q('[data-tour-target="connect"]'),
        text: () => isNative()
          ? 'Nearby controllers show up below as they are found. Tap one to connect. No hardware yet? Skip this one.'
          : 'Tap Select ESP32 Device and choose your controller from the list. No hardware yet? Skip this one.',
        doneText: () => 'Connected. Your lights now play the current pattern, and follow whatever you do next.',
        watch: (done) => {
          if (get(connectedDevices).size > 0) { done(); return () => {}; }
          return after(connectedDevices, (m, first) => m.size > first.size, done);
        },
      },
    },
    {
      target: 'patterns',
      route: '/patterns',
      title: 'Pick a pattern',
      body: () => 'Your pattern library, with live previews. Tap one to play it on every connected device, share it as a link, or import from the online gallery. Turn on Cycle to let devices rotate through their saved patterns on their own.',
      task: {
        prepare: async () => { otherPattern = get(patterns).length > 1; },
        target: () =>
          (otherPattern ? q('[data-tour-target="pattern-list"] .pattern-item:not(.current)') : null) ??
          q('[data-tour-target="gallery"] .import-btn') ??
          q('[data-tour-target="pattern-list"]'),
        text: () => otherPattern
          ? 'Tap another pattern to play it.'
          : 'Tap Import on a pattern from the online gallery below to add it to your library and play it.',
        doneText: () => `Now playing “${get(currentPatternName)}”, here and on any connected lights.`,
        watch: (done) => after(currentPatternName, (n, first) => !!n && n !== first, done),
      },
    },
    {
      target: 'interact',
      route: '/interact',
      title: 'Play with it live',
      body: (knobs) => 'Big knobs and colour wheels for the current pattern’s controls, made for tweaking in real time.' +
        (knobs ? '' : ' This pattern has no knobs yet; Try it switches to a demo pattern that does.'),
      task: {
        prepare: async () => {
          if (hasKnobs()) return;
          const demo = await ensureTourDemoPattern();
          await switchToPattern(demo.meta!.name!);
          await loadSerializedPattern(demo);
          forceSyncCurrentPattern();
          demoLoaded = true;
        },
        target: () => q('[data-tour-target="knob"]'),
        text: () => (demoLoaded ? 'This is the Tour Demo pattern, which has knobs. ' : '') + 'Turn this knob and watch the pattern change.',
        doneText: () => 'Connected lights follow every turn. You choose which controls appear here: tap 🖐️ next to any parameter in the editor.',
        watch: (done) => {
          // The page settles its knobs (writing their starting values) as it mounts, so take
          // the baseline once that has happened rather than counting it as a turn.
          const snap = () => JSON.stringify([...get(nodeParameters)].map(([id, m]) => [id, [...m]]));
          let unsub = () => {};
          const t = setTimeout(() => {
            const first = snap();
            unsub = nodeParameters.subscribe(() => { if (snap() !== first) done(); });
          }, 1000);
          return () => { clearTimeout(t); unsub(); };
        },
      },
    },
    {
      target: 'editor',
      route: '/editor',
      title: 'Build your own',
      body: () => 'Patterns are graphs of generators and effects. Add nodes, wire them together, and watch the preview update as you go. The preview runs the same engine as the device.',
      task: {
        target: () => q('[data-tour-target="add-node"]'),
        text: () => 'Tap Add Node and pick a modifier, like Mirror or Blur.',
        hint: 'Scroll down to Modifiers and pick one, like Mirror or Blur.',
        doneText: () => 'Added. Drag from one node’s dot to another’s to wire them together; tap a node to change its settings.',
        watch: (done) => after(flowNodes, (ns, first) => ns.length > first.length, done),
      },
    },
    {
      target: 'settings',
      route: '/settings',
      title: 'Sync (optional)',
      body: () => 'Sign in to sync your library between phone and web and to publish to the gallery. Everything else works without an account. You can replay this tour from Help, further down this page.',
      task: {
        target: () => q('[data-tour-target="signin"]'),
        text: () => 'Enter an email and password to sign in or create an account. It’s optional, so skip it if you like.',
        doneText: () => 'Signed in. Your library now syncs between your devices.',
        watch: (done) => {
          if (get(authUser)) { done(); return () => {}; }
          return after(authUser, (u) => !!u, done);
        },
      },
    },
  ];

  let step = $derived($onboardingStep);
  let knobsPresent = $derived([...$interactiveParameters.values()].some((m) => [...m.values()].some(Boolean)));
  let tourIndex = $derived(typeof step === 'number' ? step : -1);
  let current = $derived(tourIndex >= 0 ? steps[tourIndex] : null);

  // 'intro' explains the tab; 'task' has the user actually use it.
  let mode = $state<'intro' | 'task'>('intro');
  let taskDone = $state(false);
  let preparing = $state(false);
  let stopWatch: () => void = () => {};

  // Geometry: the highlighted tab (intro) or the task's control (task), re-measured on a timer
  // because pages render, load and scroll underneath us.
  let tabRect = $state<DOMRect | null>(null);
  let taskRect = $state<DOMRect | null>(null);
  // The control is under something the task itself opened (the Add Node picker, a menu): get
  // out of its way instead of ringing an element nobody can see.
  let covered = $state(false);
  let vw = $state(0);
  let vh = $state(0);
  let navTop = $state(0);
  let primaryBtn = $state<HTMLButtonElement | null>(null);

  function measure() {
    vw = window.innerWidth;
    vh = window.innerHeight;
    navTop = q('.bottom-nav')?.getBoundingClientRect().top ?? vh;
    tabRect = current ? q(`[data-tour="${current.target}"]`)?.getBoundingClientRect() ?? null : null;
    const el = current && mode === 'task' ? current.task.target() : null;
    taskRect = el?.getBoundingClientRect() ?? null;
    covered = false;
    if (el && taskRect && taskRect.width > 0) {
      const cx = Math.min(vw - 1, Math.max(0, taskRect.left + taskRect.width / 2));
      const cy = Math.min(vh - 1, Math.max(0, taskRect.top + taskRect.height / 2));
      const top = document.elementFromPoint(cx, cy);
      covered = !!top && top !== el && !el.contains(top) && !top.closest('.ob-card');
    }
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    if (step === null) { if (timer) { clearInterval(timer); timer = null; } return; }
    if (!timer) timer = setInterval(measure, 250);
  });
  onDestroy(() => { if (timer) clearInterval(timer); stopWatch(); });

  function endTask() { stopWatch(); stopWatch = () => {}; mode = 'intro'; taskDone = false; }

  $effect(() => {
    // New step: show its tab (navigating there), back in intro mode.
    void step;
    untrack(() => {
      endTask();
      if (step === null) return;
      const s = current;
      if (s && !location.pathname.startsWith(`${base}${s.route}`)) goto(`${base}${s.route}`);
      measure();
      tick().then(() => primaryBtn?.focus());
    });
  });

  async function tryIt() {
    if (!current) return;
    const s = current;
    preparing = true;
    try { await s.task.prepare?.(); } finally { preparing = false; }
    if (current !== s) return;
    mode = 'task';
    taskDone = false;
    stopWatch = s.task.watch(() => { taskDone = true; });
    await tick();
    // Bring the control into view once; the timer keeps the ring on it after that.
    for (let i = 0; i < 20 && !s.task.target(); i++) await new Promise((r) => setTimeout(r, 150));
    s.task.target()?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    measure();
  }

  const CARD_W = 340;
  const GUTTER = 16;
  let cardW = $derived(Math.min(CARD_W, vw - GUTTER * 2));
  // Intro: centred over the tab with an arrow pointing at it.
  let cardLeft = $derived(
    tabRect ? Math.max(GUTTER, Math.min(vw - GUTTER - cardW, tabRect.left + tabRect.width / 2 - cardW / 2)) : GUTTER
  );
  let arrowLeft = $derived(tabRect ? tabRect.left + tabRect.width / 2 - cardLeft : cardW / 2);
  let cardBottom = $derived(tabRect ? vh - tabRect.top + 14 : 96);
  // Task: centred, on whichever side of the control has more room, never over the tabs.
  let taskAtTop = $derived(!!taskRect && taskRect.top + taskRect.height / 2 > (navTop || vh) / 2);
  let taskLeft = $derived((vw - cardW) / 2);
  let taskBottom = $derived(vh - (navTop || vh) + 12);

  const pad = (r: DOMRect, p: number) => ({
    left: Math.max(2, r.left - p),
    top: Math.max(2, r.top - p),
    right: Math.min(vw - 2, r.right + p),
    bottom: Math.min(vh - 2, r.bottom + p),
  });
  let spot = $derived(mode === 'intro' && tabRect ? pad(tabRect, 4) : null);
  let ring = $derived(mode === 'task' && !covered && taskRect && taskRect.height > 0 ? pad(taskRect, 6) : null);

  function startTour() { onboardingStep.set(0); }
  function next() {
    if (tourIndex >= steps.length - 1) closeOnboarding();
    else onboardingStep.set(tourIndex + 1);
  }
  function back() {
    if (mode === 'task') { endTask(); measure(); return; }
    if (tourIndex > 0) onboardingStep.set(tourIndex - 1);
    else onboardingStep.set('welcome');
  }

  function onKey(e: KeyboardEvent) {
    if (step === null) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
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
{:else if current && mode === 'intro'}
  <!-- Blocks taps on the page while explaining; Try it hands the page back. -->
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
    <p id="ob-step-body">{current.body(knobsPresent)}</p>
    <div class="ob-actions">
      <button class="ob-btn link" onclick={closeOnboarding}>Skip tour</button>
      <span class="ob-spacer"></span>
      <button class="ob-btn ghost" onclick={back}>Back</button>
      <button class="ob-btn ghost" onclick={tryIt} disabled={preparing}>{preparing ? '…' : 'Try it'}</button>
      <button class="ob-btn primary" bind:this={primaryBtn} onclick={next}>
        {tourIndex === steps.length - 1 ? 'Done' : 'Next'}
      </button>
    </div>
  </div>
{:else if current}
  <!-- Task: the page is live; a ring marks the control and the card says what to do. -->
  {#if ring}
    <div
      class="ob-ring"
      class:done={taskDone}
      aria-hidden="true"
      style="left:{ring.left}px; top:{ring.top}px; width:{ring.right - ring.left}px; height:{ring.bottom - ring.top}px"
    ></div>
  {/if}
  <div
    class="ob-card task"
    class:done={taskDone}
    class:compact={covered && !taskDone}
    role="dialog"
    aria-labelledby="ob-step-title"
    aria-live="polite"
    style="left:{taskLeft}px; width:{cardW}px; {taskAtTop || covered ? 'top:max(12px, env(safe-area-inset-top, 0px))' : `bottom:${taskBottom}px`}"
  >
    <button class="ob-close" aria-label="Close tour" onclick={closeOnboarding}>×</button>
    <p class="ob-count">{tourIndex + 1} of {steps.length} · Try it</p>
    <h2 id="ob-step-title">{taskDone ? 'Nice!' : current.title}</h2>
    <p>{taskDone ? current.task.doneText() : covered ? (current.task.hint ?? current.task.text()) : current.task.text()}</p>
    <div class="ob-actions">
      <button class="ob-btn link" onclick={back}>Back</button>
      <span class="ob-spacer"></span>
      {#if taskDone}
        <button class="ob-btn primary" onclick={next}>{tourIndex === steps.length - 1 ? 'Done' : 'Next'}</button>
      {:else}
        <button class="ob-btn ghost" onclick={next}>{tourIndex === steps.length - 1 ? 'Finish' : 'Skip'}</button>
      {/if}
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
  /* Arrow pointing down at the highlighted tab (intro only). */
  .ob-card:not(.task)::after {
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
  .ob-card.task { font-size: 0.9rem; }
  .ob-card.task h2 { font-size: 1.05rem; }
  .ob-card.task.done { border-color: rgba(134, 239, 172, 0.6); }
  /* Something the task opened is on top: shrink to a hint that lets taps through. */
  .ob-card.task.compact { padding: 0.55rem 0.9rem; pointer-events: none; opacity: 0.92; }
  .ob-card.task.compact :is(.ob-count, h2, .ob-actions, .ob-close) { display: none; }
  .ob-card.task.compact p { margin: 0; }

  .ob-spotlight {
    position: fixed;
    z-index: 5001;
    border-radius: 14px;
    border: 2px solid #a5b4fc;
    /* The spread shadow dims the page around the tab, lightly enough to see the page. */
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45), 0 0 18px rgba(165, 180, 252, 0.6);
    pointer-events: none;
    transition: left 0.25s ease, top 0.25s ease, width 0.25s ease, height 0.25s ease;
  }
  /* Task ring: no dimming (menus the task opens must stay readable), just a pulse. */
  .ob-ring {
    position: fixed;
    z-index: 5001;
    border-radius: 14px;
    border: 3px solid #a5b4fc;
    pointer-events: none;
    animation: ob-pulse 1.4s ease-in-out infinite;
    transition: left 0.2s ease, top 0.2s ease, width 0.2s ease, height 0.2s ease;
  }
  .ob-ring.done { border-color: #86efac; animation: none; }

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
    padding: 0.6rem 0.85rem;
    border-radius: 8px;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    color: #fff;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .ob-btn:disabled { opacity: 0.6; cursor: default; }
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
  @keyframes ob-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(165, 180, 252, 0.6); }
    50% { box-shadow: 0 0 0 8px rgba(165, 180, 252, 0); }
  }

  @media (prefers-reduced-motion: reduce) {
    .ob-strip span, .ob-backdrop, .ob-welcome, .ob-card, .ob-ring { animation: none; }
    .ob-spotlight, .ob-ring { transition: none; }
  }
</style>
