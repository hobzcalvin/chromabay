#include "pattern_renderer_base.h"
#include <Arduino.h>
#include <new> // std::nothrow
#include <cstring> // strcmp (operator-type compare for state-preserving pattern updates)

// PatternRendererBase implementation using native operators
PatternRendererBase::PatternRendererBase(LedConfig::LedManager* ledMgr) 
    : ledManager(ledMgr), buffers(nullptr), lastFrameTime(0), frameStartTime(0), globalTime(0), hasPattern(false) {
    
    initializeFromLedConfig();
}

PatternRendererBase::~PatternRendererBase() {
    deallocateBuffers();
}

void PatternRendererBase::allocateBuffers() {
    if (buffersAllocated) {
        deallocateBuffers();
    }
    
    uint32_t totalPixels = getTotalPixels();
    if (totalPixels == 0) {
        Serial.println("PatternRenderer: refusing to allocate 0-pixel buffers");
        return; // buffersAllocated stays false; update()/render() bail via their guards
    }

    buffers = new CRGB*[NUM_BUFFERS];
    for (int i = 0; i < NUM_BUFFERS; i++) {
        buffers[i] = new (std::nothrow) CRGB[totalPixels];
        if (!buffers[i]) {
            // Out of memory — the configured matrix is too large for available
            // RAM. Roll back instead of writing into a null/short buffer (which
            // would corrupt the heap once operators render width*height pixels).
            Serial.printf("PatternRenderer: failed to allocate %u-pixel buffer (out of memory)\n",
                          (unsigned)totalPixels);
            for (int k = 0; k < i; k++) delete[] buffers[k];
            delete[] buffers;
            buffers = nullptr;
            return; // buffersAllocated stays false
        }
        for (uint32_t j = 0; j < totalPixels; j++) {
            buffers[i][j] = CRGB::Black;
        }
    }
    buffersAllocated = true;
}

void PatternRendererBase::deallocateBuffers() {
    if (buffersAllocated && buffers) {
        for (int i = 0; i < NUM_BUFFERS; i++) {
            delete[] buffers[i];
        }
        delete[] buffers;
        buffers = nullptr;
        buffersAllocated = false;
    }
}

uint16_t PatternRendererBase::getMatrixWidth() const {
    if (!ledManager || ledManager->getNumStrips() == 0) return 8; // Default fallback

    // Multiple strips MIRROR the same pattern (see render()): the canvas is sized to
    // the widest strip, and each strip samples the full canvas independently. Using
    // the max (not strip 0) keeps the canvas stable when a smaller strip is added or
    // removed, so strips don't share a coordinate space.
    if (ledManager->getNumStrips() > 1) {
        uint16_t maxW = 0;
        for (size_t i = 0; i < ledManager->getNumStrips(); i++) {
            const LedConfig::LedBus* s = ledManager->getStrip(i);
            if (!s) continue;
            const auto& c = s->getConfig();
            uint16_t w = c.width > 0 ? c.width : c.numLeds;
            if (w > maxW) maxW = w;
        }
        return maxW > 0 ? maxW : 8;
    }

    const LedConfig::LedBus* strip = ledManager->getStrip(0);
    if (!strip) return 8; // Default fallback
    
    const auto& config = strip->getConfig();
    if (config.width > 0) {
        return config.width;
    } else {
        // Linear strip (no matrix dimensions): treat it as a 1 x numLeds row so
        // every LED is driven. The previous sqrt(numLeds) "square" left the tail
        // LEDs of any non-perfect-square strip permanently dark (e.g. 300 LEDs
        // rendered as 17x17 = 289, leaving 11 dark) and folded a 2D image onto a
        // 1D strip, which isn't meaningful anyway.
        return config.numLeds;
    }
}

