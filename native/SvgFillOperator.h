#pragma once

#include "BaseOperator.h"
#include <string>
#include <vector>
#include <algorithm>
#include <cmath>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// SvgFill - renders a FILLED vector shape. The heavy lifting (parsing an SVG `d` string,
// flattening beziers/arcs) happens in the browser (src/lib/svgFlatten.ts); the device only
// ever receives pre-flattened contours as a compact string param and scanline-fills them.
// So preview (WASM) and firmware fill the SAME geometry and match exactly. Rotation / scale /
// offset are plain floats, so the automation system can spin / pulse / move the shape.
//
// Encoded path format (param 0): "1|<contour>;<contour>;..." where each contour is
//   "<count>:x0,y0,x1,y1,..." with integer coords normalised to ~[-500,500] (÷1000 →
//   [-0.5,0.5], aspect-preserved, bbox-centred). See svgFlatten.ts encodeContours().
class SvgFillOperator : public BaseOperator {
public:
    void render(
        CRGB* /* in1 */, CRGB* /* in2 */, CRGB* outputBuffer,
        uint32_t width, uint32_t height,
        uint32_t /* timestampMs */, uint32_t /* deltaTimeMs */,
        const std::vector<ParameterValue>& parameters
    ) override {
        const uint32_t total = width * height;
        for (uint32_t i = 0; i < total; i++) outputBuffer[i] = CRGB::Black;
        if (width == 0 || height == 0) return;

        // Fall back to the heart preset when unset/empty so previews (which pass no params)
        // and fresh nodes render a shape rather than black.
        std::string path = getString(parameters, 0, kHeart);
        if (path.empty()) path = kHeart;
        if (path != _lastPath) { decode(path); _lastPath = path; }
        if (_contours.empty()) return;

        const float rot   = getFloat(parameters, 1, 0.0f) * (float)M_PI / 180.0f;
        const float scale = getFloat(parameters, 2, 1.0f);
        const float offX  = getFloat(parameters, 3, 0.0f);
        const float offY  = getFloat(parameters, 4, 0.0f);
        const uint8_t hue = (uint8_t)getFloat(parameters, 5, 0.0f);
        const uint8_t sat = (uint8_t)getFloat(parameters, 6, 255.0f);
        const bool evenOdd = getBool(parameters, 7, false);
        const CRGB fill = CHSV(hue, sat, 255);

        const float base = (float)(width < height ? width : height);
        const float cs = cosf(rot), sn = sinf(rot);
        const float cx = width * 0.5f + offX * (float)width;
        const float cy = height * 0.5f + offY * (float)height;

        // Transform normalised contours → pixel space once per frame.
        _px.clear();
        _px.resize(_contours.size());
        for (size_t c = 0; c < _contours.size(); c++) {
            const std::vector<float>& src = _contours[c];
            std::vector<float>& dst = _px[c];
            dst.resize(src.size());
            for (size_t i = 0; i + 1 < src.size(); i += 2) {
                const float nx = src[i], ny = src[i + 1];
                const float rx = nx * cs - ny * sn;
                const float ry = nx * sn + ny * cs;
                dst[i]     = cx + rx * scale * base;
                dst[i + 1] = cy + ry * scale * base;
            }
        }

        // Scanline polygon fill with winding rule.
        for (uint32_t y = 0; y < height; y++) {
            const float yc = (float)y + 0.5f;
            _xs.clear();
            for (size_t c = 0; c < _px.size(); c++) {
                const std::vector<float>& p = _px[c];
                const size_t n = p.size() / 2;
                if (n < 2) continue;
                for (size_t i = 0; i < n; i++) {
                    const size_t j = (i + 1) % n;                 // closed loop
                    const float x0 = p[i * 2], y0 = p[i * 2 + 1];
                    const float x1 = p[j * 2], y1 = p[j * 2 + 1];
                    if ((y0 <= yc && y1 > yc) || (y1 <= yc && y0 > yc)) {
                        const float t = (yc - y0) / (y1 - y0);
                        _xs.push_back({ x0 + t * (x1 - x0), y1 > y0 ? 1 : -1 });
                    }
                }
            }
            if (_xs.size() < 2) continue;
            std::sort(_xs.begin(), _xs.end(), [](const Cross& a, const Cross& b) { return a.x < b.x; });

            int wind = 0;
            for (size_t k = 0; k + 1 < _xs.size(); k++) {
                wind += _xs[k].dir;
                const bool inside = evenOdd ? (((int)k + 1) & 1) : (wind != 0);
                if (!inside) continue;
                int xs = (int)ceilf(_xs[k].x - 0.5f);
                int xe = (int)ceilf(_xs[k + 1].x - 0.5f);
                if (xs < 0) xs = 0;
                if (xe > (int)width) xe = (int)width;
                for (int x = xs; x < xe; x++) outputBuffer[(size_t)y * width + x] = fill;
            }
        }
    }

