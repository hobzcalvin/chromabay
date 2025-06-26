#include "pattern_renderer.h"
#include <Arduino.h>
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Global instance
PatternRenderer* g_patternRenderer = nullptr;

// FastLED timing compatibility functions
uint8_t beat8_esp32(uint16_t beats_per_minute, uint32_t timebase) {
    if (timebase == 0) timebase = millis();
    uint32_t beat = (timebase * beats_per_minute) / 60000;
    return (beat % 256);
}

uint16_t beat16_esp32(uint16_t beats_per_minute, uint32_t timebase) {
    if (timebase == 0) timebase = millis();
    uint32_t beat = (timebase * beats_per_minute) / 60000;
    return (beat % 65536);
}

// Simplified noise function for ESP32
uint8_t inoise8_esp32(uint16_t x, uint16_t y, uint16_t z) {
    // Simple pseudo-noise based on sine waves
    float fx = x / 256.0f;
    float fy = y / 256.0f;
    float fz = z / 256.0f;
    
    float noise = sin(fx * 2.3f + fy * 1.7f + fz * 0.9f) * 
                  sin(fx * 1.1f + fy * 2.7f + fz * 1.3f) * 
                  sin(fx * 3.1f + fy * 0.7f + fz * 2.1f);
    
    return (uint8_t)((noise + 1.0f) * 127.5f);
}

// Math functions
uint8_t sin8_esp32(uint8_t theta) {
    return (uint8_t)((sin(theta * 2.0f * M_PI / 256.0f) + 1.0f) * 127.5f);
}

uint8_t cos8_esp32(uint8_t theta) {
    return (uint8_t)((cos(theta * 2.0f * M_PI / 256.0f) + 1.0f) * 127.5f);
}

uint8_t random8_esp32() {
    return random(256);
}

uint8_t random8_esp32(uint8_t max) {
    return random(max);
}

uint8_t qadd8_esp32(uint8_t a, uint8_t b) {
    uint16_t sum = a + b;
    return (sum > 255) ? 255 : sum;
}

uint8_t qsub8_esp32(uint8_t a, uint8_t b) {
    return (a > b) ? (a - b) : 0;
}

// Utility functions
ESP32OperatorType parseOperatorType(const String& typeString) {
    if (typeString == "blend") return ESP32OperatorType::BLEND;
    if (typeString == "chase") return ESP32OperatorType::CHASE;
    if (typeString == "fade") return ESP32OperatorType::FADE;
    if (typeString == "gradient") return ESP32OperatorType::GRADIENT;
    if (typeString == "moving_blob") return ESP32OperatorType::MOVING_BLOB;
    if (typeString == "perlin_noise") return ESP32OperatorType::PERLIN_NOISE;
    if (typeString == "rainbow") return ESP32OperatorType::RAINBOW;
    if (typeString == "raindrops") return ESP32OperatorType::RAINDROPS;
    if (typeString == "sparkle") return ESP32OperatorType::SPARKLE;
    if (typeString == "strobe") return ESP32OperatorType::STROBE;
    return ESP32OperatorType::RAINBOW; // Default fallback
}

String operatorTypeToString(ESP32OperatorType type) {
    switch (type) {
        case ESP32OperatorType::BLEND: return "blend";
        case ESP32OperatorType::CHASE: return "chase";
        case ESP32OperatorType::FADE: return "fade";
        case ESP32OperatorType::GRADIENT: return "gradient";
        case ESP32OperatorType::MOVING_BLOB: return "moving_blob";
        case ESP32OperatorType::PERLIN_NOISE: return "perlin_noise";
        case ESP32OperatorType::RAINBOW: return "rainbow";
        case ESP32OperatorType::RAINDROPS: return "raindrops";
        case ESP32OperatorType::SPARKLE: return "sparkle";
        case ESP32OperatorType::STROBE: return "strobe";
        default: return "rainbow";
    }
}

