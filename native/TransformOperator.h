#pragma once

#include "BaseOperator.h"
#include <math.h>

// General 2D image transform. Rendering uses inverse mapping (one source lookup for every
// destination pixel), so rotation/scaling never leave forward-mapping holes. The first seven
// controls cover the common case; pivot, shear and perspective provide an advanced homography.
class TransformOperator : public BaseOperator {
    static int wrapCoord(int v, int n) {
        if (n <= 1) return 0;
        v %= n;
        return v < 0 ? v + n : v;
    }
    static int mirrorCoord(int v, int n) {
        if (n <= 1) return 0;
        int period = 2 * (n - 1);
        v = wrapCoord(v, period);
        return v < n ? v : period - v;
    }
    static int edgeCoord(int v, int n, int edge, bool& valid) {
        if (v >= 0 && v < n) return v;
        if (edge == 0) { valid = false; return 0; } // transparent
        if (edge == 1) return wrapCoord(v, n);
        if (edge == 2) return v < 0 ? 0 : n - 1;   // clamp
        return mirrorCoord(v, n);
    }
    static CRGB sample(CRGB* in, int w, int h, float x, float y, int edge, bool bilinear) {
        if (!bilinear) {
            bool ok = true;
            int ix = edgeCoord((int)lroundf(x), w, edge, ok);
            int iy = edgeCoord((int)lroundf(y), h, edge, ok);
            return ok ? in[iy * w + ix] : CRGB::Black;
        }
        int x0 = (int)floorf(x), y0 = (int)floorf(y);
        float fx = x - x0, fy = y - y0;
        CRGB p[4];
        const int xx[4] = { x0, x0 + 1, x0, x0 + 1 };
        const int yy[4] = { y0, y0, y0 + 1, y0 + 1 };
        for (int i = 0; i < 4; i++) {
            bool ok = true;
            int sx = edgeCoord(xx[i], w, edge, ok);
            int sy = edgeCoord(yy[i], h, edge, ok);
            p[i] = ok ? in[sy * w + sx] : CRGB::Black;
        }
        float weights[4] = { (1-fx)*(1-fy), fx*(1-fy), (1-fx)*fy, fx*fy };
        int r = 0, g = 0, b = 0;
        for (int i = 0; i < 4; i++) {
            r += (int)(p[i].r * weights[i] + 0.5f);
            g += (int)(p[i].g * weights[i] + 0.5f);
            b += (int)(p[i].b * weights[i] + 0.5f);
        }
        return CRGB((uint8_t)(r > 255 ? 255 : r), (uint8_t)(g > 255 ? 255 : g), (uint8_t)(b > 255 ? 255 : b));
    }

public:
    void render(CRGB* inputBuffer1, CRGB* /* inputBuffer2 */, CRGB* outputBuffer,
                uint32_t width, uint32_t height, uint32_t /* timestampMs */,
                uint32_t /* deltaTimeMs */, const std::vector<ParameterValue>& p) override {
        const uint32_t total = width * height;
        if (!inputBuffer1 || width == 0 || height == 0) {
            for (uint32_t i = 0; i < total; i++) outputBuffer[i] = CRGB::Black;
            return;
        }

        float sx = getFloat(p, 0, 1.0f);
        float sy = getBool(p, 2, true) ? sx : getFloat(p, 1, 1.0f);
        if (fabsf(sx) < 0.001f) sx = 0.001f;
        if (fabsf(sy) < 0.001f) sy = 0.001f;
        float tx = getFloat(p, 3, 0.0f) / 100.0f;
        float ty = getFloat(p, 4, 0.0f) / 100.0f;
        float angle = getFloat(p, 5, 0.0f) * 0.0174532925199433f;
        int edge = getInt(p, 6, 0);
        bool bilinear = getInt(p, 7, 1) == 1;
        float pivotX = getFloat(p, 8, 50.0f) / 100.0f;
        float pivotY = getFloat(p, 9, 50.0f) / 100.0f;
        float shx = getFloat(p, 10, 0.0f) / 100.0f;
        float shy = getFloat(p, 11, 0.0f) / 100.0f;
        float perspX = getFloat(p, 12, 0.0f);
        float perspY = getFloat(p, 13, 0.0f);
        if (getBool(p, 14, false)) sx = -sx;
        if (getBool(p, 15, false)) sy = -sy;

        // Forward linear part = rotation * shear * scale. We invert it below.
        float cs = cosf(angle), sn = sinf(angle);
        float a = cs * sx - sn * shy * sx;
        float b = cs * shx * sy - sn * sy;
        float c = sn * sx + cs * shy * sx;
        float d = sn * shx * sy + cs * sy;
        float det = a * d - b * c;
        if (fabsf(det) < 0.000001f) det = det < 0 ? -0.000001f : 0.000001f;

        const float wx = width > 1 ? (float)(width - 1) : 1.0f;
        const float hy = height > 1 ? (float)(height - 1) : 1.0f;
        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                // Output coordinates relative to pivot; translation is % of canvas span.
                float qx = (float)x / wx - pivotX - tx;
                float qy = (float)y / hy - pivotY - ty;

                // Invert q = (L*u) / (1 + perspective·u). Solving the two projective
                // equations gives a 2x2 system whose coefficients depend on q.
                float aa = a - qx * perspX;
                float bb = b - qx * perspY;
                float cc = c - qy * perspX;
                float dd = d - qy * perspY;
                float hdet = aa * dd - bb * cc;
                if (fabsf(hdet) < 0.000001f) {
                    outputBuffer[y * width + x] = CRGB::Black;
                    continue;
                }
                float u = (qx * dd - bb * qy) / hdet;
                float v = (aa * qy - qx * cc) / hdet;
                float srcX = (u + pivotX) * wx;
                float srcY = (v + pivotY) * hy;
                outputBuffer[y * width + x] = sample(inputBuffer1, (int)width, (int)height,
                                                      srcX, srcY, edge, bilinear);
            }
        }
    }

    const char* getName() const override { return "transform"; }
    const char* getDisplayName() const override { return "Transform"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("scaleX", "Scale X", ParameterInfo::FLOAT, 1.0f, 0.05f, 4.0f),
            ParameterInfo("scaleY", "Scale Y", ParameterInfo::FLOAT, 1.0f, 0.05f, 4.0f),
            ParameterInfo("lockScale", "Lock X/Y scale", ParameterInfo::BOOL, true),
            ParameterInfo("moveX", "Move X (%)", ParameterInfo::FLOAT, 0.0f, -200.0f, 200.0f),
            ParameterInfo("moveY", "Move Y (%)", ParameterInfo::FLOAT, 0.0f, -200.0f, 200.0f),
            ParameterInfo("rotation", "Rotation (degrees)", ParameterInfo::FLOAT, 0.0f, -180.0f, 180.0f),
            ParameterInfo("edge", "Off-edge pixels", ParameterInfo::SELECT, 0,
                          std::vector<std::string>{"Transparent", "Wrap", "Clamp", "Mirror"}),
            ParameterInfo("sampling", "Sampling", ParameterInfo::SELECT, 1,
                          std::vector<std::string>{"Nearest", "Smooth"}),
            ParameterInfo("pivotX", "Pivot X (%)", ParameterInfo::FLOAT, 50.0f, 0.0f, 100.0f),
            ParameterInfo("pivotY", "Pivot Y (%)", ParameterInfo::FLOAT, 50.0f, 0.0f, 100.0f),
            ParameterInfo("shearX", "Shear X (%)", ParameterInfo::FLOAT, 0.0f, -200.0f, 200.0f),
            ParameterInfo("shearY", "Shear Y (%)", ParameterInfo::FLOAT, 0.0f, -200.0f, 200.0f),
            ParameterInfo("perspectiveX", "Perspective X", ParameterInfo::FLOAT, 0.0f, -1.5f, 1.5f),
            ParameterInfo("perspectiveY", "Perspective Y", ParameterInfo::FLOAT, 0.0f, -1.5f, 1.5f),
            ParameterInfo("flipX", "Flip X", ParameterInfo::BOOL, false),
            ParameterInfo("flipY", "Flip Y", ParameterInfo::BOOL, false)
        };
    }
};

REGISTER_OPERATOR(TransformOperator);
