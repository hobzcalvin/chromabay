<script lang="ts">
  // Full-screen Add-Node picker. Operators are split into "Generators" (produce a pattern
  // from nothing) and "Modifiers" (transform an input) and shown with LIVE WASM previews:
  // generators render their canonical default look; modifiers run on a canonical duck image
  // (Blend also gets the RGB venn as its second input). Pick one to add it; Esc / backdrop
  // / × to dismiss.
  import OperatorPreview from './OperatorPreview.svelte';
  import { isGeneratorType } from '$lib/operatorArity';

  let {
    open = false,
    nodeTypes = [],
    onSelect,
    onClose
  }: {
    open?: boolean;
    nodeTypes?: any[];
    onSelect: (nodeType: any) => void;
    onClose: () => void;
  } = $props();

  // A generator (arity 0 — no image input) is a pattern SOURCE, previewed on black; a modifier
  // (arity >= 1) runs on a canonical duck image. Same distinction as input arity, so we share
  // the single generator list in operatorArity.ts (keep new operators in sync there).
  const isGeneratorOp = (type: string) => isGeneratorType(type);

  const ops = $derived(nodeTypes.filter((n) => n && n.type && n.type !== 'output'));
  const generators = $derived(open ? ops.filter((n) => isGeneratorOp(n.type)) : []);
  const modifiers = $derived(open ? ops.filter((n) => !isGeneratorOp(n.type)) : []);

  function pick(nodeType: any) {
    onSelect(nodeType);
    onClose();
  }
</script>

<svelte:window onkeydown={(e) => { if (open && e.key === 'Escape') onClose(); }} />

{#if open}
  <div
    class="addnode-overlay"
    role="button"
    tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    onkeydown={() => {}}
  >
    <div class="addnode-panel">
      <header class="addnode-header">
        <h2>Add Node</h2>
        <button class="addnode-close" aria-label="Close" onclick={onClose}>×</button>
      </header>

      <div class="addnode-scroll">
        {#each [{ title: 'Generators', list: generators, gen: true }, { title: 'Modifiers', list: modifiers, gen: false }] as section}
          <section>
            <h3>{section.title}</h3>
            <div class="addnode-grid">
              {#each section.list as nodeType (nodeType.type)}
                <button class="op-card" onclick={() => pick(nodeType)} title={nodeType.name}>
                  {#if open}
                    <OperatorPreview op={nodeType.type} isGenerator={section.gen} />
                  {/if}
                  <span class="op-name">{nodeType.name}</span>
                </button>
              {/each}
            </div>
          </section>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .addnode-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(3px);
    z-index: 3000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 3.5vh 3vw; /* leave the dimmed editor visible around the panel */
  }
  /* A floating card, not a full-bleed takeover — so it reads as "on top of" the editor. */
  .addnode-panel {
    width: 100%;
    max-width: 1000px;
    max-height: 92vh;
    background: #14161c;
    display: flex;
    flex-direction: column;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.7);
    overflow: hidden;
  }
  .addnode-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    flex: 0 0 auto;
  }
  .addnode-header h2 {
    margin: 0;
    font-size: 1.25rem;
  }
  .addnode-close {
    background: none;
    border: none;
    color: #aaa;
    font-size: 1.8rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.5rem;
  }
  .addnode-close:hover { color: #fff; }

  .addnode-scroll {
    overflow-y: auto;
    padding: 1rem 1.25rem 2rem;
    flex: 1 1 auto;
  }
  section { margin-bottom: 1.75rem; }
  section h3 {
    margin: 0 0 0.75rem;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8a90a0;
  }
  .addnode-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 0.85rem;
  }
  .op-card {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    cursor: pointer;
    color: #fff;
    transition: border-color 0.12s, background 0.12s, transform 0.06s;
  }
  .op-card:hover {
    border-color: var(--accent-color, #667eea);
    background: rgba(102, 126, 234, 0.12);
  }
  .op-card:active { transform: scale(0.98); }
  .op-name {
    font-size: 0.85rem;
    font-weight: 600;
    text-align: center;
  }
</style>