uint16_t PatternRendererBase::getMatrixHeight() const {
    if (!ledManager || ledManager->getNumStrips() == 0) return 8; // Default fallback

    // Mirror multi-strip mode: canvas height is the tallest strip (see getMatrixWidth).
    if (ledManager->getNumStrips() > 1) {
        uint16_t maxH = 0;
        for (size_t i = 0; i < ledManager->getNumStrips(); i++) {
            const LedConfig::LedBus* s = ledManager->getStrip(i);
            if (!s) continue;
            const auto& c = s->getConfig();
            uint16_t h = c.height > 0 ? c.height : 1;
            if (h > maxH) maxH = h;
        }
        return maxH > 0 ? maxH : 1;
    }

    const LedConfig::LedBus* strip = ledManager->getStrip(0);
    if (!strip) return 8; // Default fallback

    const auto& config = strip->getConfig();
    if (config.height > 0) {
        return config.height;
    } else {
        // Linear strip: a single row (see getMatrixWidth). totalPixels then
        // equals numLeds and the strip is driven 1:1.
        return 1;
    }
}

uint32_t PatternRendererBase::getTotalPixels() const {
    // uint32 so width*height can't overflow a uint16 for larger matrices
    // (e.g. 300x300 = 90000) — truncation there sized buffers far too small and
    // let operators write past them (heap corruption).
    return (uint32_t)getMatrixWidth() * (uint32_t)getMatrixHeight();
}

void PatternRendererBase::initializeFromLedConfig() {
    if (!ledManager || ledManager->getNumStrips() == 0) {
        Serial.println("PatternRenderer: No LED strips available");
        return;
    }
    
    const LedConfig::LedBus* strip = ledManager->getStrip(0);
    if (!strip) {
        Serial.println("PatternRenderer: Strip 0 not available");
        return;
    }
    
    const auto& config = strip->getConfig();
    uint16_t width = getMatrixWidth();
    uint16_t height = getMatrixHeight();
    uint32_t pixels = getTotalPixels();
    
    if (config.width > 0 && config.height > 0) {
        Serial.printf("PatternRenderer: Matrix mode %dx%d (%d pixels)\n", width, height, pixels);
    } else {
        Serial.printf("PatternRenderer: Linear mode, using %dx%d matrix (%d of %d pixels)\n", 
                     width, height, pixels, config.numLeds);
    }
    
    allocateBuffers();
}

void PatternRendererBase::updateMatrixConfig() {
    initializeFromLedConfig();
    // Clear all buffers after reallocation
    for (int i = 0; i < NUM_BUFFERS; i++) {
        clearBuffer(i);
    }
}

void PatternRendererBase::clearBuffer(int bufferIndex) {
    if (bufferIndex < 0 || bufferIndex >= NUM_BUFFERS || !buffersAllocated) return;
    
    uint32_t totalPixels = getTotalPixels();
    for (uint32_t i = 0; i < totalPixels; i++) {
        buffers[bufferIndex][i] = CRGB::Black;
    }
}

CRGB* PatternRendererBase::getBufferPtr(int bufferIndex) {
    if (bufferIndex < 0 || bufferIndex >= NUM_BUFFERS || !buffersAllocated) return nullptr;
    return buffers[bufferIndex];
}

const CRGB* PatternRendererBase::getBuffer(int bufferIndex) const {
    if (bufferIndex < 0 || bufferIndex >= NUM_BUFFERS || !buffersAllocated) return nullptr;
    return buffers[bufferIndex];
}

void PatternRendererBase::setPattern(Pattern&& pattern) {
    // If the incoming pattern has the SAME structure as the current one (same operator
    // types + same buffer wiring — only parameters differ), reuse the existing operator
    // instances so STATEFUL operators don't reset. The app resends the whole pattern on
    // every parameter change, so without this a Fire/Moving-Blobs slider nudge restarts
    // the simulation from scratch.
    bool preserved = false;
    if (hasPattern && currentPattern.nodes.size() == pattern.nodes.size() && !pattern.nodes.empty()) {
        bool same = true;
        for (size_t i = 0; i < pattern.nodes.size(); i++) {
            const PatternNode& a = currentPattern.nodes[i];
            const PatternNode& b = pattern.nodes[i];
            if (!a.op || !b.op ||
                a.inputBuffer != b.inputBuffer ||
                a.outputBuffer != b.outputBuffer ||
                a.secondInputBuffer != b.secondInputBuffer ||
                strcmp(a.op->getName(), b.op->getName()) != 0) {
                same = false;
                break;
            }
        }
        if (same) {
            // Move the existing (stateful) operators into the new pattern, keeping its
            // freshly-parsed parameters/wiring. The just-created operators in `pattern`
            // are discarded.
            for (size_t i = 0; i < pattern.nodes.size(); i++) {
                pattern.nodes[i].op = std::move(currentPattern.nodes[i].op);
            }
            preserved = true;
        }
    }

    currentPattern = std::move(pattern);
    hasPattern = true;
    Serial.printf("Pattern set: %u node(s), operator state %s\n",
                  (unsigned)currentPattern.nodes.size(), preserved ? "PRESERVED" : "fresh");
}

