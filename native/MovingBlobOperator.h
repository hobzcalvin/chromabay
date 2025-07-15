#pragma once

#include "BaseOperator.h"
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// Moving Blob operator - creates multiple moving circular blobs
class MovingBlobOperator : public BaseOperator {
public:
    void render(
        CRGB* /* inputBuffer1 */,
        CRGB* /* inputBuffer2 */,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t timestampMs,
        uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        float speed = getFloat(parameters, 0, 30.0f);
        float blob_size = getFloat(parameters, 1, 0.3f);
        float hue = getFloat(parameters, 2, 0.0f);
        float saturation = getFloat(parameters, 3, 255.0f);
        float value = getFloat(parameters, 4, 255.0f);
        
        uint32_t totalPixels = width * height;
        
        // Clear the buffer
        for (uint32_t i = 0; i < totalPixels; i++) {
            outputBuffer[i] = CRGB::Black;
        }
        
        // Calculate blob positions based on time
        float time_offset = (timestampMs * speed / 1000.0f) * 2.0f * M_PI / 65535.0f;
        
        // Ensure minimum blob size of 1 pixel in normalized coordinates
        float min_size = fmax(1.0f / (float)fmin(width, height), blob_size);
        
        // Create multiple blobs
        const int num_blobs = 3;
        for (int blob = 0; blob < num_blobs; blob++) {
            // Each blob follows a different circular path
            float blob_angle = time_offset + (blob * 2.0f * M_PI / num_blobs);
            float blob_radius = 0.3f + 0.2f * sin(time_offset * 0.5f + blob);
            
            // Calculate blob center
            float blob_x = 0.5f + blob_radius * cos(blob_angle);
            float blob_y = 0.5f + blob_radius * sin(blob_angle);
            
            // Each blob has a different hue
            float blob_hue = hue + (blob * 85.0f); // 85 = 255/3 for evenly spaced hues
            while (blob_hue > 255.0f) blob_hue -= 255.0f;
            
            // Loop through all pixels
            for (uint32_t y = 0; y < height; y++) {
                for (uint32_t x = 0; x < width; x++) {
                    uint32_t index = y * width + x;
                    
                    // Get normalized coordinates
                    float norm_x = (float)x / (float)width;
                    float norm_y = (float)y / (float)height;
                    
                    // Calculate distance from blob center
                    float dx = norm_x - blob_x;
                    float dy = norm_y - blob_y;
                    float distance = sqrt(dx * dx + dy * dy);
                    
                    // Calculate intensity based on distance (soft falloff)
                    float intensity = 1.0f - (distance / min_size);
                    intensity = fmax(0.0f, intensity);
                    intensity = intensity * intensity; // Quadratic falloff for smoother edges
                    
                    if (intensity > 0.0f) {
                        // Get existing pixel color
                        CRGB existing_color = outputBuffer[index];
                        
                        // Create new blob color
                        CHSV blob_hsv((uint8_t)blob_hue, (uint8_t)saturation, (uint8_t)(value * intensity));
                        CRGB blob_color = blob_hsv;
                        
                        // Blend with existing color (additive)
                        uint16_t new_r = existing_color.r + blob_color.r;
                        uint16_t new_g = existing_color.g + blob_color.g;
                        uint16_t new_b = existing_color.b + blob_color.b;
                        
                        // Clamp to 255
                        outputBuffer[index] = CRGB(
                            (uint8_t)fmin(255, new_r),
                            (uint8_t)fmin(255, new_g),
                            (uint8_t)fmin(255, new_b)
                        );
                    }
                }
            }
        }
    }
    
    const char* getName() const override {
        return "movingblob";
    }

    const char* getDisplayName() const override {
        return "Moving Blobs";
    }
    
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 30.0f, 0.0f, 100.0f),
            ParameterInfo("blob_size", "Blob Size (% display)", ParameterInfo::FLOAT, 0.3f, 0.1f, 1.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("value", "Value", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f)
        };
    }
};

REGISTER_OPERATOR(MovingBlobOperator); 