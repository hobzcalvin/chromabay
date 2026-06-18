# Physical Button Control — Implementation Plan

Status: **PLAN ONLY — not implemented.** A per-device momentary push button wired to a
GPIO that drives pattern/brightness/interaction changes, with those changes farmed out
to all connected devices via the app.

This is a sizable feature that touches the GPIO ISR, a gesture state machine, new BLE
notify paths, and multi-device coordination — all near the BLE stack. Build it in
phases, verifying each before the next.

---

## 1. Desired behavior (from the request)

A button is assigned to a **pin** per device (configurable, with a NULL/none option).
Gestures:

| Gesture | Action |
|---|---|
| **Single click** | Switch to the **next pattern**. |
| **Double click** | **Brightness − 32**, clamped at 0 (no wrap). **If already 0, any input → 255.** |
| **Click + hold** | Slowly ramp the **1st interaction parameter** (if any), full min→max loop ≈ **10 s**. |
| **Double-click + hold** | Same, for the **2nd interaction parameter**. |

- Changing pattern / interaction params / brightness on a device must **update the
  connected app**, and the app **farms the change out to all connected devices** (so a
  button on one device drives the whole set).
- The app's brightness slider (and knobs) must reflect button-driven changes live.

---

## 2. Key design decisions (confirm before building)

1. **Button wiring / active level.** Assume a momentary button to GND with
   `INPUT_PULLUP` (pressed = LOW). Confirm — if buttons are wired to 3V3, we need
   `INPUT_PULLDOWN` and inverted logic. *(Could add a "button active-low" flag later;
   start with pull-up.)*
2. **Where the button pin lives.** Reuse the existing LED-config payload
   (`FullLedConfiguration`, key e.g. `"btn"`, `-1` = none) since it already has
   get/set/persist/apply plumbing (`config_manager.h`, `esp32/src/main.cpp`
   `LedConfigGetCallbacks`/`processReceivedLedConfig`, app `ble.ts`
   get/setLedConfiguration). Render the UI control in **Device Information**, not the
   strip list. Alternative: a dedicated tiny characteristic — cleaner separation, more
   plumbing. **Recommend: reuse the config payload.**
3. **"Next pattern" ownership.** The device only holds its current pattern (+ optional
   playlist). The pattern *library* lives in the app. **Recommend app-mediated:** the
   button emits a "next pattern" *event*; the app advances its current pattern and
   sends it to all devices. Offline fallback (no app connected): cycle the saved
   playlist if present, else no-op. Confirm offline expectation.
