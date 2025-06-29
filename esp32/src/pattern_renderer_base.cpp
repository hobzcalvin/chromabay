#include "pattern_renderer_base.h"
#include <Arduino.h>

// PatternRendererBase implementation using native operators
PatternRendererBase::PatternRendererBase(LedConfig::LedManager* ledMgr) 
    : ledManager(ledMgr), lastFrameTime(0), frameStartTime(0), globalTime(0), hasPattern(false) {
    
    // Clear all buffers
    for (int i = 0; i < NUM_BUFFERS; i++) {
        clearBuffer(i);
    }
}

PatternRendererBase::~PatternRendererBase() {
    // Cleanup handled by OperatorRegistry
}

void PatternRendererBase::clearBuffer(int bufferIndex) {
    if (bufferIndex < 0 || bufferIndex >= NUM_BUFFERS) return;
    
    for (int i = 0; i < DISPLAY_PIXELS; i++) {
        buffers[bufferIndex][i] = CRGB::Black;
    }
}

CRGB* PatternRendererBase::getBufferPtr(int bufferIndex) {
    if (bufferIndex < 0 || bufferIndex >= NUM_BUFFERS) return nullptr;
    return buffers[bufferIndex];
}

const CRGB* PatternRendererBase::getBuffer(int bufferIndex) const {
    if (bufferIndex < 0 || bufferIndex >= NUM_BUFFERS) return nullptr;
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
    if (!hasPattern) return;
    
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
                    DISPLAY_WIDTH,
                    DISPLAY_HEIGHT,
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
    if (!hasPattern || !ledManager) return;
    
    // Copy the output buffer to the LED manager
    const CRGB* outputBuffer = getBuffer(currentPattern.outputBuffer);
    if (outputBuffer) {
        for (int i = 0; i < DISPLAY_PIXELS; i++) {
            ledManager->setPixelColor(0, i, outputBuffer[i]);
        }
        ledManager->show();
    }
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
            if (mpack_node_type(nameNode) == mpack_type_str) {
                char nameBuffer[64];
                mpack_node_copy_cstr(nameNode, nameBuffer, sizeof(nameBuffer));
                pattern.name = String(nameBuffer);
            }
        }
        
        if (mpack_node_map_contains_cstr(metaNode, "output")) {
            mpack_node_t outputNode = mpack_node_map_cstr(metaNode, "output");
            if (mpack_node_type(outputNode) == mpack_type_int) {
                pattern.outputBuffer = mpack_node_int(outputNode);
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
                    if (mpack_node_type(typeNode) == mpack_type_str) {
                        char typeBuffer[32];
                        mpack_node_copy_cstr(typeNode, typeBuffer, sizeof(typeBuffer));
                        std::string operatorName(typeBuffer);
                        
                        // Use operator registry to create operator by name - direct lookup now!
                        node.op = OperatorRegistry::getInstance().createOperator(operatorName);
                        if (!node.op) {
                            Serial.printf("Failed to create operator: %s\n", operatorName.c_str());
                            continue; // Skip this node if operator creation failed
                        }
                    }
                }
                
                // Parse input/output buffers
                if (mpack_node_map_contains_cstr(nodeObj, "i")) {
                    node.inputBuffer = mpack_node_int(mpack_node_map_cstr(nodeObj, "i"));
                }
                if (mpack_node_map_contains_cstr(nodeObj, "o")) {
                    node.outputBuffer = mpack_node_int(mpack_node_map_cstr(nodeObj, "o"));
                }
                if (mpack_node_map_contains_cstr(nodeObj, "i2")) {
                    node.secondInputBuffer = mpack_node_int(mpack_node_map_cstr(nodeObj, "i2"));
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
                            
                            if (mpack_node_type(paramNode) == mpack_type_float) {
                                node.parameters[j] = ParameterValue(mpack_node_float(paramNode));
                            } else if (mpack_node_type(paramNode) == mpack_type_int) {
                                node.parameters[j] = ParameterValue((float)mpack_node_int(paramNode));
                            } else if (mpack_node_type(paramNode) == mpack_type_bool) {
                                node.parameters[j] = ParameterValue(mpack_node_bool(paramNode));
                            }
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
                                        if (mpack_node_type(valueNode) == mpack_type_float) {
                                            node.parameters[k] = ParameterValue(mpack_node_float(valueNode));
                                        } else if (mpack_node_type(valueNode) == mpack_type_int) {
                                            node.parameters[k] = ParameterValue((float)mpack_node_int(valueNode));
                                        } else if (mpack_node_type(valueNode) == mpack_type_bool) {
                                            node.parameters[k] = ParameterValue(mpack_node_bool(valueNode));
                                        }
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
