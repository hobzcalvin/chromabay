import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://kit.svelte.dev/docs/integrations#preprocessors
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		// adapter-auto only supports some environments, see https://kit.svelte.dev/docs/adapter-auto for a list.
		// If your environment is not supported or you settled on a specific environment, switch out the adapter.
		// See https://kit.svelte.dev/docs/adapters for more about adapters.
		adapter: adapter({
			// Build to 'build' folder for local development
			// GitHub Actions will build to 'docs' folder for deployment
			pages: 'build',
			assets: 'build',
			fallback: 'index.html',
			precompress: false,
			strict: true
		}),
		paths: {
			// Served from the chromabay.app apex root (custom domain) — no base path anywhere.
			// (Was '/chromabay' for the old github.io/<repo> project-pages URL before the domain.)
			base: ''
		},
		// Poll for new deployments every 60 s.  When a new build lands, SvelteKit detects the
		// changed /_app/version.json and reloads before the user navigates to a stale route,
		// preventing "Failed to fetch dynamically imported module" errors from stale chunks.
		version: {
			pollInterval: 60_000
		}
	}
};

export default config;