4. **Brightness-at-zero rule.** When brightness == 0, "any input → 255." Decide whether
   that gesture is **consumed** (only turns on, doesn't also switch pattern) or also
   performs its normal action. **Recommend: consumed** (zero = "off"; next press = "on
   at full", nothing else).
5. **Interaction-param ramp = loop or clamp.** Request says "full loop," so **wrap**
   min→max→min while held. Rate = `(max−min)/10s`.
6. **App ↔ firmware interactive-param contract.** The firmware must know the *ordered*
   list of interactive params and their **min/max** to ramp "1st" / "2nd". Today
   interactivity lives only in the app (`interactiveStore.ts`, `MAX_INTERACTIVE_PARAMS
   = 6`); the serialized pattern sent to the device likely does **not** carry it.
   We must extend what's sent (see Phase 4).

---

## 3. Firmware architecture

### 3.1 GPIO + ISR (keep tiny)
- On config apply / boot: if `buttonPin >= 0`, `pinMode(buttonPin, INPUT_PULLUP)` and
  `attachInterrupt(buttonPin, isr, CHANGE)`. If it changes or becomes none, detach the
  old ISR first. Validate against strip data pins (warn/refuse on conflict).
- ISR is `IRAM_ATTR`, **does nothing but** push `(level, micros())` into a small
  lock-free ring buffer (or set volatile edge vars). **No Serial, no BLE, no flash, no
  malloc** in the ISR.
- All debounce + gesture logic runs on the **loop task** (like the existing
  `processReceived*` handlers), draining the edge buffer.

### 3.2 Debounce
- Ignore edges within ~25 ms of the last accepted edge.

### 3.3 Gesture state machine (the hard part — Phase 2)
Timings (tunable): `DEBOUNCE ≈ 25 ms`, `DOUBLE_GAP ≈ 300 ms` (max gap between clicks),
`HOLD ≈ 450 ms` (press longer = hold).

- **single click**: press, release < HOLD, no 2nd press within DOUBLE_GAP.
- **double click**: two quick press/release pairs within DOUBLE_GAP.
- **click+hold**: first press held > HOLD.
- **double-click+hold**: quick click, then a press held > HOLD.
- Inherent latency: a single click can't be confirmed until DOUBLE_GAP elapses (~300 ms)
  — acceptable and standard. Document it.
- While in a *hold* state, emit a continuous "ramp tick" each frame; on release, stop.

### 3.4 Actions
- **next pattern** → emit BLE notify event (app-mediated; §2.3).
- **brightness −32** → `b = (b > 0) ? max(0, b−32) : 255` (see §2.4) → apply locally via
  the existing live-brightness path (`ledMgr.setGlobalBrightness`, debounced persist) →
  notify app.
- **ramp param k** → while held, advance interactive param *k*'s value by
  `(max−min) * dt / 10000ms`, wrap at max → set it in the renderer's live pattern →
  notify app (throttled, e.g. every 100–200 ms, not every frame).

### 3.5 BLE notify path (firmware → app)
- Make the **brightness** characteristic `NOTIFY` (it's currently write-only) and notify
  on any change (button or otherwise) so the slider tracks it.
- Add a small **"button event / state" notify characteristic** carrying: event type
  (next-pattern | brightness | param), and for param: `(interactiveIndex, value)`.
- Notifies happen on the loop task; **suppress during OTA** and coordinate with the
  existing BLE write traffic.

---

## 4. App architecture

### 4.1 UI
- **Device Information** section gains a **"Button"** control: a pin number input with a
  **None** option (null). Persisted via the LED-config payload (§2.2). Validate (input-
  capable GPIO; warn if it collides with a strip pin).

### 4.2 Receiving notifications (`ble.ts` + devices page)
- Subscribe to the brightness + button-event notify characteristics on connect (via the
  existing init path; route through the `bleSerial` queue where applicable).
- On **brightness** notify → update that device's `liveBrightness` + ledConfig, and
  **farm out** to all *other* connected devices (`sendBrightnessToDevice`).
- On **param** notify → update the app's interactive-param value (knob) + the pattern
  param, and **sync the pattern to all** devices (`syncPatternToAllDevices`).
- On **next-pattern** notify → advance the app's current pattern (patterns library) and
  send it to all devices.
- Guard against feedback loops: a change the app pushed back to the originating device
  shouldn't echo into another notify → change → notify cycle (use a short suppression
  window or value-equality checks).

### 4.3 Interactive-param contract (Phase 4)
- Extend the device sync so the firmware receives the **ordered interactive params**
  with `(nodeRef, paramIndex, min, max)` — either embedded in the serialized pattern or
  a companion message — sourced from `interactiveStore` + node definitions. Order must
  match the app's knob order so "1st"/"2nd" agree.

---

## 5. Phased rollout (verify each phase on hardware before the next)

- **Phase 0 — decisions.** Lock §2 (wiring, storage, next-pattern ownership, zero rule,
  param contract). Reserve the mpack keys + characteristic UUID.
- **Phase 1 — plumbing, no actions.** App: Button pin field in Device Information,
  persisted. Firmware: store `buttonPin`, configure GPIO + ISR + debounce, **log edges
  over serial only.** Goal: clean, bounce-free edges with **zero BLE interference**
  (watch for crashes/dropouts while connected).
- **Phase 2 — gestures, no actions.** Implement the state machine; **log detected
  gestures** (single/double/hold/double-hold). Tune timings on real hardware.
- **Phase 3 — local actions + notify + farm-out for click/double-click.** Single →
  next pattern (app-mediated). Double → brightness (local apply + zero rule + notify +
  slider live-updates + farm out to all).
- **Phase 4 — interaction-param ramps.** Ship the param contract (app→firmware). Click-
  hold ramps 1st param; double-click-hold ramps 2nd; 10 s loop; notify + farm out.
- **Phase 5 — polish.** Offline next-pattern fallback, pin-conflict validation,
  feedback-loop guards, multi-device farm-out robustness, brightness-persist debounce
  interplay, OTA suppression.

---

## 6. Risks / watch-list
- **ISR discipline:** `IRAM_ATTR`, no BLE/Serial/flash/malloc in the ISR — only timestamped
  edges. All real work on the loop task.
- **BLE stack stability:** we already have a lot on the NimBLE host task + the app's
  `bleSerial` queue; new notifies must not flood or race. Throttle param notifies.
- **Feedback loops** in farm-out (device→app→devices→…). Add suppression / equality checks.
- **Gesture latency** (single click waits out the double-click window). Expected.
- **Pin conflicts** with strip data pins; validate.
- **Persistence churn:** button-driven brightness/param changes ride the existing
  debounced flash-persist — keep it debounced, don't add per-event writes.
- **Offline behavior:** define what the button does with no app connected.

---

## 7. Touch points (for whoever implements)
- Firmware: `esp32/src/main.cpp` (GPIO/ISR, gesture loop handler, notify chars,
  `processReceivedLedConfig`/`LedConfigGetCallbacks` for the pin), `config_manager.h`
  (persist `buttonPin`), live-brightness path already in `processReceivedBrightness`.
- App: `src/lib/ble.ts` (notify subscriptions, button-pin in get/setLedConfiguration,
  farm-out helpers), `src/routes/devices/+page.svelte` (Device Information UI,
  notify→state→farm-out), `src/lib/stores/interactiveStore.ts` (ordered param contract).
