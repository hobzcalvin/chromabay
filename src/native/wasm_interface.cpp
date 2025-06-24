#include "fastled_patterns.h"
#include <emscripten/emscripten.h>
#include <cstring>
#include <cstdlib>

// Global context for WASM interface
static PatternContext* g_context = nullptr;
static DisplayPoint* g_points = nullptr;
static CRGB* g_color_buffer = nullptr;
static CRGB* g_input_buffer1 = nullptr;
static CRGB* g_input_buffer2 = nullptr;
static float* g_parameters = nullptr;

extern "C" {

// Forward declarations
void destroy_context();

// Create pattern context
EMSCRIPTEN_KEEPALIVE
PatternContext* create_context(uint32_t width, uint32_t height, uint32_t max_params) {
    if (g_context) {
        destroy_context();
    }
    
    uint32_t point_count = width * height;
    
    // Allocate memory
    g_context = new PatternContext();
    g_points = new DisplayPoint[point_count];
    g_color_buffer = new CRGB[point_count];
    g_input_buffer1 = new CRGB[point_count];
    g_input_buffer2 = new CRGB[point_count];
    g_parameters = new float[max_params];
    
    // Initialize display points
    for (uint32_t y = 0; y < height; y++) {
        for (uint32_t x = 0; x < width; x++) {
            uint32_t index = y * width + x;
            g_points[index].x = (float)x / (float)(width - 1);
            g_points[index].y = (float)y / (float)(height - 1);
            g_points[index].index = index;
        }
    }
    
    // Setup context
    g_context->points = g_points;
    g_context->point_count = point_count;
    g_context->color_buffer = g_color_buffer;
    g_context->input_buffer1 = g_input_buffer1;
    g_context->input_buffer2 = g_input_buffer2;
    g_context->timestamp_ms = 0;
    g_context->delta_time_ms = 0;
    g_context->is_starting = false;
    g_context->is_ending = false;
    g_context->aspect_ratio = (float)width / (float)height;
    g_context->parameters = g_parameters;
    g_context->param_count = 0;
    
    // Clear buffers
    memset(g_color_buffer, 0, point_count * sizeof(CRGB));
    memset(g_input_buffer1, 0, point_count * sizeof(CRGB));
    memset(g_input_buffer2, 0, point_count * sizeof(CRGB));
    memset(g_parameters, 0, max_params * sizeof(float));
    
    return g_context;
}

// Destroy pattern context
EMSCRIPTEN_KEEPALIVE
void destroy_context() {
    if (g_context) {
        delete g_context;
        g_context = nullptr;
    }
    if (g_points) {
        delete[] g_points;
        g_points = nullptr;
    }
    if (g_color_buffer) {
        delete[] g_color_buffer;
        g_color_buffer = nullptr;
    }
    if (g_input_buffer1) {
        delete[] g_input_buffer1;
        g_input_buffer1 = nullptr;
    }
    if (g_input_buffer2) {
        delete[] g_input_buffer2;
        g_input_buffer2 = nullptr;
    }
    if (g_parameters) {
        delete[] g_parameters;
        g_parameters = nullptr;
    }
}

// Set timing information
EMSCRIPTEN_KEEPALIVE
void set_timing(uint32_t timestamp_ms, uint32_t delta_time_ms) {
    if (g_context) {
        g_context->timestamp_ms = timestamp_ms;
        g_context->delta_time_ms = delta_time_ms;
    }
}

// Set pattern parameters
EMSCRIPTEN_KEEPALIVE
void set_parameters(float* params, uint32_t param_count) {
    if (g_context && g_parameters) {
        uint32_t count = param_count;
        if (count > 16) count = 16; // Max 16 parameters
        
        memcpy(g_parameters, params, count * sizeof(float));
        g_context->param_count = count;
    }
}

// Set startup/cleanup flags
EMSCRIPTEN_KEEPALIVE
void set_pattern_state(bool is_starting, bool is_ending) {
    if (g_context) {
        g_context->is_starting = is_starting;
        g_context->is_ending = is_ending;
    }
}

// Copy input buffer from JavaScript
EMSCRIPTEN_KEEPALIVE
void set_input_buffer(uint8_t* rgb_data, uint32_t buffer_index, uint32_t size) {
    if (!g_context) return;
    
    CRGB* target_buffer = nullptr;
    if (buffer_index == 1 && g_input_buffer1) {
        target_buffer = g_input_buffer1;
    } else if (buffer_index == 2 && g_input_buffer2) {
        target_buffer = g_input_buffer2;
    }
    
    if (target_buffer && size >= g_context->point_count * 3) {
        for (uint32_t i = 0; i < g_context->point_count; i++) {
            target_buffer[i].r = rgb_data[i * 3];
            target_buffer[i].g = rgb_data[i * 3 + 1];
            target_buffer[i].b = rgb_data[i * 3 + 2];
        }
    }
}

// Get output buffer as RGB data for JavaScript
EMSCRIPTEN_KEEPALIVE
uint8_t* get_output_buffer() {
    if (!g_context || !g_color_buffer) return nullptr;
    
    static uint8_t* rgb_output = nullptr;
    if (rgb_output) {
        free(rgb_output);
    }
    
    rgb_output = (uint8_t*)malloc(g_context->point_count * 3);
    for (uint32_t i = 0; i < g_context->point_count; i++) {
        rgb_output[i * 3] = g_color_buffer[i].r;
        rgb_output[i * 3 + 1] = g_color_buffer[i].g;
        rgb_output[i * 3 + 2] = g_color_buffer[i].b;
    }
    
    return rgb_output;
}

// Generic pattern caller
EMSCRIPTEN_KEEPALIVE
void call_pattern(const char* pattern_name) {
    if (!g_context) return;
    
    if (strcmp(pattern_name, "rainbow") == 0) {
        rainbow_pattern(g_context);
    }
    // Add more patterns here as they're implemented
}

// Direct rainbow pattern call (for testing)
EMSCRIPTEN_KEEPALIVE
void call_rainbow_pattern() {
    if (g_context) {
        rainbow_pattern(g_context);
    }
}

} // extern "C" 