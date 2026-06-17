#pragma once

#include "BaseOperator.h"
#include <cmath>
#include <cstdint>

// Moving Blob operator - three RGB blobs that wander the display with organic,
// pseudo-random motion. Ported from a reference random-walk model: each blob picks a
// random velocity + direction, holds it for a random number of frames, then re-rolls.
// This replaces the old Perlin-noise positioning, which looked mechanical/on-rails.
//
// The blobs wrap toroidally (pop off one edge, reappear on the opposite one).
//
// Motion is intentionally NOT time-synced across devices: state lives in the operator
// instance and the RNG is seeded per-instance, so each device drifts independently
// (the previous version used the shared synced clock, so every device moved alike).
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
        if (width == 0 || height == 0) return;

        float speed = getFloat(parameters, 0, 0.5f);          // 0..1 (was settings.hue)
        float blob_size[3] = {                                 // 0..1 each (was saturation)
            getFloat(parameters, 1, 0.3f),
            getFloat(parameters, 2, 0.3f),
            getFloat(parameters, 3, 0.3f)
        };

        const float fw = (float)width;
        const float fh = (float)height;
        const float maxDim = fw > fh ? fw : fh;

        // Lazy one-time init: blobs start centered; seed the RNG with per-instance
        // entropy so two devices running the same pattern diverge.
        if (!initialized_) {
            for (int c = 0; c < 3; c++) {
                xPos_[c] = fw * 0.5f;
                yPos_[c] = fh * 0.5f;
                steps_[c] = 0;
            }
            rng_ = (uint32_t)((uintptr_t)this) ^ (timestampMs * 2654435761u) ^ 0x9e3779b9u;
            if (rng_ == 0) rng_ = 0xDEADBEEFu;
            initialized_ = true;
        }

        // Per-frame duration in ms, derived from the timestamp (don't trust deltaTimeMs).
        uint32_t dt;
        if (haveLastTs_) {
            dt = (timestampMs >= lastTs_) ? (timestampMs - lastTs_) : 16u;
        } else {
            dt = 16u;
        }
        lastTs_ = timestampMs;
        haveLastTs_ = true;
        if (dt < 1u) dt = 1u;
        if (dt > 100u) dt = 100u; // clamp so a stall doesn't teleport a blob

        // Blob radius in pixels (size 1.0 ~ largest display dimension).
        float size[3] = { blob_size[0] * maxDim, blob_size[1] * maxDim, blob_size[2] * maxDim };

        // --- Render the blobs (per-channel linear falloff, wrapping distance) ---
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                uint8_t rgb[3] = { 0, 0, 0 };
                for (int c = 0; c < 3; c++) {
                    if (size[c] <= 0.0f) continue;
                    float xd = wrapDist((float)x, xPos_[c], fw);
                    float yd = wrapDist((float)y, yPos_[c], fh);
                    float dist = sqrtf(xd * xd + yd * yd);
                    float v = 255.0f * (size[c] - fminf(size[c], dist)) / size[c];
                    if (v < 0.0f) v = 0.0f;
                    else if (v > 255.0f) v = 255.0f;
                    rgb[c] = (uint8_t)v;
                }
                outputBuffer[y * width + x] = CRGB(rgb[0], rgb[1], rgb[2]);
            }
        }

        // Re-roll all segments immediately if the speed changed (apply it live).
        if (speed != lastSpeed_) {
            for (int c = 0; c < 3; c++) steps_[c] = 0;
            lastSpeed_ = speed;
        }

        // --- Move the blobs ---
        // On a >1px display, allow an axis increment near zero so motion isn't always
        // diagonal; a single-pixel display forces movement along the meaningful axis.
        bool allowZero = (width > 1 || height > 1);
        long rangeX = (long)(fw * speed * 255.0f);
        long rangeY = (long)(fh * speed * 255.0f);
        for (int c = 0; c < 3; c++) {
            if (steps_[c] <= 0) {
                long loX = allowZero ? 0 : rangeX / 2;
                long loY = allowZero ? 0 : rangeY / 2;
                // pixels per ms; +100 guarantees a minimum drift even at speed 0.
                xInc_[c] = (float)(randRange(loX, rangeX) + 100) / 50000.0f;
                yInc_[c] = (float)(randRange(loY, rangeY) + 100) / 50000.0f;
                if (randRange(0, 2)) xInc_[c] = -xInc_[c];
                if (randRange(0, 2)) yInc_[c] = -yInc_[c];
                // Hold this heading for a random span of frames (scaled by frame time)...
                long candidate = randRange((long)dt * 5, (long)dt * 25);
                // ...but cap the segment so a blob travels at most a couple of display
                // lengths before re-rolling, instead of cycling around and around.
                float pxPerMs = sqrtf(xInc_[c] * xInc_[c] + yInc_[c] * yInc_[c]);
                if (pxPerMs > 0.0f) {
                    const float MAX_SEGMENT_TRAVEL = maxDim * 2.0f; // ~2 traversals max
                    long maxSteps = (long)(MAX_SEGMENT_TRAVEL / (pxPerMs * (float)dt));
                    if (maxSteps < 1) maxSteps = 1;
                    if (candidate > maxSteps) candidate = maxSteps;
                }
                steps_[c] = candidate < 1 ? 1 : candidate;
            }
            xPos_[c] += xInc_[c] * (float)dt;
            yPos_[c] += yInc_[c] * (float)dt;
            // Toroidal wrap.
            while (xPos_[c] >= fw) xPos_[c] -= fw;
            while (xPos_[c] < 0.0f) xPos_[c] += fw;
            while (yPos_[c] >= fh) yPos_[c] -= fh;
            while (yPos_[c] < 0.0f) yPos_[c] += fh;
            steps_[c]--;
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

private:
    // Wrapping (toroidal) distance between two coordinates on an axis of length span.
    static inline float wrapDist(float a, float b, float span) {
        float d = fabsf(a - b);
        float w = span - d;
        return d < w ? d : w;
    }

    // Per-instance xorshift32 PRNG (independent per blob set -> devices diverge).
    inline uint32_t nextRand() {
        uint32_t x = rng_;
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        rng_ = x;
        return x;
    }
    // Half-open [lo, hi); returns lo if the range is empty.
    inline long randRange(long lo, long hi) {
        if (hi <= lo) return lo;
        return lo + (long)(nextRand() % (uint32_t)(hi - lo));
    }

    bool initialized_ = false;
    bool haveLastTs_ = false;
    uint32_t lastTs_ = 0;
    uint32_t rng_ = 0;
    float lastSpeed_ = -1.0f;
    float xPos_[3] = {0, 0, 0};
    float yPos_[3] = {0, 0, 0};
    float xInc_[3] = {0, 0, 0};
    float yInc_[3] = {0, 0, 0};
    long steps_[3] = {0, 0, 0};
};

REGISTER_OPERATOR(MovingBlobOperator);