// PatternRenderer implementation
PatternRenderer::PatternRenderer(LedConfig::LedManager* ledMgr) 
    : ledManager(ledMgr), lastFrameTime(0), frameStartTime(0), globalTime(0) {
    
    // Clear all buffers
    for (int i = 0; i < NUM_BUFFERS; i++) {
        clearBuffer(i);
    }
    
    // Set up default pattern (simple rainbow)
    Pattern defaultPattern;
    defaultPattern.name = "Default Rainbow";
    defaultPattern.outputBuffer = 0; // Center lane (0-based indexing)
    
    PatternNode rainbowNode;
    rainbowNode.type = ESP32OperatorType::RAINBOW;
    rainbowNode.outputBuffer = 0;
    rainbowNode.parameters = {
        {120.0f, "speed"},
        {255.0f, "saturation"},
        {255.0f, "value"},
        {0.0f, "angle"}
    };
    
    defaultPattern.nodes.push_back(rainbowNode);
    setPattern(defaultPattern);
}

void PatternRenderer::clearBuffer(int bufferIndex) {
    if (bufferIndex < 0 || bufferIndex >= NUM_BUFFERS) return;
    
    for (int i = 0; i < DISPLAY_PIXELS; i++) {
        buffers[bufferIndex][i] = CRGB::Black;
    }
}

void PatternRenderer::copyBuffer(int sourceBuffer, int destBuffer) {
    if (sourceBuffer < 0 || sourceBuffer >= NUM_BUFFERS || 
        destBuffer < 0 || destBuffer >= NUM_BUFFERS) return;
    
    for (int i = 0; i < DISPLAY_PIXELS; i++) {
        buffers[destBuffer][i] = buffers[sourceBuffer][i];
    }
}

void PatternRenderer::setPixel(int bufferIndex, int x, int y, CRGB color) {
    if (bufferIndex < 0 || bufferIndex >= NUM_BUFFERS) return;
    if (x < 0 || x >= DISPLAY_WIDTH || y < 0 || y >= DISPLAY_HEIGHT) return;
    
    int index = y * DISPLAY_WIDTH + x;
    buffers[bufferIndex][index] = color;
}

CRGB PatternRenderer::getPixel(int bufferIndex, int x, int y) {
    if (bufferIndex < 0 || bufferIndex >= NUM_BUFFERS) return CRGB::Black;
    if (x < 0 || x >= DISPLAY_WIDTH || y < 0 || y >= DISPLAY_HEIGHT) return CRGB::Black;
    
    int index = y * DISPLAY_WIDTH + x;
    return buffers[bufferIndex][index];
}

float PatternRenderer::getParameterValue(const std::vector<OperatorParameter>& params, const String& name, float defaultValue) {
    for (const auto& param : params) {
        if (param.name == name) {
            return param.value;
        }
    }
    return defaultValue;
}

