#include "pattern_renderer_base.h"
#include <Arduino.h>

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
    
    buffers = new CRGB*[NUM_BUFFERS];
    for (int i = 0; i < NUM_BUFFERS; i++) {
        buffers[i] = new CRGB[totalPixels];
        for (int j = 0; j < totalPixels; j++) {
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

void PatternRendererBase::initializeFromLedConfig() {
    // Get matrix dimensions from first LED strip
    if (ledManager && ledManager->getNumStrips() > 0) {
        LedConfig::LedBus* strip = ledManager->getStrip(0);
        if (strip) {
            const auto& config = strip->getConfig();
            if (config.width > 0 && config.height > 0) {
                matrixWidth = config.width;
                matrixHeight = config.height;
            } else {
                // Linear strip - treat as 1D
                matrixWidth = config.numLeds;
                matrixHeight = 1;
            }
        }
    }
    
    totalPixels = matrixWidth * matrixHeight;
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
    
    for (int i = 0; i < totalPixels; i++) {
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
    currentPattern = std::move(pattern);
    hasPattern = true;
}

void PatternRendererBase::clearPattern() {
    hasPattern = false;
    currentPattern.nodes.clear();
}

void PatternRendererBase::update() {
    if (!hasPattern || !buffersAllocated) return;
    
    unsigned long currentTime = millis();
    frameStartTime = currentTime;
    
    if (lastFrameTime == 0) {
        lastFrameTime = currentTime;
    }
    
    unsigned long deltaTime = currentTime - lastFrameTime;
    globalTime = currentTime;
    
    // Execute all nodes in sequence using native operators
    for (const auto& node : currentPattern.nodes) {
        if (node.op) {
            CRGB* inputBuffer1 = (node.inputBuffer >= 0) ? getBufferPtr(node.inputBuffer) : nullptr;
            CRGB* inputBuffer2 = (node.secondInputBuffer >= 0) ? getBufferPtr(node.secondInputBuffer) : nullptr;
            CRGB* outputBuffer = getBufferPtr(node.outputBuffer);
            
            if (outputBuffer) {
                node.op->render(
                    inputBuffer1,
                    inputBuffer2, 
                    outputBuffer,
                    matrixWidth,
                    matrixHeight,
                    globalTime,
                    deltaTime,
                    node.parameters
                );
            }
        }
    }
    
    lastFrameTime = currentTime;
}

void PatternRendererBase::render() {
    if (!hasPattern || !ledManager || !buffersAllocated) return;
    
    const CRGB* patternBuffer = getBuffer(currentPattern.outputBuffer);
    if (!patternBuffer || ledManager->getNumStrips() == 0) return;
    
    LedConfig::LedBus* strip = ledManager->getStrip(0);
    if (!strip) return;
    
    const auto& config = strip->getConfig();
    
    // Check if this is a matrix layout (has width and height)
    if (config.width > 0 && config.height > 0) {
        // 2D Matrix layout - map logical coordinates to physical LED indices
        // The pattern buffer is in logical row-major order: (0,0), (1,0), (2,0)... (0,1), (1,1)...
        
        for (uint16_t logicalY = 0; logicalY < matrixHeight; logicalY++) {
            for (uint16_t logicalX = 0; logicalX < matrixWidth; logicalX++) {
                // Get color from logical position in pattern buffer
                int patternIndex = logicalY * matrixWidth + logicalX;
                if (patternIndex >= totalPixels) continue;
                
                CRGB color = patternBuffer[patternIndex];
                
                // Map logical coordinates to physical coordinates using orientation
                uint16_t physicalX = logicalX;
                uint16_t physicalY = logicalY;
                
                // Apply rotation (bits 0-1 of orientation)
                uint8_t rotation = config.orientation & 0x03;
                switch (rotation) {
                    case 1: // 90° clockwise
                        {
                            uint16_t temp = physicalX;
                            physicalX = physicalY;
                            physicalY = matrixWidth - 1 - temp;
                        }
                        break;
                    case 2: // 180°
                        physicalX = matrixWidth - 1 - physicalX;
                        physicalY = matrixHeight - 1 - physicalY;
                        break;
                    case 3: // 270° clockwise (90° counter-clockwise)
                        {
                            uint16_t temp = physicalX;
                            physicalX = matrixHeight - 1 - physicalY;
                            physicalY = temp;
                        }
                        break;
                    default: // 0° - no rotation
                        break;
                }
                
                // Apply horizontal flip (bit 2 of orientation)
                if (config.orientation & 0x04) {
                    physicalX = matrixWidth - 1 - physicalX;
                }
                
                // Calculate final LED index considering serpentine layout (bit 3 of orientation)
                int ledIndex;
                if (config.orientation & 0x08) {
                    // Serpentine: odd rows are reversed
                    if (physicalY % 2 == 1) {
                        ledIndex = physicalY * matrixWidth + (matrixWidth - 1 - physicalX);
                    } else {
                        ledIndex = physicalY * matrixWidth + physicalX;
                    }
                } else {
                    // Normal row-major order
                    ledIndex = physicalY * matrixWidth + physicalX;
                }
                
                // Set the LED color
                if (ledIndex >= 0 && ledIndex < config.numLeds) {
                    strip->setPixelColor(ledIndex, color);
                }
            }
        }
    } else {
        // Linear strip - direct 1:1 mapping
        uint16_t pixelCount = min((uint16_t)totalPixels, config.numLeds);
        for (int i = 0; i < pixelCount; i++) {
            strip->setPixelColor(i, patternBuffer[i]);
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
