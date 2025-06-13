/**
 * Pattern Serialization Round-Trip Test for Buffer Conflict Issue
 *
 * This test specifically validates the round-trip serialization/deserialization
 * of a known problematic JSON structure involving buffer conflicts.
 *
 * The test aims to ensure that:
 * 1. The provided JSON can be deserialized into a valid graph (nodes and edges).
 * 2. The deserialized graph can then be re-serialized back into an identical JSON structure.
 * 3. The order of nodes in the serialized array correctly handles buffer overwrites.
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
const problematicJsonString = `{"nodes":[{"t":"strobe","o":0},{"t":"moving_blob","o":1,"i":0},{"t":"raindrops","o":2,"i":0},{"t":"sparkle","o":0,"i":0}],"meta":{"output":1}}`;

function runBufferConflictTest(): boolean {
  log('🧪 Starting buffer conflict round-trip test');
  let testsPassed = true;

  try {
    // 1. Deserialize the target JSON into nodes and edges
    log('🔄 Deserializing problematic JSON...');
    const originalSerializedPattern: SerializedPattern = JSON.parse(problematicJsonString);

    const { nodes: deserializedNodes, edges: deserializedEdges, nodeParameters: deserializedNodeParameters } =
      deserializePattern(originalSerializedPattern);

    log(`📊 Deserialized ${deserializedNodes.length} nodes and ${deserializedEdges.length} edges`);

    // 2. Serialize those nodes and edges back to JSON
    log('🔄 Re-serializing deserialized pattern...');
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

    // 4. Specific check for node ordering to ensure buffer conflict resolution
    log('🔍 Verifying node ordering for buffer conflict...');
    const reSerializedNodes = reserializedPattern.nodes;

    const strobeIdx = reSerializedNodes.findIndex(n => n.t === 'strobe');
    const movingBlobIdx = reSerializedNodes.findIndex(n => n.t === 'moving_blob');
    const raindropsIdx = reSerializedNodes.findIndex(n => n.t === 'raindrops');
    const sparkleIdx = reSerializedNodes.findIndex(n => n.t === 'sparkle');

    if (strobeIdx === -1 || movingBlobIdx === -1 || raindropsIdx === -1 || sparkleIdx === -1) {
      log('❌ Could not find all required nodes for ordering check.');
      testsPassed = false;
    } else {
      // Strobe should be first among these four
      if (strobeIdx > movingBlobIdx || strobeIdx > raindropsIdx || strobeIdx > sparkleIdx) {
        log('❌ Strobe node is not positioned correctly (should be earliest).');
        testsPassed = false;
      } else {
        log('✅ Strobe node positioned correctly.');
      }

      // Sparkle (overwriter) should come after moving_blob and raindrops (readers)
      if (sparkleIdx < movingBlobIdx || sparkleIdx < raindropsIdx) {
        log('❌ Sparkle node is positioned too early (should be after readers).');
        testsPassed = false;
      } else {
        log('✅ Sparkle node positioned correctly after readers.');
      }
    }

  } catch (error) {
    log('❌ An error occurred during the test:', error);
    testsPassed = false;
  }

  log(`\n🏁 Buffer Conflict Round-trip Test ${testsPassed ? 'PASSED' : 'FAILED'}`);
  return testsPassed;
}

// Run the test
try {
  const testResult = runBufferConflictTest();
  if (!testResult) {
    process.exit(1); // Exit with error code if test fails
  }
} catch (error) {
  console.error('❌ TEST EXECUTION ERROR:', error);
  process.exit(1); // Exit with error code on unexpected errors
}