bool PatternRenderer::loadPatternFromMessagePack(const uint8_t* data, size_t size) {
    Serial.println("Parsing MessagePack pattern...");
    
    mpack_reader_t reader;
    mpack_reader_init_data(&reader, (const char*)data, size);
    
    Pattern newPattern;
    newPattern.name = "Received Pattern";
    
    // Read root map
    uint32_t rootMapCount = mpack_expect_map(&reader);
    if (mpack_reader_error(&reader) != mpack_ok) {
        Serial.printf("Failed to read root map: %s\n", mpack_error_to_string(mpack_reader_error(&reader)));
        mpack_reader_destroy(&reader);
        return false;
    }
    
    for (uint32_t i = 0; i < rootMapCount; i++) {
        char key[32];
        mpack_expect_cstr(&reader, key, sizeof(key));

        
        if (strcmp(key, "nodes") == 0) {
            // Parse nodes array
            uint32_t nodeCount = mpack_expect_array(&reader);
            if (mpack_reader_error(&reader) != mpack_ok) {
                Serial.printf("Failed to read nodes array: %s\n", mpack_error_to_string(mpack_reader_error(&reader)));
                continue;
            }
            
            for (uint32_t j = 0; j < nodeCount; j++) {
                PatternNode node;
                
                // Each node is a map
                uint32_t nodeMapCount = mpack_expect_map(&reader);
                if (mpack_reader_error(&reader) != mpack_ok) continue;
                
                for (uint32_t k = 0; k < nodeMapCount; k++) {
                    char nodeKey[16];
                    mpack_expect_cstr(&reader, nodeKey, sizeof(nodeKey));
                    
                    if (strcmp(nodeKey, "t") == 0) {
                        // Node type
                        char typeStr[32];
                        mpack_expect_cstr(&reader, typeStr, sizeof(typeStr));
                        node.type = parseOperatorType(String(typeStr));
                    } else if (strcmp(nodeKey, "o") == 0) {
                        // Output buffer (already 0-based from web app)
                        uint32_t nodeOutputValue = mpack_expect_u32(&reader);
                        node.outputBuffer = nodeOutputValue;

                    } else if (strcmp(nodeKey, "i") == 0) {
                        // Input buffer (already 0-based from web app, -1 means no input)
                        node.inputBuffer = mpack_expect_i32(&reader);
                    } else if (strcmp(nodeKey, "i2") == 0) {
                        // Second input buffer (already 0-based from web app, -1 means no input)
                        node.secondInputBuffer = mpack_expect_i32(&reader);
                    } else if (strcmp(nodeKey, "p") == 0) {
                        // Parameters map
                        uint32_t paramCount = mpack_expect_map(&reader);
                        if (mpack_reader_error(&reader) == mpack_ok) {
                            for (uint32_t p = 0; p < paramCount; p++) {
                                char paramName[32];
                                mpack_expect_cstr(&reader, paramName, sizeof(paramName));
                                float value = mpack_expect_float(&reader);
                                
                                if (mpack_reader_error(&reader) == mpack_ok) {
                                    OperatorParameter param;
                                    param.name = String(paramName);
                                    param.value = value;
                                    node.parameters.push_back(param);
                                }
                            }
                        }
                    } else {
                        // Unknown key, skip
                        mpack_discard(&reader);
                    }
                }
                
                newPattern.nodes.push_back(node);
            }
        } else if (strcmp(key, "meta") == 0) {
            // Parse metadata
            uint32_t metaMapCount = mpack_expect_map(&reader);
            if (mpack_reader_error(&reader) != mpack_ok) {
                continue;
            }
            
            for (uint32_t j = 0; j < metaMapCount; j++) {
                char metaKey[32];
                mpack_expect_cstr(&reader, metaKey, sizeof(metaKey));
                
                if (strcmp(metaKey, "output") == 0) {
                    // Output buffer (already 0-based from web app)
                    uint32_t outputValue = mpack_expect_u32(&reader);
                    newPattern.outputBuffer = outputValue;

                } else if (strcmp(metaKey, "name") == 0) {
                    char nameStr[64];
                    mpack_expect_cstr(&reader, nameStr, sizeof(nameStr));
                    newPattern.name = String(nameStr);
                } else {
                    mpack_discard(&reader);
                }
            }
        } else {
            // Unknown key, skip
            mpack_discard(&reader);
        }
    }
    
    mpack_reader_destroy(&reader);
    
    if (newPattern.nodes.empty()) {
        Serial.println("No valid nodes found in pattern");
        return false;
    }
    
    Serial.printf("Loaded pattern '%s' with %d nodes, output buffer %d\n", 
                  newPattern.name.c_str(), newPattern.nodes.size(), newPattern.outputBuffer);
    
    setPattern(newPattern);
    return true;
}

void PatternRenderer::setPattern(const Pattern& pattern) {
    currentPattern = pattern;
    Serial.printf("Set pattern: %s with %d nodes\n", pattern.name.c_str(), pattern.nodes.size());
}