void PatternRendererBase::clearPattern() {
    hasPattern = false;
    currentPattern.nodes.clear();
}

unsigned long PatternRendererBase::getCurrentTime() {
    if (useSyncedTime) {
        // Calculate elapsed time since sync point using local millis()
        unsigned long currentLocalTime = millis();
        unsigned long elapsedTime = currentLocalTime - syncedLocalTime;
        return syncedBaseTime + elapsedTime;
    } else {
        // Fall back to local time if no sync received
        return millis();
    }
}

void PatternRendererBase::setSynchronizedTime(unsigned long syncTimestamp, unsigned long localTime) {
    syncedBaseTime = syncTimestamp;
    syncedLocalTime = localTime;
    useSyncedTime = true;
    Serial.printf("PatternRenderer: Sync time set - base: %lu, local: %lu\n", syncTimestamp, localTime);
}

void PatternRendererBase::clearSynchronizedTime() {
    useSyncedTime = false;
    syncedBaseTime = 0;
    syncedLocalTime = 0;
    Serial.println("PatternRenderer: Synchronized time cleared");
}

void PatternRendererBase::update() {
    if (!hasPattern || !buffersAllocated) return;
    
    unsigned long currentTime = getCurrentTime(); // Use synchronized time if available
    frameStartTime = currentTime;
    
    if (lastFrameTime == 0) {
        lastFrameTime = currentTime;
    }
    
    unsigned long deltaTime = currentTime - lastFrameTime;
    globalTime = currentTime;
    
    // Capture the frame's time ONCE here. render() runs the operator graph per strip,
    // and every strip must render the same instant. Keep it float-friendly (large ms
    // lose float precision): 1M ms ≈ 16.67 min cycle.
    frameFloatTime = globalTime % 1000000;
    frameFloatDelta = deltaTime;

    lastFrameTime = currentTime;
}

void PatternRendererBase::renderGraphAt(uint16_t width, uint16_t height) {
    // Run every operator node into the shared buffers at the given canvas size.
    for (const auto& node : currentPattern.nodes) {
        if (!node.op) continue;
        CRGB* inputBuffer1 = (node.inputBuffer >= 0) ? getBufferPtr(node.inputBuffer) : nullptr;
        CRGB* inputBuffer2 = (node.secondInputBuffer >= 0) ? getBufferPtr(node.secondInputBuffer) : nullptr;
        CRGB* outputBuffer = getBufferPtr(node.outputBuffer);
        if (outputBuffer) {
            node.op->render(inputBuffer1, inputBuffer2, outputBuffer,
                            width, height, frameFloatTime, frameFloatDelta, node.parameters);
        }
    }
}

