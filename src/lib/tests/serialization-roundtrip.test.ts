/**
 * Pattern Serialization Round-Trip Test for Problematic JSON
 *
 * This test validates the round-trip serialization/deserialization of a known
 * problematic multi-blend graph (two generators writing the same buffer, feeding
 * different blends — the case that previously corrupted on round-trip).
 *
 * It checks the two properties that actually matter for a buffer-based format:
 *   1. SEMANTIC PRESERVATION — deserializing, re-serializing, and deserializing
 *      again yields the same data-flow graph (same edges by node type + handle).
 *   2. IDEMPOTENCY — once serialized from a deserialized graph, serializing again
 *      produces byte-identical output (the serializer has a stable fixed point).
 *
 * Note: we deliberately do NOT assert byte-identity with the hand-authored input
 * JSON. The serializer emits its own canonical node ordering, which need not match
 * an arbitrary author's ordering even when the graph is identical.
 */

import {
  serializePattern,
  deserializePattern,
  type SerializedPattern
} from '../patternSerializer';
import { NODE_TYPES } from '../flowStore'; // Needed for node definitions during deserialization

// Test utilities
function log(...args: any[]): void {
  // Set to true for detailed test output, false for quiet
  const VERBOSE_LOGGING = true;
  if (VERBOSE_LOGGING) {
    console.log(...args);
  }
}

// The problematic JSON provided by the user
const problematicJsonString = `{"nodes":[{"t":"rainbow","o":0},{"t":"perlinnoise","o":1},{"t":"movingblob","o":2,"i":0},{"t":"raindrops","o":0,"i":0},{"t":"blend","o":0,"i":0,"i2":1},{"t":"gradient","o":1},{"t":"blend","o":2,"i":2,"i2":1},{"t":"blend","o":1,"i":0,"i2":2}],"meta":{"output":1}}`;

// Summarize a graph's data flow as a sorted list of `type -[handle]-> type` edges.
// This captures the wiring (which operator feeds which input) independent of node
// ids or array ordering, so two equivalent graphs compare equal.
function edgeSignature(nodes: any[], edges: any[]): string {
  const typeOf = (id: string) => nodes.find((n) => n.id === id)?.data.type ?? '?';
  return edges
    .map((e) => `${typeOf(e.source)} -[${e.targetHandle}]-> ${typeOf(e.target)}`)
    .sort()
    .join('\n');
}

function runProblematicJsonRoundtripTest(): boolean {
  log('🧪 Starting problematic JSON round-trip test');
  let testsPassed = true;

  try {
    const originalSerializedPattern: SerializedPattern = JSON.parse(problematicJsonString);

    // Deserialize → graph G1
    log('🔄 Deserializing problematic JSON...');
    const g1 = deserializePattern(originalSerializedPattern);
    log(`📊 G1: ${g1.nodes.length} nodes, ${g1.edges.length} edges`);

    // Serialize G1 → reser1, then deserialize again → graph G2
    log('🔄 Re-serializing, then deserializing again...');
    const reser1 = serializePattern(g1.nodes, g1.edges, g1.nodeParameters, originalSerializedPattern.meta?.name);
    const g2 = deserializePattern(reser1);

    // Serialize G2 → reser2 (to check the serializer reached a stable fixed point)
    const reser2 = serializePattern(g2.nodes, g2.edges, g2.nodeParameters, originalSerializedPattern.meta?.name);

    log('📊 Re-serialized pattern:', JSON.stringify(reser1));

    // Property 1: semantic preservation — the data-flow graph survives the round-trip.
    const sig1 = edgeSignature(g1.nodes, g1.edges);
    const sig2 = edgeSignature(g2.nodes, g2.edges);
    if (sig1 === sig2) {
      log('✅ Semantic round-trip preserved: data-flow graph is identical.');
    } else {
      log('❌ Semantic round-trip FAILED: data-flow graph changed.');
      log('--- G1 edges ---');
      log(sig1);
      log('--- G2 edges ---');
      log(sig2);
      testsPassed = false;
    }

    // Property 2: idempotency — re-serializing a deserialized graph is a fixed point.
    if (JSON.stringify(reser1) === JSON.stringify(reser2)) {
      log('✅ Serializer is idempotent: reser1 === reser2.');
    } else {
      log('❌ Serializer is NOT idempotent: reser1 !== reser2.');
      log('--- reser1 ---');
      log(JSON.stringify(reser1));
      log('--- reser2 ---');
      log(JSON.stringify(reser2));
      testsPassed = false;
    }

  } catch (error) {
    log('❌ An error occurred during the test:', error);
    testsPassed = false;
  }

  log(`\n🏁 Problematic JSON Round-trip Test ${testsPassed ? 'PASSED' : 'FAILED'}`);
  return testsPassed;
}

// Bridge into Vitest. Operator definitions come from the real WASM module via the
// harness setup (see harness/setup.ts).
import { describe, it, expect } from 'vitest';

describe('pattern serialization round-trip', () => {
  it('round-trips a known-problematic multi-blend graph', () => {
    expect(runProblematicJsonRoundtripTest()).toBe(true);
  });
});
