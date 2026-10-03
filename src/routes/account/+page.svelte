<script lang="ts">
  // /account became a section of /settings. Auth emails still land here (it's the allowlisted
  // Supabase redirect URL), so forward to /settings keeping the query and token-bearing hash.
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  onMount(() => { goto(`${base}/settings${location.search}${location.hash}`, { replaceState: true }); });
</script>
