# Pattern Serialization Guide

This document explains how ChromaBay converts the visual node graph you build in the editor into a compact payload that can be transmitted over Bluetooth Low Energy (BLE) to an ESP32.  
It is intended for **frontend developers** extending the editor _and_ **firmware developers** implementing the decoding / rendering pipeline on the micro-controller.

---

## 1  Overview

1. The editor exports a `SerializedPattern` object (or its compressed string form).  
2. Nodes are **topologically sorted** so execution order follows data-flow.  
3. Each node is assigned **input / output buffer indices** (1 byte values) that the ESP32 uses to know where to read from / write to.  
4. Keys are aggressively shortened to minimise bytes on-air.  
5. Optional LZ4 compression can further shrink the payload before sending.

```
JS   pattern → serializePattern() → JSON → compressPattern() → BLE
ESP32   BLE → (decompress) → execute pattern in order
```

> Typical patterns (< 10 nodes) compress to **< 250 bytes**.

---

## 2  JSON Format

### 2.1 Top-level schema

| Key | Type | Description |
|-----|------|-------------|
| `nodes` | `SerializedNode[]` | Execution list (already sorted). |
| `meta`  | object (opt.)     | Free-form metadata (author, version, …). |

### 2.2 `SerializedNode`

| Key | Bytes | Description |
|-----|-------|-------------|
| `t` | ≤ 12  | Node type (e.g. `"rainbow"`). |
| `o` | 1     | Output buffer index written by this node. |
| `i` | 1 (opt.) | Primary input buffer index (not present for generators). |
| `i2`| 1 (opt.) | Secondary input buffer (Blend nodes only). |
| `p` | var   | Map of parameter **name ➜ value** only when value ≠ default. |

### 2.3 Example

```json
{
  "nodes":[
    { "t":"rainbow", "o":1, "p":{ "speed":0.25 } },
    { "t":"gradient", "o":2, "p":{ "angle":90 } },
    { "t":"blend",    "o":1, "i":1, "i2":2, "p":{ "opacity":0.6 } },
    { "t":"output",   "o":0, "i":1 }
  ],
  "meta":{ "name":"Rainbow Fade", "ver":"1.0", "created":1713247890 }
}
```

*Execution order is exactly the array order; edges are **implicit**.*

---

## 3  Topological Sorting

`serializePattern()` performs:

1. Build an adjacency list from React-Flow edges.  
2. Kahn’s algorithm to obtain an acyclic order  
   (cycles are reported and broken arbitrarily).  
3. Output node is always placed last (if present).

Result: A single forward pass on ESP32 is sufficient—no need for graph traversal.

---

## 4  Buffer Assignment

The **ESP32 renderer runs sequentially** through `nodes[]`.  
A **triple-buffer** strategy (0–2) suits > 95 % of patterns:

| Index | Purpose                     |
|-------|-----------------------------|
| `0`   | Display / final frame (`output` writes here). |
| `1`   | Work buffer A               |
| `2`   | Work buffer B (used when two previous frames must be preserved, e.g. Blend). |

Algorithm:

```
current = 1
for each node in order:
    node.o = current
    if node has second input:
        node.i2 = bufferMap[input2]
    current = (current + 1) % 3
```

Generators (no input) omit `i`.  
Blend nodes carry both `i` and `i2`.  
Firmware just swaps `ptr` arrays using the indices—no extra copies.

---

## 5  Compression for BLE

`compressPattern()` currently returns raw JSON but logs **recommendations**:

* **LZ4 (raw block)** – ~3 × faster than zlib, minimal 64 B RAM, tiny decoder (≈ 1 kB flash).
* Transmit MTU-sized chunks (default 512 B).  
  For very large patterns (> 512 B), split across BLE Write With Response.

ESP32 C++:  

```cpp
#include "lz4.h"

int dstSize = LZ4_decompress_safe(src, dst, srcLen, dstCapacity);
```

> Keep a CRC-16 next to the compressed blob to verify integrity.

---

## 6  Usage & API (frontend)

```ts
import {
  serializeCurrentPattern,
  loadSerializedPattern,
  getPatternForBLE,
  getPatternSizeEstimate
} from '$lib/flowStore';

// Serialize
const jsonObj = serializeCurrentPattern();
const wireString = getPatternForBLE();    // ready for write()

// Size check
if (getPatternSizeEstimate() > 512) { … }

// Import pattern dropped by user
loadSerializedPattern(jsonParsedFromFile);
```

---

## 7  ESP32 Integration Guide

1. **Receive**  
   ```cpp
   std::string jsonOrLz4 = readBleChunks();
   ```

2. **(Optional) Decompress**  
   ```cpp
   std::string json = lz4Decompress(jsonOrLz4);
   ```

3. **Parse**  
   Use a lightweight JSON lib (e.g. ArduinoJson `deserializeJson()`).  
   Iterate `JsonArray nodes`.

4. **Execute** (every frame)  
   ```cpp
   for (auto n : nodes) {
       switch (nodeTypeId(n["t"])) {
           case NODE_RAINBOW:
               renderRainbow(buffers[n["o"]], n["p"]);
               break;
           …
           case NODE_BLEND:
               blend(
                    buffers[n["i"]],     // primary
                    buffers[n["i2"]],    // secondary
                    buffers[n["o"]],
                    n["p"]["opacity"]);
               break;
       }
   }
   show(buffers[0]);   // send to LEDs
   ```

5. **Edge-free** logic: Inputs are already resolved; look-ups are O(1).

### Suggested micro data types

```cpp
struct NodeHeader {
  uint8_t type;     // enum
  uint8_t o, i, i2; // buffers (255 = none)
  uint8_t paramLen; // bytes following
};
```

A single `memcpy()` from BLE into a `std::vector<uint8_t>` gives you a parse-friendly buffer.

---

## 8  Future Extensions

* **Quantised parameters** – map floats to `uint16_t` to reduce size.
* **Shader-like bytecode** – replace node types with opcodes for maximum density.
* **Delta updates** – send only changes to running pattern.

---

Happy hacking & colourful LEDs! 🎉
