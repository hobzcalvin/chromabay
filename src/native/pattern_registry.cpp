#include "fastled_patterns.h"

// Pattern parameter definitions
static const PatternParameter rainbow_params[] = {
    {"speed", "Speed", "float", 50.0f, 0.0f, 200.0f, nullptr, 0},
    {"saturation", "Saturation", "float", 255.0f, 0.0f, 255.0f, nullptr, 0},
    {"value", "Value", "float", 255.0f, 0.0f, 255.0f, nullptr, 0},
    {"angle", "Angle", "float", 0.0f, 0.0f, 360.0f, nullptr, 0}
};

static const PatternParameter gradient_params[] = {
    {"angle", "Angle", "float", 0.0f, 0.0f, 360.0f, nullptr, 0},
    {"start_hue", "Start Hue", "float", 0.0f, 0.0f, 255.0f, nullptr, 0},
    {"end_hue", "End Hue", "float", 255.0f, 0.0f, 255.0f, nullptr, 0},
    {"saturation", "Saturation", "float", 255.0f, 0.0f, 255.0f, nullptr, 0},
    {"value", "Value", "float", 255.0f, 0.0f, 255.0f, nullptr, 0}
};

static const PatternParameter moving_blob_params[] = {
    {"speed", "Speed", "float", 30.0f, 0.0f, 100.0f, nullptr, 0},
    {"blob_size", "Blob Size", "float", 0.3f, 0.1f, 1.0f, nullptr, 0},
    {"hue", "Hue", "float", 0.0f, 0.0f, 255.0f, nullptr, 0},
    {"saturation", "Saturation", "float", 255.0f, 0.0f, 255.0f, nullptr, 0},
    {"value", "Value", "float", 255.0f, 0.0f, 255.0f, nullptr, 0}
};

static const PatternParameter sparkle_params[] = {
    {"density", "Density", "float", 0.1f, 0.0f, 1.0f, nullptr, 0},
    {"fade_rate", "Fade Rate", "float", 0.95f, 0.5f, 0.99f, nullptr, 0},
    {"hue", "Hue", "float", 255.0f, 0.0f, 255.0f, nullptr, 0}, // 255 = random
    {"saturation", "Saturation", "float", 255.0f, 0.0f, 255.0f, nullptr, 0},
    {"value", "Value", "float", 255.0f, 0.0f, 255.0f, nullptr, 0}
};

static const PatternParameter strobe_params[] = {
    {"rate", "Rate (Hz)", "float", 2.0f, 0.1f, 20.0f, nullptr, 0},
    {"duty_cycle", "Duty Cycle", "float", 0.1f, 0.01f, 0.9f, nullptr, 0},
    {"hue", "Hue", "float", 0.0f, 0.0f, 255.0f, nullptr, 0},
    {"saturation", "Saturation", "float", 0.0f, 0.0f, 255.0f, nullptr, 0}, // 0 = white
    {"value", "Value", "float", 255.0f, 0.0f, 255.0f, nullptr, 0}
};

static const PatternParameter perlin_noise_params[] = {
    {"scale", "Scale", "float", 4.0f, 1.0f, 20.0f, nullptr, 0},
    {"speed", "Speed", "float", 50.0f, 0.0f, 200.0f, nullptr, 0},
    {"hue_base", "Base Hue", "float", 0.0f, 0.0f, 255.0f, nullptr, 0},
    {"hue_range", "Hue Range", "float", 60.0f, 0.0f, 255.0f, nullptr, 0},
    {"saturation", "Saturation", "float", 255.0f, 0.0f, 255.0f, nullptr, 0},
    {"value", "Value", "float", 255.0f, 0.0f, 255.0f, nullptr, 0}
};

// Pattern registry
const PatternDefinition PATTERN_DEFINITIONS[] = {
    {"Rainbow", "rainbow", rainbow_params, 4, rainbow_pattern},
    {"Gradient", "gradient", gradient_params, 5, gradient_pattern},
    {"Moving Blob", "moving_blob", moving_blob_params, 5, moving_blob_pattern},
    {"Sparkle", "sparkle", sparkle_params, 5, sparkle_pattern},
    {"Strobe", "strobe", strobe_params, 5, strobe_pattern},
    {"Perlin Noise", "perlin_noise", perlin_noise_params, 6, perlin_noise_pattern}
};

const uint32_t PATTERN_COUNT = sizeof(PATTERN_DEFINITIONS) / sizeof(PatternDefinition); 