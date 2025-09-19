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
        float speed = getFloat(parameters, 0, 0.5f);
        float red_size = getFloat(parameters, 1, 0.3f);
        float green_size = getFloat(parameters, 2, 0.3f);
        float blue_size = getFloat(parameters, 3, 0.3f);
        
        uint32_t totalPixels = width * height;
        
        // Clear the buffer
        for (uint32_t i = 0; i < totalPixels; i++) {
            outputBuffer[i] = CRGB::Black;
        }
        
        // Time factor for Perlin noise animation (speed now 0-10 range)
        uint16_t time_factor = (uint16_t)(timestampMs * speed * 250.0f);
        
        // Store blob sizes and colors
        float blob_sizes[3] = { red_size, green_size, blue_size };
        CRGB blob_colors[3] = { CRGB::Red, CRGB::Green, CRGB::Blue };
        
        // Create RGB blobs
        const int num_blobs = 3;
        for (int blob = 0; blob < num_blobs; blob++) {
            // Skip blob if size is 0 (no blob)
            if (blob_sizes[blob] <= 0.0f) continue;
            // Use Perlin noise to create organic movement for each blob
            // Each blob has different noise coordinates to move independently
            uint16_t blob_noise_base = blob * 10000; // Separate noise space for each blob
            
            // Give each blob independent time progression
            float time_scale = 1.0f + (blob * 0.3f); // Each blob moves at slightly different speed
            uint16_t blob_time_offset = blob * 20000; // Each blob starts at different time offset
            uint16_t blob_time_factor = blob_time_offset + (uint16_t)(time_factor * time_scale);
            
            // Generate X position using Perlin noise (3x range: -1.0 to 2.0)
            // Use inoise16 for much higher precision (65536 values vs 256)
            uint16_t noise_x = inoise16(blob_noise_base, blob_time_factor, 0);
            float blob_x_raw = -1.0f + 3.0f * ((float)noise_x / 65535.0f);
            
            // Generate Y position using Perlin noise (3x range: -1.0 to 2.0)
            // Use inoise16 for much higher precision (65536 values vs 256)
            uint16_t noise_y = inoise16(blob_noise_base, blob_time_factor, 10000);
            float blob_y_raw = -1.0f + 3.0f * ((float)noise_y / 65535.0f);
            
            // Calculate blob size based on parameter (1.0 = full display coverage)
            float current_blob_size = blob_sizes[blob];
            // Convert to radius: size 1.0 should cover roughly entire display diagonal
            float blob_radius = current_blob_size * 3.0f; // 0.7 gives good full coverage at 1.0
            
            // Loop through all pixels
            for (uint32_t y = 0; y < height; y++) {
                for (uint32_t x = 0; x < width; x++) {
                    uint32_t index = y * width + x;
                    
                    // Get normalized coordinates
                    float norm_x = (float)x / (float)width;
                    float norm_y = (float)y / (float)height;
                    
                    // Calculate distance from blob center considering wrapping
                    // We need to check the blob at multiple virtual positions due to wrapping
                    float min_distance = 999999.0f; // Start with a large value
                    
                    // Check blob at various wrapped positions (-1, 0, +1 offsets for both x and y)
                    for (int wrap_x = -1; wrap_x <= 1; wrap_x++) {
                        for (int wrap_y = -1; wrap_y <= 1; wrap_y++) {
                            float virtual_blob_x = blob_x_raw + wrap_x;
                            float virtual_blob_y = blob_y_raw + wrap_y;
                            
                            float dx = norm_x - virtual_blob_x;
                            float dy = norm_y - virtual_blob_y;
                            float distance = sqrt(dx * dx + dy * dy);
                            
                            if (distance < min_distance) {
                                min_distance = distance;
                            }
                        }
                    }
                    
                    float distance = min_distance;
                    
                    // Calculate intensity based on distance and blob radius (soft falloff)
                    float intensity = 1.0f - (distance / blob_radius);
                    intensity = fmax(0.0f, intensity);
                    //intensity = intensity * intensity; // Quadratic falloff for smoother edges
                    
                    if (intensity > 0.0f) {
                        // Get existing pixel color
                        CRGB existing_color = outputBuffer[index];
                        
                        // Create new blob color using the RGB color with intensity
                        CRGB base_color = blob_colors[blob];
                        CRGB blob_color = CRGB(
                            (uint8_t)(base_color.r * intensity),
                            (uint8_t)(base_color.g * intensity),
                            (uint8_t)(base_color.b * intensity)
                        );
                        
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
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 0.5f, 0.0f, 1.0f),
            ParameterInfo("red_size", "Red Blob Size", ParameterInfo::FLOAT, 0.3f, 0.0f, 1.0f),
            ParameterInfo("green_size", "Green Blob Size", ParameterInfo::FLOAT, 0.3f, 0.0f, 1.0f),
            ParameterInfo("blue_size", "Blue Blob Size", ParameterInfo::FLOAT, 0.3f, 0.0f, 1.0f)
        };
    }
};

REGISTER_OPERATOR(MovingBlobOperator); 