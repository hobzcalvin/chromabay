#include "fastled_patterns.h"
#include <emscripten.h>
#include <cstring>
#include <cstdlib>

static PatternContext* g_context = nullptr;

extern "C" {

EMSCRIPTEN_KEEPALIVE
PatternContext* create_context(uint32_t width, uint32_t height) {
    PatternContext* ctx = (PatternContext*)malloc(sizeof(PatternContext));
    if (!ctx) return nullptr;
    
    // Allocate 2D color buffer
    uint32_t total_pixels = width * height;
    ctx->color_buffer = (CRGB*)malloc(total_pixels * sizeof(CRGB));
    if (!ctx->color_buffer) {
        free(ctx);
        return nullptr;
    }
    
    // Initialize context
    ctx->input_buffer1 = nullptr;
    ctx->input_buffer2 = nullptr;
    ctx->width = width;
    ctx->height = height;
    ctx->timestamp_ms = 0;
    ctx->delta_time_ms = 0;
    ctx->is_starting = true;
    ctx->is_ending = false;
    ctx->parameters = nullptr;
    ctx->param_count = 0;
    
    // Clear the buffer to black
    clear_buffer(ctx, CRGB(0, 0, 0));
    
    g_context = ctx;
    return ctx;
}

EMSCRIPTEN_KEEPALIVE
void destroy_context(PatternContext* ctx) {
    if (!ctx) return;
    
    if (ctx->color_buffer) {
        free(ctx->color_buffer);
    }
    if (ctx->input_buffer1) {
        free(ctx->input_buffer1);
    }
    if (ctx->input_buffer2) {
        free(ctx->input_buffer2);
    }
    if (ctx->parameters) {
        free(ctx->parameters);
    }
    
    free(ctx);
    
    if (g_context == ctx) {
        g_context = nullptr;
    }
}

EMSCRIPTEN_KEEPALIVE
void set_timing(PatternContext* ctx, uint32_t timestamp_ms, uint32_t delta_time_ms) {
    if (!ctx) return;
    ctx->timestamp_ms = timestamp_ms;
    ctx->delta_time_ms = delta_time_ms;
    ctx->is_starting = false; // Clear starting flag after first timing update
}

EMSCRIPTEN_KEEPALIVE
void set_parameters(PatternContext* ctx, float* params, uint32_t param_count) {
    if (!ctx) return;
    
    // Free existing parameters
    if (ctx->parameters) {
        free(ctx->parameters);
        ctx->parameters = nullptr;
        ctx->param_count = 0;
    }
    
    if (params && param_count > 0) {
        // Allocate new parameter array
        ctx->parameters = (float*)malloc(param_count * sizeof(float));
        if (ctx->parameters) {
            memcpy(ctx->parameters, params, param_count * sizeof(float));
            ctx->param_count = param_count;
        }
    }
}

EMSCRIPTEN_KEEPALIVE
uint8_t* get_output_buffer(PatternContext* ctx) {
    if (!ctx || !ctx->color_buffer) return nullptr;
    
    // Return pointer to the raw RGB data
    return (uint8_t*)ctx->color_buffer;
}

EMSCRIPTEN_KEEPALIVE
uint32_t get_buffer_size(PatternContext* ctx) {
    if (!ctx) return 0;
    return ctx->width * ctx->height * 3; // 3 bytes per pixel (RGB)
}

EMSCRIPTEN_KEEPALIVE
void call_rainbow_pattern(PatternContext* ctx) {
    if (!ctx) return;
    rainbow_pattern(ctx);
}

} // extern "C" 