void PatternRenderer::update() {
    frameStartTime = millis();
    uint32_t deltaTime = frameStartTime - lastFrameTime;
    if (deltaTime > 100) deltaTime = 100; // Cap delta to prevent huge jumps
    
    globalTime += deltaTime;
    lastFrameTime = frameStartTime;
    
    // Execute all nodes in order
    for (const auto& node : currentPattern.nodes) {
        
        switch (node.type) {
            case ESP32OperatorType::BLEND:
                executeBlendOperator(node);
                break;
            case ESP32OperatorType::CHASE:
                executeChaseOperator(node);
                break;
            case ESP32OperatorType::FADE:
                executeFadeOperator(node);
                break;
            case ESP32OperatorType::GRADIENT:
                executeGradientOperator(node);
                break;
            case ESP32OperatorType::MOVING_BLOB:
                executeMovingBlobOperator(node);
                break;
            case ESP32OperatorType::PERLIN_NOISE:
                executePerlinNoiseOperator(node);
                break;
            case ESP32OperatorType::RAINBOW:
                executeRainbowOperator(node);
                break;
            case ESP32OperatorType::RAINDROPS:
                executeRaindropsOperator(node);
                break;
            case ESP32OperatorType::SPARKLE:
                executeSparkleOperator(node);
                break;
            case ESP32OperatorType::STROBE:
                executeStrobeOperator(node);
                break;
        }
    }
}

void PatternRenderer::render() {
    if (!ledManager || ledManager->getNumStrips() == 0) return;
    
    // Get the output buffer (already converted to 0-based indexing during parsing)
    int outputBufferIndex = currentPattern.outputBuffer;
    if (outputBufferIndex < 0 || outputBufferIndex >= NUM_BUFFERS) {
        Serial.printf("Invalid output buffer index %d, using buffer 0\n", outputBufferIndex);
        outputBufferIndex = 0;
    }
    
    const CRGB* outputBuffer = buffers[outputBufferIndex];
    

    
    // Map 2D buffer to LED strip using row-major order
    LedConfig::LedBus* strip = ledManager->getStrip(0);
    if (strip) {
        int ledCount = min((int)strip->getLength(), DISPLAY_PIXELS);
        for (int i = 0; i < ledCount; i++) {
            // Use the correct LED manager interface: setPixelColor(stripIndex, pixelIndex, color)
            ledManager->setPixelColor(0, i, outputBuffer[i]);
        }
        ledManager->show();
    }
}

const CRGB* PatternRenderer::getBuffer(int bufferIndex) const {
    if (bufferIndex < 0 || bufferIndex >= NUM_BUFFERS) return nullptr;
    return buffers[bufferIndex];
}

// Operator implementations
void PatternRenderer::executeRainbowOperator(const PatternNode& node) {
    float speed = getParameterValue(node.parameters, "speed", 120.0f);
    float saturation = getParameterValue(node.parameters, "saturation", 255.0f);
    float value = getParameterValue(node.parameters, "value", 255.0f);
    float angle = getParameterValue(node.parameters, "angle", 0.0f);
    
    uint8_t hue_offset = beat8_esp32((uint16_t)(speed * 20.0f));
    float angle_rad = angle * M_PI / 180.0f;
    float cos_angle = cos(angle_rad);
    
    for (int y = 0; y < DISPLAY_HEIGHT; y++) {
        for (int x = 0; x < DISPLAY_WIDTH; x++) {
            float norm_x = (float)x / (DISPLAY_WIDTH - 1);
            float centered_x = norm_x - 0.5f;
            float rotated_x = centered_x * cos_angle;
            
            uint8_t base_hue = (uint8_t)((rotated_x + 0.5f) * 255.0f);
            uint8_t final_hue = base_hue + hue_offset;
            
            CHSV hsv_color(final_hue, (uint8_t)saturation, (uint8_t)value);
            setPixel(node.outputBuffer, x, y, hsv_color);
        }
    }
}

