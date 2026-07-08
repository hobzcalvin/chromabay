<script lang="ts">
  import { authUser, authReady, isConfigured, signIn, signUp, signOut } from '$lib/stores/authStore';

  let mode: 'in' | 'up' = 'in';
  let email = '';
  let password = '';
  let busy = false;
  let error = '';
  let notice = '';

  async function submit() {
    error = ''; notice = ''; busy = true;
    try {
      if (mode === 'up') {
        const { needsConfirm } = await signUp(email.trim(), password);
        notice = needsConfirm
          ? 'Account created — check your email for a confirmation link, then sign in.'
          : 'Account created and signed in.';
        if (needsConfirm) mode = 'in';
      } else {
        await signIn(email.trim(), password);
      }
      password = '';
    } catch (e: any) {
      error = e?.message ?? String(e);
    } finally {
      busy = false;
    }
  }
</script>

<main>
  <h1>Account</h1>

  {#if !isConfigured}
    <p class="muted">Cloud sync isn't configured in this build.</p>
  {:else if !$authReady}
    <p class="muted">Loading…</p>
  {:else if $authUser}
    <div class="card">
      <p class="signed-in">Signed in as <strong>{$authUser.email ?? $authUser.id}</strong></p>
      <p class="muted">Your account carries your pattern library and device owner-keys across devices, and lets you publish to the gallery.</p>
      <button class="btn" on:click={signOut}>Sign out</button>
    </div>
  {:else}
    <p class="muted">Optional — everything works without an account. Signing in syncs your patterns and devices across your phone and the web, and unlocks the gallery.</p>
    <div class="card">
      <div class="tabs">
        <button class:sel={mode === 'in'} on:click={() => { mode = 'in'; error=''; notice=''; }}>Sign in</button>
        <button class:sel={mode === 'up'} on:click={() => { mode = 'up'; error=''; notice=''; }}>Create account</button>
      </div>
      <form on:submit|preventDefault={submit}>
        <label>Email
          <input type="email" autocomplete="email" bind:value={email} required />
        </label>
        <label>Password
          <input type="password" autocomplete={mode === 'up' ? 'new-password' : 'current-password'} minlength="6" bind:value={password} required />
        </label>
        <button class="btn primary" type="submit" disabled={busy}>
          {busy ? '…' : mode === 'up' ? 'Create account' : 'Sign in'}
        </button>
      </form>
      {#if error}<p class="error">{error}</p>{/if}
      {#if notice}<p class="notice">{notice}</p>{/if}
    </div>
  {/if}
</main>

<style>
  h1 { margin: 0 0 0.5rem; font-size: 1.6rem; }
  .muted { color: rgba(255,255,255,0.8); font-size: 0.9rem; line-height: 1.4; margin: 0 0 1rem; }
  .card { background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 1rem; max-width: 420px; }
  .tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .tabs button { flex: 1; padding: 0.5rem; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; color: rgba(255,255,255,0.7); cursor: pointer; font-weight: 600; }
  .tabs button.sel { background: rgba(102,126,234,0.35); border-color: rgba(102,126,234,0.6); color: #fff; }
  form { display: flex; flex-direction: column; gap: 0.75rem; }
  label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.85rem; color: rgba(255,255,255,0.85); }
  input { padding: 0.6rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.3); color: #fff; font-size: 1rem; }
  .btn { padding: 0.6rem 1rem; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.08); color: #fff; cursor: pointer; font-weight: 600; }
  .btn.primary { background: rgba(102,126,234,0.5); border-color: rgba(102,126,234,0.7); }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .signed-in { font-size: 1rem; margin: 0 0 0.5rem; }
  .error { color: #fca5a5; font-size: 0.85rem; margin: 0.75rem 0 0; }
  .notice { color: #86efac; font-size: 0.85rem; margin: 0.75rem 0 0; }
</style>
