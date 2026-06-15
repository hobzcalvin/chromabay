/**
 * Test-only stub for `@xyflow/svelte`.
 *
 * The pattern engine code (`flowStore`, `patternSerializer`) imports only TYPES
 * from this package — those are erased at runtime. The single runtime value used
 * anywhere in the tested paths is the `MarkerType` enum (in test helpers). The
 * real package is a full Svelte component library that can't load headlessly, so
 * we alias it to this stub in vitest.config.ts.
 */
export const MarkerType = {
	Arrow: 'arrow',
	ArrowClosed: 'arrowclosed'
} as const;

export type Node = any;
export type Edge = any;
export type Connection = any;
