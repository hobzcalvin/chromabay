import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://kit.svelte.dev/docs/integrations#preprocessors
	// for more information about preprocessors
	preprocess: vitePreprocess(),
	
	// Disable accessibility warnings - we handle UX appropriately for our use case
	onwarn: (warning, handler) => {
		// Skip accessibility warnings
		if (warning.code.startsWith('a11y_')) return;
		// Skip unused export warnings for component props
		if (warning.code === 'export_let_unused') return;
		// Handle other warnings normally
		handler(warning);
	},

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
			// Only use /blumon base path for GitHub Pages, not for iOS app or local dev
			base: process.env.GITHUB_PAGES ? '/blumon' : ''
		}
	}
};

export default config;
