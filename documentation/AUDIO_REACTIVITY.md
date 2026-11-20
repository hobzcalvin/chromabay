# Audio reactivity

A device with a microphone can drive patterns from sound. Like WLED, ChromaBay listens on the
device itself: the mic is wired to the ESP32 and analysed there. The app's preview has audio
too, but only so you can see what a pattern does while you edit it.

## Hardware

| Mic | Setting | Notes |
|---|---|---|
| INMP441, ICS-43434 and other I2S MEMS mics | **Generic I2S** | Needs SD, WS and SCK. Either L/R wiring works: both slots are captured and the one with sound is used (this also works around ESP-IDF 4.4 reading the wrong slot on the classic ESP32). The status shows which slot it locked onto. |
| SPH0645 | **SPH0654** (WLED's spelling) | I2S with a late-MSB quirk; the register fix is applied on classic ESP32. |
| I2S codec needing a master clock | **Generic I2S with Mclk** | Also set MCLK (classic ESP32: GPIO 0, 1 or 3). |
| PDM mics (SPM1423, MP34DT01, …) | **Generic I2S PDM** | Only clock (WS) and data (SD). ESP32 and ESP32-S3 only; the C3 can't record PDM. |
| Analog, ES7243, ES8388 | | Not supported yet. Imported WLED settings for them are kept, with the mic off. |
| No mic | **Simulated** | A synthetic 120 bpm groove, for trying audio patterns on real LEDs without a mic. |

Set it up under **Devices → (device) → Audio**. The tab has a live volume meter, a beat light
and a 16-band spectrum, so gain and squelch can be tuned by ear. The fields match WLED's
AudioReactive usermod (Squelch, Gain, AGC, Limiter rise/fall, Frequency scale) with the same
ranges, and converting a WLED device brings its mic settings over automatically.

A mic pin that is already an LED data/clock pin or the button pin is refused, and the status
line says which pin clashes. If the mic delivers nothing but zeros for a couple of seconds, the
status says "no signal", which usually means the SD (data) pin or the mic's power is wrong.

## In patterns

- **Automation.** Every parameter that can be automated can follow audio: open 🔄 and pick from
  the 🎵 Audio row.
  - *Volume*, *Bass*, *Mids*, *Treble* and *Beat* (a pulse on each beat). For these, the
    duration field is **Release**: the value jumps up at once and falls back over that many
    seconds (0 = raw).
  - *Beat wave* (a sine) and *Beat ramp* (a sawtooth) are locked to the detected tempo. For
    these, the duration field is **Beats per cycle**.
- **The Audio node** is a generator. It outputs the sound as an image, so any other node can
  use it:
  - *Level* and *Beat* fill the canvas with grey (tinted by Color).
  - *Bass/Mid/Treble → R/G/B* is one flat color. Blend → Multiply it with any pattern so each
    color channel follows its band.
  - *Spectrum* lays the 16 bands along an axis as brightness. This is the useful mode on a
    strip, and a good input for Gradient Map.
  - *Bars* is a classic analyzer with peak markers.

  Recipes:
  - Pulse anything: Pattern → Blend input 1, Audio (Level) → input 2, mode Multiply.
  - Waterfall: Audio (Spectrum) → Feedback with Drift Y.
  - Radial analyzer: Audio (Bars) → Polar Warp.

In the editor, a pattern that uses audio shows a 🎵 button. Click it to switch the preview from
the simulated beat to this phone's or computer's microphone (🎤).

## How it works

`native/AudioReactive.h` is shared by the firmware and the WASM preview:

- 22.05 kHz mono, 512-point FFT with a Hann window, 50% overlap (~86 analyses a second).
- Loudness and AGC run in WLED's units, with a noise gate.
- 16 log-spaced bands, from ~43 Hz to ~9 kHz.
- Beats come from spectral-flux onsets against an adaptive threshold.
- Tempo comes from autocorrelating the onset history over ~6 s, with a phase-locked beat clock.

On the device, `esp32/src/audio_input.h` captures on a task pinned to core 0. Each frame, the
render loop copies the latest result into `Audio::g_features`, which operators and automation
read.

Cost: a few percent of one core on ESP32 and S3, more on the C3 (no FPU, single core). About
30 KB of RAM (the analyzer, DMA buffers and the task stack), allocated only while a mic is on.
About 32 KB of flash.

Wire protocol:
- Endpoint `AUDIO_CONFIG` (`a0be83e3-…`). A read returns JSON: settings, status and live
  levels. A write is a msgpack patch of the same keys.
- Device info reports `"audio":1`.

Tests:
- `esp32/test/audio_test.cpp`: the analyzer on synthetic tones, noise and a 128 bpm kick.
- The `audio-input` emulator scenario: pin clash refused, LEDs pulse at 120 bpm from the
  simulated input, settings survive a reboot.
