/**
 * Pattern Serialization Round-Trip Test for Problematic JSON
 *
 * This test specifically validates the round-trip serialization/deserialization
 * of a known problematic JSON structure provided by the user.
 *
 * The test aims to ensure that:
 * 1. The provided JSON can be deserialized into a valid graph (nodes and edges).
 * 2. The deserialized graph can then be re-serialized back into an identical JSON structure.
 *
 * This serves as a concrete failing/passing test case for the serialization algorithm.
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
const problematicJsonString = `{"nodes":[{"t":"rainbow","o":0},{"t":"perlin_noise","o":1},{"t":"moving_blob","o":2,"i":0},{"t":"raindrops","o":0,"i":0},{"t":"blend","o":0,"i":0,"i2":1},{"t":"gradient","o":1},{"t":"blend","o":2,"i":2,"i2":1},{"t":"blend","o":1,"i":0,"i2":2}],"meta":{"output":1}}`;

function runProblematicJsonRoundtripTest(): boolean {
  log('🧪 Starting problematic JSON round-trip test');
  let testsPassed = true;

  try {
    // 1. Deserialize the target JSON into nodes and edges
    log('🔄 Deserializing problematic JSON...');
    const originalSerializedPattern: SerializedPattern = JSON.parse(problematicJsonString);

    // Deserialize the pattern. We don't need the nodeParameters map for this test,
    // as we are re-serializing immediately and not interacting with the UI.
    const { nodes: deserializedNodes, edges: deserializedEdges, nodeParameters: deserializedNodeParameters } =
      deserializePattern(originalSerializedPattern);

    log(`📊 Deserialized ${deserializedNodes.length} nodes and ${deserializedEdges.length} edges`);

    // 2. Serialize those nodes and edges back to JSON
    log('🔄 Re-serializing deserialized pattern...');
    // Pass the deserialized node parameters back to serializePattern
    // Also pass the original pattern name if it exists, otherwise undefined
    const reserializedPattern = serializePattern(
      deserializedNodes,
      deserializedEdges,
      deserializedNodeParameters,
      originalSerializedPattern.meta?.name
    );

    log('📊 Re-serialized pattern structure:', JSON.stringify(reserializedPattern, null, 2));

    // 3. Compare the result with the original JSON to ensure perfect round-trip
    log('🔍 Comparing original and re-serialized JSON...');
    const originalStringified = JSON.stringify(originalSerializedPattern);
    const reserializedStringified = JSON.stringify(reserializedPattern);

    if (originalStringified === reserializedStringified) {
      log('✅ Perfect round-trip achieved: Original and re-serialized JSON are identical.');
    } else {
      log('❌ Round-trip FAILED: Original and re-serialized JSON differ.');
      log('--- Original JSON ---');
      log(originalStringified);
      log('--- Re-serialized JSON ---');
      log(reserializedStringified);
      testsPassed = false;
    }

  } catch (error) {
    log('❌ An error occurred during the test:', error);
    testsPassed = false;
  }

  log(`\n🏁 Problematic JSON Round-trip Test ${testsPassed ? 'PASSED' : 'FAILED'}`);
  return testsPassed;
}

// Run the test
try {
  const testResult = runProblematicJsonRoundtripTest();
  if (!testResult) {
    process.exit(1); // Exit with error code if test fails
  }
} catch (error) {
  console.error('❌ TEST EXECUTION ERROR:', error);
  process.exit(1); // Exit with error code on unexpected errors
}