void PatternRendererBase::render() {
    if (!hasPattern || !ledManager || !buffersAllocated) return;
    if (ledManager->getNumStrips() == 0) return;

    // Nothing wired to the Output node: meta.output is the sentinel -1 (or otherwise
    // out of range). Show black rather than whatever a node happens to leave in a lane
    // buffer, so disconnected nodes can't "bleed" onto the LEDs.
    if (currentPattern.outputBuffer < 0 || currentPattern.outputBuffer >= NUM_BUFFERS) {
        for (size_t s = 0; s < ledManager->getNumStrips(); s++) {
            LedConfig::LedBus* strip = ledManager->getStrip(s);
            if (!strip) continue;
            const auto& config = strip->getConfig();
            for (uint16_t i = 0; i < config.numLeds; i++) strip->setPixelColor(i, CRGB::Black);
        }
        ledManager->show();
        return;
    }

    // Each strip is its OWN canvas: run the full operator graph at the strip's own
    // dimensions into its own LED space. A 1xN linear strip renders the effects at
    // 1xN; a WxH matrix renders at WxH — independent coordinate spaces. The shared
    // buffers are sized to the largest strip and reused per strip: we output to the
    // strip immediately after rendering, before the next strip overwrites them.
    const uint32_t bufferCap = getTotalPixels(); // capacity = largest strip's pixels

    for (size_t s = 0; s < ledManager->getNumStrips(); s++) {
        LedConfig::LedBus* strip = ledManager->getStrip(s);
        if (!strip) continue;
        const auto& config = strip->getConfig();

        uint16_t w = config.width > 0 ? config.width : config.numLeds;
        uint16_t h = config.height > 0 ? config.height : 1;
        if (w == 0 || h == 0) continue;
        // Safety net: never render past the allocated buffers (shouldn't trigger —
        // buffers are sized to the widest x tallest strip).
        if ((uint32_t)w * (uint32_t)h > bufferCap) {
            w = (uint16_t)(bufferCap / h);
            if (w == 0) continue;
        }

        renderGraphAt(w, h);

        const CRGB* patternBuffer = getBuffer(currentPattern.outputBuffer);
        if (!patternBuffer) continue;

        if (config.isMatrix()) {
            // 2D matrix: xyToIndex owns rotation/flip/serpentine mapping.
            for (uint16_t y = 0; y < h; y++) {
                for (uint16_t x = 0; x < w; x++) {
                    int ledIndex = config.xyToIndex(x, y);
                    if (ledIndex >= 0 && ledIndex < config.numLeds) {
                        strip->setPixelColor(ledIndex, patternBuffer[(uint32_t)y * w + x]);
                    }
                }
            }
        } else {
            // Linear strip: direct 1:1 (w == numLeds, h == 1).
            uint32_t pixelCount = (uint32_t)w * (uint32_t)h;
            if (pixelCount > (uint32_t)config.numLeds) pixelCount = config.numLeds;
            for (uint32_t i = 0; i < pixelCount; i++) {
                strip->setPixelColor((uint16_t)i, patternBuffer[i]);
            }
        }
    }

    ledManager->show();
}