void PatternRenderer::executeBlendOperator(const PatternNode& node) {
    float opacity = getParameterValue(node.parameters, "opacity", 0.5f);
    int blend_mode = (int)getParameterValue(node.parameters, "blend_mode", 0.0f);
    
    if (node.inputBuffer < 0 || node.secondInputBuffer < 0) {
        // Clear output if we don't have both inputs
        clearBuffer(node.outputBuffer);
        return;
    }
    
    for (int y = 0; y < DISPLAY_HEIGHT; y++) {
        for (int x = 0; x < DISPLAY_WIDTH; x++) {
            CRGB color1 = getPixel(node.inputBuffer, x, y);
            CRGB color2 = getPixel(node.secondInputBuffer, x, y);
            
            CRGB result;
            switch (blend_mode) {
                case 1: // Add
                    result.r = qadd8_esp32(color1.r, (uint8_t)(color2.r * opacity));
                    result.g = qadd8_esp32(color1.g, (uint8_t)(color2.g * opacity));
                    result.b = qadd8_esp32(color1.b, (uint8_t)(color2.b * opacity));
                    break;
                default: // Normal blend
                    result.r = (uint8_t)(color1.r * (1.0f - opacity) + color2.r * opacity);
                    result.g = (uint8_t)(color1.g * (1.0f - opacity) + color2.g * opacity);
                    result.b = (uint8_t)(color1.b * (1.0f - opacity) + color2.b * opacity);
                    break;
            }
            
            setPixel(node.outputBuffer, x, y, result);
        }
    }
}

void PatternRenderer::executeChaseOperator(const PatternNode& node) {
    float speed = getParameterValue(node.parameters, "speed", 20.0f);
    float size = getParameterValue(node.parameters, "size", 4.0f);
    float hue = getParameterValue(node.parameters, "hue", 0.0f);
    float saturation = getParameterValue(node.parameters, "saturation", 0.0f);
    float value = getParameterValue(node.parameters, "value", 255.0f);
    
    clearBuffer(node.outputBuffer);
    
    float position = (globalTime * speed / 1000.0f);
    position = fmod(position, DISPLAY_WIDTH + size);
    
    for (int x = 0; x < DISPLAY_WIDTH; x++) {
        float distance = abs(x - position);
        if (distance < size / 2.0f) {
            float brightness = (1.0f - distance / (size / 2.0f)) * value;
            CHSV color((uint8_t)hue, (uint8_t)saturation, (uint8_t)brightness);
            
            for (int y = 0; y < DISPLAY_HEIGHT; y++) {
                setPixel(node.outputBuffer, x, y, color);
            }
        }
    }
}

void PatternRenderer::executeFadeOperator(const PatternNode& node) {
    float speed = getParameterValue(node.parameters, "speed", 1.0f);
    float hue = getParameterValue(node.parameters, "hue", 30.0f);
    float saturation = getParameterValue(node.parameters, "saturation", 255.0f);
    float maxValue = getParameterValue(node.parameters, "value", 255.0f);
    
    uint8_t brightness = (uint8_t)(sin8_esp32((uint8_t)(globalTime * speed / 10.0f)) * maxValue / 255.0f);
    CHSV color((uint8_t)hue, (uint8_t)saturation, brightness);
    
    for (int y = 0; y < DISPLAY_HEIGHT; y++) {
        for (int x = 0; x < DISPLAY_WIDTH; x++) {
            setPixel(node.outputBuffer, x, y, color);
        }
    }
}

