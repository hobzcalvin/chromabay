#pragma once

#include "BaseOperator.h"

/*
 * Buggy Rainbow — a rainbow with a deliberate crash in it. DEMO OPERATOR.
 * ======================================================================
 *
 * Exists to produce a real, field-realistic ESP32 panic on demand, so that crash reporting
 * can be demonstrated end to end: set Speed to 0, the device divides by zero, panics, reboots,
 * and reports a symbolicated backtrace to Sentry through the phone.
 *
 * The bug is the ordinary kind, not a contrived one. `millisecondsPerHueStep()` divides by a parameter
 * the UI is perfectly happy to set to zero, and the author guarded the *other* division a few
 * lines down — the shape of a real oversight rather than an `abort()` in a wrapper.
 *
 * It does NOT crash in the browser preview, deliberately, and that is the point of the demo:
 * the preview path is float (1000.0f / 0 is infinity, so the rainbow simply freezes), while
 * the device path is fixed-point integer, where the same expression is a hardware exception.
 * A bug you cannot reproduce on your laptop but that kills devices in the field is exactly the
 * situation this SDK exists for. (It is also a hard requirement: a WASM integer divide by zero
 * traps, which would take the editor down with it — including the relay that has to deliver
 * the device's crash report.)
 *
 * Arch note: Xtensa (classic ESP32, S3) raises IntegerDivideByZero and panics. RISC-V (C3)
 * defines x/0 as all-ones and does not trap — there the bogus step value falls through to the
 * guarded division below and the pattern merely freezes. Demo on an Xtensa board.
 *
 * Remove or gate this operator before shipping firmware to users.
 */
class BuggyRainbowOperator : public BaseOperator {
public:
    void render(
        CRGB* /* inputBuffer1 */,
        CRGB* /* inputBuffer2 */,
        CRGB* outputBuffer,
        uint32_t width,
        uint32_t height,
        uint32_t /* timestampMs */,
        uint32_t deltaTimeMs,
        const std::vector<ParameterValue>& parameters
    ) override {
        uint32_t speed = (uint32_t)getFloat(parameters, 0, 120.0f);
        uint8_t saturation = (uint8_t)getFloat(parameters, 1, 255.0f);

        // How long one hue step lasts at the configured speed.
        uint32_t stepMs = millisecondsPerHueStep(speed);

        // Advance the hue by however many steps fit in the time since the last frame.
        _elapsedMs += deltaTimeMs;
        uint8_t hueOffset = 0;
        if (stepMs > 0) {                      // the guard that should have been up there too
            hueOffset = (uint8_t)((_elapsedMs / stepMs) & 0xFF);
        }

        for (uint32_t y = 0; y < height; y++) {
            for (uint32_t x = 0; x < width; x++) {
                uint32_t index = y * width + x;
                uint8_t hue = (uint8_t)(((x * 255) / (width > 0 ? width : 1)) + hueOffset);
                outputBuffer[index] = CHSV(hue, saturation, 255);
            }
        }
    }

    const char* getName() const override {
        return "buggy_rainbow";
    }

    const char* getDisplayName() const override {
        return "Buggy Rainbow";
    }

    std::vector<ParameterInfo> getParameterInfo() const override {
        return {
            // Minimum 0, so the slider can reach the value that crashes the device. A real
            // operator would set this to 1 and there would be no bug to demonstrate.
            ParameterInfo("speed", "Speed", ParameterInfo::FLOAT, 120.0f, 0.0f, 500.0f),
            ParameterInfo("saturation", "Saturation", ParameterInfo::FLOAT, 255.0f, 0.0f, 255.0f)
        };
    }

private:
    /**
     * Milliseconds per hue step, from the speed slider (hue steps per second).
     *
     * >>> THE BUG: `speed` reaches this as 0 whenever the slider is at its minimum, and this
     * >>> is an integer division. On Xtensa that is EXCCAUSE 6, IntegerDivideByZero: the chip
     * >>> panics here, in this function, on this line.
     *
     * `noinline` so the frame survives -O2 and shows up in the backtrace by name — without it
     * the panic is reported inside render() and the stack trace is a great deal less obvious.
     *
     * `noclone` because GCC's interprocedural SRA otherwise emits a specialised copy named
     * `_ZN20BuggyRainbowOperator12millisecondsPerHueStepEj$isra$55`, and the `$isra$` suffix is not
     * valid in a mangled name, so demanglers give up and Sentry prints that verbatim while
     * every other frame reads as C++. Measured, not theorised — it is what the first
     * symbolicated backtrace showed.
     */
#if defined(__EMSCRIPTEN__)
    // Browser preview: float division, so speed 0 yields infinity rather than a trap and the
    // rainbow simply freezes. The comparison is load-bearing — WebAssembly traps when
    // converting infinity to an integer, which would crash the editor just as hard as the
    // division it is standing in for.
    __attribute__((noinline))
    uint32_t millisecondsPerHueStep(uint32_t hueStepsPerSecond) {
        float ms = 1000.0f / (float)hueStepsPerSecond;
        return (ms > 1000000.0f || !(ms == ms)) ? 0u : (uint32_t)ms;
    }
#else
    __attribute__((noinline, noclone))
    uint32_t millisecondsPerHueStep(uint32_t hueStepsPerSecond) {
        const uint32_t millisecondsPerSecond = 1000u;
        // Named rather than returned directly, so the faulting instruction belongs to the
        // division's own line. Returning the expression let -O2 fold the divide into the
        // epilogue, and the backtrace pointed at the closing brace — technically the right
        // address, useless to read.
        const uint32_t millisecondsPerStep = millisecondsPerSecond / hueStepsPerSecond;
        return millisecondsPerStep;
    }
#endif

    uint32_t _elapsedMs = 0;
};

REGISTER_OPERATOR(BuggyRainbowOperator);
