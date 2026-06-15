import { describe, it, expect } from 'vitest';
import { NODE_TYPES } from '../../flowStore';

describe('harness probe', () => {
	it('loads operators from the real WASM module', () => {
		const names = NODE_TYPES.map((n) => n.type);
		console.log('Loaded operator types:', names);
		expect(NODE_TYPES.length).toBeGreaterThan(1);
		expect(names).toContain('rainbow');
	});
});
