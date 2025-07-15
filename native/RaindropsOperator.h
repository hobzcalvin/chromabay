#pragma once

#include "BaseOperator.h"
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Raindrops operator - creates animated falling raindrops
class RaindropsOperator : public BaseOperator {
public:
    void render(
        CRGB* inputBuffer1,
        CRGB* /* inputBuffer2 */,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t timestampMs,
        uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        float speed = getFloat(parameters, 0, 50.0f);
        float count = getFloat(parameters, 1, 8.0f);
        float size = getFloat(parameters, 2, 0.025f);
        float hue = getFloat(parameters, 3, 0.0f);
        float saturation = getFloat(parameters, 4, 0.0f); // 0 = white
        float value = getFloat(parameters, 5, 255.0f);
        
        uint32_t totalPixels = width * height;
        
        // Start with input buffer if available, otherwise clear to black
        if (inputBuffer1) {
            // Copy input buffer to output as base
            for (uint32_t i = 0; i < totalPixels; i++) {
                outputBuffer[i] = inputBuffer1[i];
            }
        } else {
            // Clear the buffer if no input
            for (uint32_t i = 0; i < totalPixels; i++) {
                outputBuffer[i] = CRGB::Black;
            }
        }
        
        // Calculate drop count based on width
        int dropCount = (int)count;
        if (dropCount < 1) dropCount = 1;
        
        // Create raindrops
        for (int i = 0; i < dropCount; i++) {
            // Calculate drop position
            float dropSpacing = (float)width / (float)dropCount;
            float baseX = i * dropSpacing + dropSpacing * 0.5f;
            
            // Animate Y position based on time and speed
            float timeOffset = timestampMs * speed * 0.001f; // Convert to seconds and scale
            // Use normalized speed (0-1.2 coordinate system) instead of height-dependent
            float normalizedSpeed = speed / 100.0f; // Speed parameter now represents % of height per second
            float normalizedY = fmod(timeOffset * normalizedSpeed + i * 0.1f, 1.2f) - 0.2f;
            float y = normalizedY * (float)height;
            
            // Only draw if raindrop is visible
            if (y >= 0.0f && y <= (float)height) {
                // Calculate drop dimensions
                float dropWidth = fmax(1.0f, width * size);
                float dropHeight = fmax(1.0f, height * 0.08f); // Fixed aspect ratio with 1-pixel minimum
                
                // Create raindrop color
                CHSV drop_hsv((uint8_t)hue, (uint8_t)saturation, (uint8_t)value);
                CRGB drop_color = drop_hsv;
                
                // Draw elliptical raindrop
                int centerX = (int)baseX;
                int centerY = (int)y;
                int radiusX = (int)fmax(1.0f, dropWidth * 0.5f);
                int radiusY = (int)fmax(1.0f, dropHeight * 0.5f);
                
                // Draw filled ellipse
                for (int dy = -radiusY; dy <= radiusY; dy++) {
                    for (int dx = -radiusX; dx <= radiusX; dx++) {
                        // Check if point is inside ellipse
                        float ellipseTest = ((float)(dx * dx) / (float)(radiusX * radiusX)) + 
                                           ((float)(dy * dy) / (float)(radiusY * radiusY));
                        
                        if (ellipseTest <= 1.0f) {
                            int pixelX = centerX + dx;
                            int pixelY = centerY + dy;
                            
                            // Bounds check
                            if (pixelX >= 0 && pixelX < (int)width && 
                                pixelY >= 0 && pixelY < (int)height) {
                                uint32_t index = pixelY * width + pixelX;
                                outputBuffer[index] = drop_color;
                            }
                        }
                    }
                }
            }
        }
    }
    
    const char* getName() const override {
        return "raindrops";
    }

    const char* getDisplayName() const override {
        return "Raindrops";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed (%/sec)", ParameterInfo::FLOAT, 50.0f, 10.0f, 200.0f),
            ParameterInfo("count", "Count", ParameterInfo::FLOAT, 8.0f, 2.0f, 32.0f),
            ParameterInfo("size", "Size (% width)", ParameterInfo::FLOAT, 0.025f, 0.01f, 0.1f),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("value", "Value", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f)
        };
    }
};

REGISTER_OPERATOR(RaindropsOperator); 