bool PatternRendererBase::loadPatternFromMessagePack(const uint8_t* data, unsigned int size) {
    mpack_tree_t tree;
    mpack_tree_init_data(&tree, (const char*)data, size);
    mpack_tree_parse(&tree);
    mpack_node_t root = mpack_tree_root(&tree);

    if (mpack_tree_error(&tree) != mpack_ok) {
        mpack_tree_destroy(&tree);
        return false;
    }

    Pattern pattern;
    
    // Parse meta information
    if (mpack_node_map_contains_cstr(root, "meta")) {
        mpack_node_t metaNode = mpack_node_map_cstr(root, "meta");
        
        if (mpack_node_map_contains_cstr(metaNode, "name")) {
            mpack_node_t nameNode = mpack_node_map_cstr(metaNode, "name");
            mpack_type_t nameType = mpack_node_type(nameNode);
            if (nameType == mpack_type_str) {
                char nameBuffer[64];
                mpack_node_copy_cstr(nameNode, nameBuffer, sizeof(nameBuffer));
                pattern.name = String(nameBuffer);
            } else if (nameType == mpack_type_nil) {
                pattern.name = ""; // Default to empty string for null values
            } else {
                pattern.name = ""; // Default to empty string for other types
            }
        }
        
        if (mpack_node_map_contains_cstr(metaNode, "output")) {
            mpack_node_t outputNode = mpack_node_map_cstr(metaNode, "output");
            mpack_type_t outputType = mpack_node_type(outputNode);
            if (outputType == mpack_type_int) {
                pattern.outputBuffer = mpack_node_int(outputNode);
            } else if (outputType == mpack_type_uint) {
                pattern.outputBuffer = (int)mpack_node_uint(outputNode);
            } else if (outputType == mpack_type_float) {
                pattern.outputBuffer = (int)mpack_node_float(outputNode);
            } else if (outputType == mpack_type_double) {
                pattern.outputBuffer = (int)mpack_node_double(outputNode);
            } else if (outputType == mpack_type_nil) {
                pattern.outputBuffer = 0; // Default to buffer 0 for null values
            } else {
                pattern.outputBuffer = 0; // Default to buffer 0 for other types
            }
        }
    }
    
    // Parse nodes using operator registry
    if (mpack_node_map_contains_cstr(root, "nodes")) {
        mpack_node_t nodesArray = mpack_node_map_cstr(root, "nodes");
        if (mpack_node_type(nodesArray) == mpack_type_array) {
            size_t nodeCount = mpack_node_array_length(nodesArray);
            
            for (size_t i = 0; i < nodeCount; i++) {
                mpack_node_t nodeObj = mpack_node_array_at(nodesArray, i);
                PatternNode node;
                
                // Parse operator type and create operator using registry
                if (mpack_node_map_contains_cstr(nodeObj, "t")) {
                    mpack_node_t typeNode = mpack_node_map_cstr(nodeObj, "t");
                    mpack_type_t typeNodeType = mpack_node_type(typeNode);
                    if (typeNodeType == mpack_type_str) {
                        char typeBuffer[32];
                        mpack_node_copy_cstr(typeNode, typeBuffer, sizeof(typeBuffer));
                        std::string operatorName(typeBuffer);
                        
                        // Use operator registry to create operator by name
                        node.op = OperatorRegistry::getInstance().createOperator(operatorName);
                        if (!node.op) {
                            continue; // Skip this node if operator creation failed
                        }
                    } else {
                        continue; // Skip nodes with invalid or null operator types
                    }
                } else {
                    continue; // Skip nodes without operator type
                }
                
                // Parse input/output buffers with robust type checking
                if (mpack_node_map_contains_cstr(nodeObj, "i")) {
                    mpack_node_t inputNode = mpack_node_map_cstr(nodeObj, "i");
                    mpack_type_t inputType = mpack_node_type(inputNode);
                    if (inputType == mpack_type_int) {
                        node.inputBuffer = mpack_node_int(inputNode);
                    } else if (inputType == mpack_type_uint) {
                        node.inputBuffer = (int)mpack_node_uint(inputNode);
                    } else if (inputType == mpack_type_float) {
                        node.inputBuffer = (int)mpack_node_float(inputNode);
                    } else if (inputType == mpack_type_double) {
                        node.inputBuffer = (int)mpack_node_double(inputNode);
                    } else {
                        node.inputBuffer = -1; // Default for other types
                    }
                }
                
                if (mpack_node_map_contains_cstr(nodeObj, "o")) {
                    mpack_node_t outputNode = mpack_node_map_cstr(nodeObj, "o");
                    mpack_type_t outputType = mpack_node_type(outputNode);
                    if (outputType == mpack_type_int) {
                        node.outputBuffer = mpack_node_int(outputNode);
                    } else if (outputType == mpack_type_uint) {
                        node.outputBuffer = (int)mpack_node_uint(outputNode);
                    } else if (outputType == mpack_type_float) {
                        node.outputBuffer = (int)mpack_node_float(outputNode);
                    } else if (outputType == mpack_type_double) {
                        node.outputBuffer = (int)mpack_node_double(outputNode);
                    } else {
                        node.outputBuffer = 0; // Default for other types
                    }
                } else {
                    node.outputBuffer = 0; // Default when missing
                }
                
                if (mpack_node_map_contains_cstr(nodeObj, "i2")) {
                    mpack_node_t input2Node = mpack_node_map_cstr(nodeObj, "i2");
                    mpack_type_t input2Type = mpack_node_type(input2Node);
                    if (input2Type == mpack_type_int) {
                        node.secondInputBuffer = mpack_node_int(input2Node);
                    } else if (input2Type == mpack_type_uint) {
                        node.secondInputBuffer = (int)mpack_node_uint(input2Node);
                    } else if (input2Type == mpack_type_float) {
                        node.secondInputBuffer = (int)mpack_node_float(input2Node);
                    } else if (input2Type == mpack_type_double) {
                        node.secondInputBuffer = (int)mpack_node_double(input2Node);
                    } else {
                        node.secondInputBuffer = -1; // Default for other types
                    }
                }
                
                // Parse parameters using native ParameterValue system
                if (mpack_node_map_contains_cstr(nodeObj, "p") && node.op) {
                    mpack_node_t paramsNode = mpack_node_map_cstr(nodeObj, "p");
                    
                    // Get parameter info from the operator to know expected parameters
                    auto paramInfo = node.op->getParameterInfo();
                    node.parameters.resize(paramInfo.size());
                    
                    // Initialize with default values
                    for (size_t j = 0; j < paramInfo.size(); j++) {
                        node.parameters[j] = paramInfo[j].defaultValue;
                    }
                    
                    // Handle both array and map parameter formats
                    if (mpack_node_type(paramsNode) == mpack_type_array) {
                        // Array format: parameters in order
                        size_t paramCount = mpack_node_array_length(paramsNode);
                        size_t maxParams = (paramCount < paramInfo.size()) ? paramCount : paramInfo.size();
                        
                        for (size_t j = 0; j < maxParams; j++) {
                            mpack_node_t paramNode = mpack_node_array_at(paramsNode, j);
                            mpack_type_t paramType = mpack_node_type(paramNode);
                            
                            if (paramType == mpack_type_float) {
                                float value = mpack_node_float(paramNode);
                                node.parameters[j] = ParameterValue(value);
                            } else if (paramType == mpack_type_int) {
                                float value = (float)mpack_node_int(paramNode);
                                node.parameters[j] = ParameterValue(value);
                            } else if (paramType == mpack_type_uint) {
                                float value = (float)mpack_node_uint(paramNode);
                                node.parameters[j] = ParameterValue(value);
                            } else if (paramType == mpack_type_double) {
                                float value = (float)mpack_node_double(paramNode);
                                node.parameters[j] = ParameterValue(value);
                            } else if (paramType == mpack_type_bool) {
                                bool value = mpack_node_bool(paramNode);
                                node.parameters[j] = ParameterValue(value);
                            }
                            // For nil or unknown types, keep the default value
                        }
                    } else if (mpack_node_type(paramsNode) == mpack_type_map) {
                        // Map format: parameters by name
                        size_t paramCount = mpack_node_map_count(paramsNode);
                        
                        for (size_t j = 0; j < paramCount; j++) {
                            mpack_node_t keyNode = mpack_node_map_key_at(paramsNode, j);
                            mpack_node_t valueNode = mpack_node_map_value_at(paramsNode, j);
                            
                            if (mpack_node_type(keyNode) == mpack_type_str) {
                                char keyBuffer[32];
                                mpack_node_copy_cstr(keyNode, keyBuffer, sizeof(keyBuffer));
                                std::string paramName(keyBuffer);
                                
                                // Find parameter index by name
                                for (size_t k = 0; k < paramInfo.size(); k++) {
                                    if (paramInfo[k].name == paramName) {
                                        mpack_type_t valueType = mpack_node_type(valueNode);
                                        if (valueType == mpack_type_float) {
                                            float value = mpack_node_float(valueNode);
                                            node.parameters[k] = ParameterValue(value);
                                        } else if (valueType == mpack_type_int) {
                                            float value = (float)mpack_node_int(valueNode);
                                            node.parameters[k] = ParameterValue(value);
                                        } else if (valueType == mpack_type_uint) {
                                            float value = (float)mpack_node_uint(valueNode);
                                            node.parameters[k] = ParameterValue(value);
                                        } else if (valueType == mpack_type_double) {
                                            float value = (float)mpack_node_double(valueNode);
                                            node.parameters[k] = ParameterValue(value);
                                        } else if (valueType == mpack_type_bool) {
                                            bool value = mpack_node_bool(valueNode);
                                            node.parameters[k] = ParameterValue(value);
                                        }
                                        // For nil or unknown types, keep default value
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                
                // Only add node if operator was created successfully
                if (node.op) {
                    pattern.nodes.push_back(std::move(node));
                }
            }
        }
    }
    
    mpack_tree_destroy(&tree);
    
    setPattern(std::move(pattern));
    return true;
}