    const char* getName() const override { return "svgfill"; }
    const char* getDisplayName() const override { return "SVG Fill"; }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            // Default = a filled heart preset (see svgFlatten.ts PRESETS) so it draws out of the box.
            ParameterInfo("path", "Path", ParameterInfo::STRING, ParameterValue(std::string(kHeart))),
            ParameterInfo("rotation", "Rotation", ParameterInfo::FLOAT, 0.0f, 0.0f, 360.0f),
            ParameterInfo("scale", "Scale", ParameterInfo::FLOAT, 0.85f, 0.1f, 3.0f),
            ParameterInfo("offset_x", "Offset X", ParameterInfo::FLOAT, 0.0f, -1.0f, 1.0f),
            ParameterInfo("offset_y", "Offset Y", ParameterInfo::FLOAT, 0.0f, -1.0f, 1.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 0.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f),
            ParameterInfo("even_odd", "Even-odd holes", ParameterInfo::BOOL, ParameterValue(false))
        };
    }

private:
    struct Cross { float x; int dir; };

    void decode(const std::string& s) {
        _contours.clear();
        size_t bar = s.find('|');
        if (bar == std::string::npos) return;
        size_t pos = bar + 1;
        while (pos < s.size()) {
            size_t semi = s.find(';', pos);
            size_t end = (semi == std::string::npos) ? s.size() : semi;
            size_t colon = s.find(':', pos);
            if (colon != std::string::npos && colon < end) {
                std::vector<float> pts;
                size_t p = colon + 1;
                while (p < end) {
                    // parse one integer (optionally negative)
                    bool neg = false;
                    if (s[p] == '-') { neg = true; p++; }
                    long v = 0; bool any = false;
                    while (p < end && s[p] >= '0' && s[p] <= '9') { v = v * 10 + (s[p] - '0'); p++; any = true; }
                    if (any) pts.push_back((neg ? -v : v) / 1000.0f);
                    while (p < end && (s[p] == ',' || s[p] == ' ')) p++;
                    if (!any) break;
                }
                if (pts.size() >= 4) _contours.push_back(std::move(pts));
            }
            if (semi == std::string::npos) break;
            pos = semi + 1;
        }
    }

    std::string _lastPath;
    std::vector<std::vector<float>> _contours;   // normalised [-0.5,0.5], flat x,y pairs
    std::vector<std::vector<float>> _px;          // transformed to pixels (per frame)
    std::vector<Cross> _xs;                       // scanline crossings (per row)

    // Heart preset (byte-identical to svgFlatten PRESETS.heart flattened output) so preview
    // and firmware render the same shape, and it draws immediately with no param set.
    static constexpr const char* kHeart =
        "1|34:0,467,-325,183,-395,105,-450,17,-487,-84,-497,-140,-498,-239,-493,-274,"
        "-472,-333,-421,-398,-377,-428,-303,-455,-225,-466,-157,-462,-103,-441,-62,-406,"
        "-24,-347,0,-283,41,-378,88,-431,120,-450,157,-462,225,-466,303,-455,377,-428,"
        "440,-380,472,-333,493,-274,498,-239,497,-140,471,-32,424,62,325,183,39,430";
};

REGISTER_OPERATOR(SvgFillOperator);
