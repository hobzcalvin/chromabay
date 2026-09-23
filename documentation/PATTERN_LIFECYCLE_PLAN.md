# Pattern Lifecycle / Library Sync — Implementation Plan

> **Superseded (for the model) by [`PATTERN_LIFECYCLE.md`](PATTERN_LIFECYCLE.md).**
> That doc is the unified plan (identity, ownership, sharing, gallery, cycling). This file
> remains the reference for the BLE **push/pull transport** used in its Phase 1.

Status: **PLAN ONLY — not implemented.** (Operators in this same batch ARE shipped.)

Goal: patterns are a **shared library** that spreads device → app → all devices. On
connect, a device receives all of the app's patterns and contributes any the app
lacks; new patterns propagate to every connected device. Identity is the pattern
**name** everywhere; on a same-name collision the **app's version wins**.

Why plan-first: this is the most BLE-intensive feature yet — bulk, bidirectional
transfer *during the connect sequence*, which is precisely where we've had the most
trouble (strip loss, the device-name persistence race, the config clobber, connect-time
GATT concurrency). It also adds multi-pattern flash storage on the device. Each piece
needs on-device verification before the next, so it shouldn't land unverified.

---

## 1. Model

- **App is the source of truth.** App-wins on name collisions.
- **Device holds a full mirror** of the union (app-preferred). Bonus: a local library
  enables offline button "next pattern" (today that's app-mediated — see
  BUTTON_CONTROL_PLAN.md).
- **Live "current pattern"** (the existing `PATTERN_SYNC` characteristic, for display)
  stays SEPARATE from the **library** (new `LIBRARY_*` characteristics). Don't conflate.

## 2. Device-side storage

- A `/lib/` directory in LittleFS (1MB `spiffs` partition — ample; patterns are
  ~50–300 B). **Cap** at e.g. 64 patterns; log + drop beyond.
- Each pattern stored as its serialized msgpack blob (same bytes as a `PATTERN_SYNC`
  payload — already contains `meta.name`).
- **Name → file mapping.** Don't sanitize names into filenames (collisions, charset
  pain). Use index files `/lib/0.mp`, `/lib/1.mp`, … plus an in-RAM `name → index` map
  built at boot by reading each blob's `meta.name`. Optionally persist a tiny
  `/lib/manifest.mp` (array of names in index order) to skip the boot scan.
- **Name extraction:** add a firmware helper `extractPatternName(blob) → String` using
  mpack (we already parse patterns in `loadPatternFromMessagePack`).
- **Upsert by name:** look up the name in the map; overwrite that index, or allocate a
  new one. Writes are rare (connect-time), so no debounce needed, but batch the
  manifest write.

## 3. BLE protocol (pull-model — avoids flooding)

New characteristics on the LED service:
- `LIBRARY_UPSERT` (WRITE): app writes one serialized pattern → device upserts by name.
  App loops its patterns here. NimBLE reassembles long writes, so one pattern = one
  write (no manual chunking) as long as it fits the negotiated MTU window.
- `LIBRARY_DUMP_CTRL` (WRITE) + `LIBRARY_DUMP_DATA` (NOTIFY): app writes "start"/"next";
  device notifies the next stored blob each time, then a "done" sentinel. **Pull model**
  (app asks for each) instead of the device firehosing notifies — controlled, no flood.

All app-side ops go through the existing `bleSerial` queue.

## 4. Connect sequence (app side)

Order matters and bulk sync must not delay basic usability:
1. (existing) loadLedConfig → deviceInfo → buttonPin → subscriptions. Device usable here.
2. **Push:** app sends all its patterns via `LIBRARY_UPSERT` (app-wins overwrite on device).
3. **Pull:** app drives the dump; for each returned blob whose name it does NOT already
   have, add to the store and propagate (step 5). App-owned names are skipped (app-wins).
4. Do 2–3 *after* step 1 (and ideally lazily / in the background) so a big library doesn't
   stall the connect. Consider a per-connection "already synced this session" guard.

## 5. App-side merge + propagation

- `patternsStore`: add `hasPattern(name)`, `upsertPattern(pattern)` (add/overwrite by
  name, persist to localStorage).
- On a pulled device pattern with an **unknown** name → `upsertPattern` + push it via
  `LIBRARY_UPSERT` to **all other connected devices**.
- When the app gains a pattern by any means (device pull, user import) → push to all
  connected devices that don't have it.
- **Convergence / no loops:** upsert is idempotent by name and app-wins, so it settles.
  Only propagate genuinely new/changed patterns (track a content hash or a "seen" set)
  to avoid A→app→B→app→… churn.

## 6. Optimization (later)

Exchange **name manifests** first (app's names ↔ device's names) so each side transfers
only what the other lacks, instead of push-all + pull-all + filter. Worth it once
libraries get large; not needed for v1.

## 7. Phasing (verify each on hardware)

- **Phase 1 — device library + push.** Device `/lib/` storage + `LIBRARY_UPSERT`; app
  pushes all patterns on connect. Verify the device stores/overwrites by name and
  survives reboot. (Also unlocks offline button next-pattern.)
- **Phase 2 — pull.** `LIBRARY_DUMP_CTRL/DATA`; app pulls device-only patterns and
  merges (app-wins). Verify a device-only pattern shows up in the app.
- **Phase 3 — propagate.** New app patterns push to all connected devices; loop guards.
- **Phase 4 — manifest-diff optimization.**

## 8. Risks / watch-list

- **Connect-time BLE load** — the danger zone. Keep bulk sync off the critical path,
  pull-model, `bleSerial`-serialized, and consider throttling.
- **Flash storage** — cap pattern count/size; batch manifest writes; do library writes
  on the loop task (never the BLE host task — that's what bit device-name persistence).
- **Name extraction** correctness from msgpack on the device.
- **Feedback loops** in propagation — idempotent upsert + "seen" guard.
- **Library vs current-pattern** kept distinct.
- **Offline behavior** — with a device library, button next-pattern can cycle locally.

## 9. Touch points
- Firmware: `esp32/src/main.cpp` (LIBRARY_* characteristics, loop-task upsert/dump,
  `extractPatternName`), `pattern_renderer_base.cpp` (msgpack name parse), new `/lib/`
  storage helpers.
- App: `src/lib/ble.ts` (LIBRARY_* read/write/notify, push/pull helpers),
  `src/lib/stores/patternsStore.ts` (`hasPattern`/`upsertPattern`),
  `src/routes/devices/+page.svelte` (drive push/pull in `initConnectedDevice`,
  propagation).