void PatternRenderer::executeGradientOperator(const PatternNode& node) {
    float angle = getParameterValue(node.parameters, "angle", 0.0f);
    float start_hue = getParameterValue(node.parameters, "start_hue", 0.0f);
    float end_hue = getParameterValue(node.parameters, "end_hue", 255.0f);
    float saturation = getParameterValue(node.parameters, "saturation", 255.0f);
    float value = getParameterValue(node.parameters, "value", 255.0f);
    
    float angle_rad = angle * M_PI / 180.0f;
    float cos_angle = cos(angle_rad);
    float sin_angle = sin(angle_rad);
    
    for (int y = 0; y < DISPLAY_HEIGHT; y++) {
        for (int x = 0; x < DISPLAY_WIDTH; x++) {
            float norm_x = (float)x / (DISPLAY_WIDTH - 1) - 0.5f;
            float norm_y = (float)y / (DISPLAY_HEIGHT - 1) - 0.5f;
            
            float rotated_x = norm_x * cos_angle - norm_y * sin_angle;
            float gradient_pos = (rotated_x + 0.5f);
            gradient_pos = max(0.0f, min(1.0f, gradient_pos));
            
            float hue_val = start_hue + (end_hue - start_hue) * gradient_pos;
            CHSV color((uint8_t)hue_val, (uint8_t)saturation, (uint8_t)value);
            
            setPixel(node.outputBuffer, x, y, color);
        }
    }
}

