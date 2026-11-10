#pragma once
#include "BaseOperator.h"
#include "OpUtil.h"
#include <vector>

// Particles - a small particle system (after WLED's particle effects): an emitter spawns
// particles with a velocity, gravity pulls them, they fade over their life and leave trails.
// Modes set where and how they spawn: a fountain from the bottom, fireworks that rise and
// burst, falling snow/rain, or sparks anywhere. Stateful and random, like Fire, so the
// preview and a device look alike but are not frame-identical.
class ParticlesOperator : public BaseOperator {
    struct P { float x, y, vx, vy, life, maxLife; uint8_t hue; bool rocket; };
    std::vector<P> _ps;
    std::vector<CRGB> _trail;
    float _spawnAcc = 0.0f;
    uint32_t _rng = 0x9E3779B9u;
    float rnd() { _rng ^= _rng << 13; _rng ^= _rng >> 17; _rng ^= _rng << 5; return (float)(_rng & 0xFFFFFF) / 16777216.0f; }
    static const int MAXP = 160;

    void spawn(int mode, float speed, float hue, float hueSpread, float life, float hx, float hy, float g) {
        if ((int)_ps.size() >= MAXP) return;
        P q; q.rocket = false; q.maxLife = life * (0.6f + 0.8f * rnd()); q.life = q.maxLife;
        q.hue = (uint8_t)((int)(hue + (rnd() - 0.5f) * hueSpread) & 255);
        switch (mode) {
            case 1: // fireworks: a rocket from the bottom that bursts near its apex
                q.x = (rnd() * 1.6f - 0.8f) * hx; q.y = hy;
                q.vx = (rnd() - 0.5f) * 0.3f * hx;
                // Launch speed for an apex 60..95% of the way up: v = sqrt(2 g h).
                q.vy = -sqrtf(2.0f * (g > 0.05f ? g : 0.05f) * 2.0f * hy * (0.6f + 0.35f * rnd()));
                q.rocket = true; q.maxLife = q.life = 3.0f; q.hue = (uint8_t)((int)(hue + rnd() * hueSpread) & 255);
                break;
            case 2: // snow / rain: from the top edge, drifting down
                q.x = (rnd() * 2.0f - 1.0f) * hx; q.y = -hy;
                q.vx = (rnd() - 0.5f) * 0.15f * speed; q.vy = (0.3f + rnd() * 0.4f) * speed;
                break;
            case 3: { // sparks: anywhere, a small random kick
                q.x = (rnd() * 2.0f - 1.0f) * hx; q.y = (rnd() * 2.0f - 1.0f) * hy;
                float a = rnd() * OpUtil::TAU_F, s = rnd() * 0.4f * speed;
                q.vx = cosf(a) * s; q.vy = sinf(a) * s;
                break; }
            default: { // fountain: from the bottom centre, upward in a cone
                float a = -OpUtil::PI_F * 0.5f + (rnd() - 0.5f) * 0.6f;
                float s = (1.2f + rnd() * 0.5f) * speed;
                q.x = 0.0f; q.y = hy; q.vx = cosf(a) * s; q.vy = sinf(a) * s;
                if (hy < 0.05f) { q.x = -1.0f; q.vx = s * 0.9f; q.vy = 0.0f; } // a strip: shoot along it
                break; }
        }
        _ps.push_back(q);
    }

public:
    void render(CRGB* /* in1 */, CRGB* /* in2 */, CRGB* out, uint32_t width, uint32_t height,
                uint32_t /* timestampMs */, uint32_t deltaTimeMs, const std::vector<ParameterValue>& p) override {
        int mode = getInt(p, 0, 0);
        float rate = getFloat(p, 1, 40.0f);        // particles per second
        float speed = getFloat(p, 2, 1.0f);
        float gravity = getFloat(p, 3, 1.0f);
        float life = getFloat(p, 4, 1.5f);         // seconds
        float trails = getFloat(p, 5, 0.6f);       // 0 = none, 1 = long
        float hue = getFloat(p, 6, 20.0f);
        float hueSpread = getFloat(p, 7, 60.0f);
        float sat = getFloat(p, 8, 220.0f);
        uint32_t n = width * height;
        if (_trail.size() != n) { _trail.assign(n, CRGB::Black); _ps.clear(); }
        float dt = (float)deltaTimeMs * 0.001f;
        if (dt <= 0.0f || dt > 0.1f) dt = 0.016f;
        OpUtil::Frame f(width, height);
        float hx = f.cx * f.inv, hy = f.cy * f.inv;
        float g = (mode == 2 ? 0.25f : 1.0f) * gravity;

        _spawnAcc += rate * dt * (mode == 1 ? 0.06f : 1.0f);
        while (_spawnAcc >= 1.0f) { spawn(mode, speed, hue, hueSpread, life, hx, hy, g); _spawnAcc -= 1.0f; }

        // Trails: fade last frame instead of clearing it.
        uint8_t keep = (uint8_t)(OpUtil::clamp01(trails) * 235.0f);
        for (uint32_t i = 0; i < n; i++) { // (scaled by hand: CRGB::nscale8 isn't in the WASM's FastLED bundles)
            CRGB& t = _trail[i];
            t.r = (uint8_t)((t.r * keep) >> 8); t.g = (uint8_t)((t.g * keep) >> 8); t.b = (uint8_t)((t.b * keep) >> 8);
        }

        for (size_t i = 0; i < _ps.size();) {
            P& q = _ps[i];
            q.vy += g * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.life -= dt;
            bool burst = q.rocket && (q.vy >= -0.05f || q.life <= 0.0f);
            if (burst) {
                float bx = q.x, by = q.y; uint8_t bh = q.hue;
                _ps.erase(_ps.begin() + i);
                int k = 24;
                for (int j = 0; j < k && (int)_ps.size() < MAXP; j++) {
                    P s; s.rocket = false; s.x = bx; s.y = by;
                    float a = rnd() * OpUtil::TAU_F, sp = (0.3f + rnd() * 0.5f) * speed;
                    s.vx = cosf(a) * sp; s.vy = sinf(a) * sp;
                    s.maxLife = s.life = life * (0.5f + rnd() * 0.7f);
                    s.hue = (uint8_t)((int)(bh + (rnd() - 0.5f) * hueSpread * 0.5f) & 255);
                    _ps.push_back(s);
                }
                continue;
            }
            if (q.life <= 0.0f || q.y > hy + 0.3f || q.x < -hx - 0.3f || q.x > hx + 0.3f) { _ps.erase(_ps.begin() + i); continue; }
            // Splat into the 2x2 pixels around the particle, additively.
            float fx = f.px(q.x), fy = f.py(q.y);
            float lf = q.rocket ? 1.0f : OpUtil::clamp01(q.life / q.maxLife);
            CRGB c = CHSV(q.hue, q.rocket ? (uint8_t)(sat * 0.3f) : (uint8_t)sat, OpUtil::to8(lf));
            int x0 = (int)floorf(fx), y0 = (int)floorf(fy);
            float tx = fx - x0, ty = fy - y0;
            for (int dy = 0; dy < 2; dy++) for (int dx = 0; dx < 2; dx++) {
                int xx = x0 + dx, yy = y0 + dy;
                if (xx < 0 || yy < 0 || xx >= (int)width || yy >= (int)height) continue;
                float w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
                CRGB s = c; s.nscale8_video(OpUtil::to8(w));
                CRGB& t = _trail[(size_t)yy * width + xx];
                t.r = qadd8(t.r, s.r); t.g = qadd8(t.g, s.g); t.b = qadd8(t.b, s.b);
            }
            i++;
        }
        for (uint32_t i = 0; i < n; i++) out[i] = _trail[i];
    }
    const char* getName() const override { return "particles"; }
    const char* getDisplayName() const override { return "Particles"; }
    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            ParameterInfo("mode", "Mode", ParameterInfo::SELECT, 0, std::vector<std::string>{ "Fountain", "Fireworks", "Snow", "Sparks" }),
            ParameterInfo("rate", "Rate (/sec)", ParameterInfo::FLOAT, 40.0f, 0.0f, 200.0f),
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 1.0f, 0.1f, 3.0f),
            ParameterInfo("gravity", "Gravity", ParameterInfo::FLOAT, 1.0f, -2.0f, 4.0f),
            ParameterInfo("life", "Life (sec)", ParameterInfo::FLOAT, 1.5f, 0.1f, 5.0f),
            ParameterInfo("trails", "Trails", ParameterInfo::FLOAT, 0.6f, 0.0f, 1.0f),
            ParameterInfo("hue", "Hue", ParameterInfo::FLOAT, 20.0f, 0.0f, 255.0f),
            ParameterInfo("hue_spread", "Hue spread", ParameterInfo::FLOAT, 60.0f, 0.0f, 255.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 220.0f, 0.0f, 255.0f)
        };
    }
};
REGISTER_OPERATOR(ParticlesOperator);
