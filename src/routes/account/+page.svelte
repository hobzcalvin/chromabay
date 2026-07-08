<script lang="ts">
  import {
    authUser, authReady, isConfigured, recoveryMode,
    signIn, signUp, signOut, sendPasswordReset, updatePassword, resendConfirmation,
  } from '$lib/stores/authStore';

  type Mode = 'in' | 'up' | 'reset';
  let mode: Mode = 'in';
  let email = '';
  let password = '';
  let newPassword = '';
  let busy = false;
  let error = '';
  let notice = '';
  let showResend = false; // offer "resend confirmation" after a genuinely-new signup

  function setMode(m: Mode) { mode = m; error = ''; notice = ''; showResend = false; }

  async function submit() {
    error = ''; notice = ''; showResend = false; busy = true;
    try {
      if (mode === 'up') {
        const { needsConfirm, alreadyRegistered } = await signUp(email, password);
        if (alreadyRegistered) {
          notice = 'That email is already registered. Try signing in, or reset your password below.';
          mode = 'in';
        } else if (needsConfirm) {
          notice = 'Account created. Check your email for a confirmation link (from ChromaBay / grant@revoltlabs.co — check spam), then sign in.';
          showResend = true;
          mode = 'in';
        } else {
          notice = 'Account created and signed in.';
        }
      } else if (mode === 'reset') {
        await sendPasswordReset(email);
        notice = 'If that email has an account, a password-reset link is on its way (check spam).';
      } else {
        await signIn(email, password);
      }
      password = '';
    } catch (e: any) {
      error = e?.message ?? String(e);
    } finally {
      busy = false;
    }
  }

  async function submitNewPassword() {
    error = ''; notice = ''; busy = true;
    try {
      await updatePassword(newPassword);
      newPassword = '';
      notice = 'Password updated.';
    } catch (e: any) {
      error = e?.message ?? String(e);
    } finally {
      busy = false;
    }
  }

  async function doResend() {
    error = ''; busy = true;
    try { await resendConfirmation(email); notice = 'Confirmation email resent.'; }
    catch (e: any) { error = e?.message ?? String(e); }
    finally { busy = false; }
  }

  const title = (m: Mode) => (m === 'up' ? 'Create account' : m === 'reset' ? 'Send reset link' : 'Sign in');
</script>

<main>
  <h1>Account</h1>

  {#if !isConfigured}
    <p class="muted">Cloud sync isn't configured in this build.</p>
  {:else if !$authReady}
    <p class="muted">Loading…</p>
  {:else if $authUser && $recoveryMode}
    <div class="card">
      <h2 class="sub">Set a new password</h2>
      <form on:submit|preventDefault={submitNewPassword}>
        <label>New password
          <input type="password" autocomplete="new-password" minlength="6" bind:value={newPassword} required />
        </label>
        <button class="btn primary" type="submit" disabled={busy}>{busy ? '…' : 'Update password'}</button>
      </form>
      {#if error}<p class="error">{error}</p>{/if}
      {#if notice}<p class="notice">{notice}</p>{/if}
    </div>
  {:else if $authUser}
    <div class="card">
      <p class="signed-in">Signed in as <strong>{$authUser.email ?? $authUser.id}</strong></p>
      <p class="muted">Your account carries your pattern library and device owner-keys across devices, and lets you publish to the gallery.</p>
      <button class="btn" on:click={signOut}>Sign out</button>
    </div>
  {:else}
    <p class="muted">Optional — everything works without an account. Signing in syncs your patterns and devices across your phone and the web, and unlocks the gallery.</p>
    <div class="card">
      {#if mode !== 'reset'}
        <div class="tabs">
          <button class:sel={mode === 'in'} on:click={() => setMode('in')}>Sign in</button>
          <button class:sel={mode === 'up'} on:click={() => setMode('up')}>Create account</button>
        </div>
      {:else}
        <h2 class="sub">Reset your password</h2>
      {/if}

      <form on:submit|preventDefault={submit}>
        <label>Email
          <input type="email" autocomplete="email" bind:value={email} required />
        </label>
        {#if mode !== 'reset'}
          <label>Password
            <input type="password" autocomplete={mode === 'up' ? 'new-password' : 'current-password'} minlength="6" bind:value={password} required />
          </label>
        {/if}
        <button class="btn primary" type="submit" disabled={busy}>{busy ? '…' : title(mode)}</button>
      </form>

      <div class="links">
        {#if mode === 'in'}
          <button class="link" on:click={() => setMode('reset')}>Forgot password?</button>
        {:else if mode === 'reset'}
          <button class="link" on:click={() => setMode('in')}>← Back to sign in</button>
        {/if}
        {#if showResend}
          <button class="link" on:click={doResend} disabled={busy}>Resend confirmation email</button>
        {/if}
      </div>

      {#if error}<p class="error">{error}</p>{/if}
      {#if notice}<p class="notice">{notice}</p>{/if}
    </div>
  {/if}
</main>

<style>
  h1 { margin: 0 0 0.5rem; font-size: 1.6rem; }
  .sub { margin: 0 0 1rem; font-size: 1.1rem; }
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
  .links { display: flex; justify-content: space-between; gap: 0.5rem; margin-top: 0.75rem; flex-wrap: wrap; }
  .link { background: none; border: none; color: #93c5fd; cursor: pointer; font-size: 0.82rem; padding: 0; text-decoration: underline; }
  .link:disabled { opacity: 0.6; cursor: default; }
  .signed-in { font-size: 1rem; margin: 0 0 0.5rem; }
  .error { color: #fca5a5; font-size: 0.85rem; margin: 0.75rem 0 0; }
  .notice { color: #86efac; font-size: 0.85rem; margin: 0.75rem 0 0; }
</style>