void PatternRenderer::executeMovingBlobOperator(const PatternNode& node) {
    float speed = getParameterValue(node.parameters, "speed", 30.0f);
    float blob_size = getParameterValue(node.parameters, "blob_size", 0.3f);
    float hue = getParameterValue(node.parameters, "hue", 0.0f);
    float saturation = getParameterValue(node.parameters, "saturation", 255.0f);
    float value = getParameterValue(node.parameters, "value", 255.0f);
    
    clearBuffer(node.outputBuffer);
    
    float time = globalTime * speed / 1000.0f;
    float blob_x = (sin(time * 0.7f) + 1.0f) * DISPLAY_WIDTH / 2.0f;
    float blob_y = (cos(time * 0.5f) + 1.0f) * DISPLAY_HEIGHT / 2.0f;
    float radius = blob_size * min(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    
    for (int y = 0; y < DISPLAY_HEIGHT; y++) {
        for (int x = 0; x < DISPLAY_WIDTH; x++) {
            float dx = x - blob_x;
            float dy = y - blob_y;
            float distance = sqrt(dx * dx + dy * dy);
            
            if (distance < radius) {
                float brightness = (1.0f - distance / radius) * value;
                CHSV color((uint8_t)hue, (uint8_t)saturation, (uint8_t)brightness);
                setPixel(node.outputBuffer, x, y, color);
            }
        }
    }
}

void PatternRenderer::executePerlinNoiseOperator(const PatternNode& node) {
    float scale = getParameterValue(node.parameters, "scale", 4.0f);
    float speed = getParameterValue(node.parameters, "speed", 50.0f);
    float hue_base = getParameterValue(node.parameters, "hue_base", 0.0f);
    float hue_range = getParameterValue(node.parameters, "hue_range", 60.0f);
    float saturation = getParameterValue(node.parameters, "saturation", 255.0f);
    float value = getParameterValue(node.parameters, "value", 255.0f);
    
    uint16_t time_offset = (uint16_t)(globalTime * speed / 100.0f);
    
    for (int y = 0; y < DISPLAY_HEIGHT; y++) {
        for (int x = 0; x < DISPLAY_WIDTH; x++) {
            uint16_t noise_x = (uint16_t)(x * scale * 256 / DISPLAY_WIDTH);
            uint16_t noise_y = (uint16_t)(y * scale * 256 / DISPLAY_HEIGHT);
            
            uint8_t noise_val = inoise8_esp32(noise_x, noise_y, time_offset);
            float hue_val = hue_base + (hue_range * noise_val / 255.0f);
            
            CHSV color((uint8_t)hue_val, (uint8_t)saturation, (uint8_t)value);
            setPixel(node.outputBuffer, x, y, color);
        }
    }
}

void PatternRenderer::executeRaindropsOperator(const PatternNode& node) {
    float speed = getParameterValue(node.parameters, "speed", 50.0f);
    float count = getParameterValue(node.parameters, "count", 8.0f);
    float size = getParameterValue(node.parameters, "size", 0.025f);
    float hue = getParameterValue(node.parameters, "hue", 0.0f);
    float saturation = getParameterValue(node.parameters, "saturation", 0.0f);
    float value = getParameterValue(node.parameters, "value", 255.0f);
    
    clearBuffer(node.outputBuffer);
    
    int drop_count = (int)count;
    for (int i = 0; i < drop_count; i++) {
        float time_offset = globalTime * speed / 1000.0f + i * 2.0f;
        float drop_y = fmod(time_offset, DISPLAY_HEIGHT + 2.0f) - 1.0f;
        float drop_x = (sin(i * 1.3f) + 1.0f) * DISPLAY_WIDTH / 2.0f;
        
        if (drop_y >= 0 && drop_y < DISPLAY_HEIGHT) {
            int px = (int)drop_x;
            int py = (int)drop_y;
            
            if (px >= 0 && px < DISPLAY_WIDTH && py >= 0 && py < DISPLAY_HEIGHT) {
                CHSV color((uint8_t)hue, (uint8_t)saturation, (uint8_t)value);
                setPixel(node.outputBuffer, px, py, color);
            }
        }
    }
}

void PatternRenderer::executeSparkleOperator(const PatternNode& node) {
    float density = getParameterValue(node.parameters, "density", 0.1f);
    float fade_rate = getParameterValue(node.parameters, "fade_rate", 0.95f);
    float hue = getParameterValue(node.parameters, "hue", 255.0f);
    float saturation = getParameterValue(node.parameters, "saturation", 255.0f);
    float value = getParameterValue(node.parameters, "value", 255.0f);
    
    // Fade existing pixels
    for (int y = 0; y < DISPLAY_HEIGHT; y++) {
        for (int x = 0; x < DISPLAY_WIDTH; x++) {
            CRGB current = getPixel(node.outputBuffer, x, y);
            current.r = (uint8_t)(current.r * fade_rate);
            current.g = (uint8_t)(current.g * fade_rate);
            current.b = (uint8_t)(current.b * fade_rate);
            setPixel(node.outputBuffer, x, y, current);
        }
    }
    
    // Add new sparkles
    int sparkle_count = (int)(density * DISPLAY_PIXELS);
    for (int i = 0; i < sparkle_count; i++) {
        if (random8_esp32() < 64) { // Random chance
            int x = random8_esp32(DISPLAY_WIDTH);
            int y = random8_esp32(DISPLAY_HEIGHT);
            CHSV color((uint8_t)hue, (uint8_t)saturation, (uint8_t)value);
            setPixel(node.outputBuffer, x, y, color);
        }
    }
}

void PatternRenderer::executeStrobeOperator(const PatternNode& node) {
    float rate = getParameterValue(node.parameters, "rate", 2.0f);
    float duty_cycle = getParameterValue(node.parameters, "duty_cycle", 0.1f);
    float hue = getParameterValue(node.parameters, "hue", 0.0f);
    float saturation = getParameterValue(node.parameters, "saturation", 0.0f);
    float value = getParameterValue(node.parameters, "value", 255.0f);
    
    float period = 1000.0f / rate; // Period in milliseconds
    float cycle_pos = fmod(globalTime, period) / period;
    
    CRGB color = (cycle_pos < duty_cycle) ? 
                 CRGB(CHSV((uint8_t)hue, (uint8_t)saturation, (uint8_t)value)) : 
                 CRGB::Black;
    
    for (int y = 0; y < DISPLAY_HEIGHT; y++) {
        for (int x = 0; x < DISPLAY_WIDTH; x++) {
            setPixel(node.outputBuffer, x, y, color);
        }
    }
} 