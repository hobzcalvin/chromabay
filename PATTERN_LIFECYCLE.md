# Pattern Lifecycle — Scoped Plan (v2)

Status: **DESIGN / PLAN.** Rewritten 2026-07-17 to a deliberately smaller model than the
earlier identity-first plan. Supabase backend + login are already live; the device-side
library + time-synced cycle are already shipped. This doc is the target UX + the identity
rules; it supersedes the earlier device↔device / owner-claim machinery (dropped, see §5–7).

---

## 0. The model in one breath

The app has **two session-wide modes**, and everything is WYSIWYG:

- **Live** — you're driving (Editing or Interacting), and **all connected devices mirror the
  one pattern you're on**. This is design/play time.
- **Cycle** — devices are **playing autonomously**: each runs through *its own on-device
  library*, name-ordered, on the shared clock. The app is hands-off and just shows what's
  playing. "Set them going and walk away."

A device is never half-in: **all connected devices share the current mode.** You connect to
the set you want to drive together. Entering Edit/Interact (or tapping/selecting/interacting/
editing any pattern) **turns Cycle off on every device**, so what you see is what's shown.

A pattern reaches a device two ways: **transient preview** (Live mode mirrors the current
pattern — not persisted) vs. **explicit sync** (you push it into a device's library, where it
persists and becomes part of that device's cycle). Trying the Test pattern once must NOT
pollute a device's cycle — only an explicit sync does.

---

## 1. The Patterns page

The **Cycle control lives at the top, always visible** (even with 0 devices connected). While
Cycle is ON, the pattern lists below are **dimmed** to signal "selecting/editing doesn't apply
right now" — but they stay interactive; tapping/interacting/editing any pattern (or switching
to the Edit/Interact nav tabs) simply **turns Cycle off** and does the thing.

Sections, top to bottom:

1. **My Patterns** — the set saved locally and/or online (your library). May or may not match
   what's on connected devices (a pattern can be "0 synced"). Per-pattern buttons:
   - **`N Synced`** — a combined **indicator + button**: shows how many connected devices
     currently have this pattern; tapping it syncs it to *all* connected devices (count → all).
   - **Interact (🖐️)**, **Edit (✏️)**.
   - **Delete (🗑️)** — deletes from your library **and from all devices**.
   - UI is crowded → **two rows** of buttons, **less padding** around text/emoji.

2. **New From Devices** *(only if any)* — patterns found on connected devices that are **not in
   My Patterns**. Browse/adopt surface, not auto-sync. Only button: **Import** → copies to My
   Patterns, syncs to all connected devices, selects it as current, view jumps to its new home.
   *Bonus:* animate the block sliding from here to its spot in My Patterns as we follow it. Once
   imported it leaves New From Devices.

3. **Per Device** *(collapsed by default)* — expand to a sub-list per device showing exactly
   what's on each (lots of repeats: A: p1,p2,p3; B: p1,p3,p4…). Where you **remove a pattern
   from one specific device** (Trash here = that device only). Each block shows standard
   Interact/Edit/Trash, or **Import** if the pattern lives only on the device. Also how you
   re-adopt a pattern you deleted from My Patterns but still have on a device.

4. **Online Patterns** — patterns **not** in My Patterns, sorted by upvotes. Same **Import**
   button. (Starter pack / discovery; `GalleryModal` is the seed.)

---

## 2. What is a pattern? (identity)

- **Identity is `(author, stableId)`, not the name.** Name = human handle; `updatedAt` orders
  versions. This makes the two scary cases behave:
  - *Tweak params, then connect a device with the older version* → **same pattern** (same id);
    last-writer-wins by `updatedAt`, the device gets your newer version on connect. Never "two
    patterns," because identity isn't the name or the content.
  - *Rename* → same id, so it never orphans/duplicates.
- **Editing edits it everywhere it lives.** Disconnected devices miss it; they get it
  automatically on reconnect. The online copy updates too (if you're the author).
- **Importing + tweaking params does NOT make you the author.** Import = a locally editable copy
  still owned by its author; your tweaks stay on your library + your devices and do **not**
  rewrite the author's online version. You become author **only** by renaming or explicit copy —
  which forks a new `(you, newId)` you can publish.
- **Online dedup is by `(author, name)`**, not global name (two people can both have a "Fire").

Interim shortcut for local-only work: *a name is a name.* But the id+author model is what the
sync/online path needs, and it's small.

---

## 3. Cycle mechanics (mostly shipped)

- Each device cycles **its own stored library, sorted by name**, on the **synced clock**
  (`setCycleOnDevice`, PLAYLIST_SYNC — implemented; firmware needs flashing).
- **Cross-device sync is emergent, not engineered:** same library + name-order + shared clock →
  devices step together; different libraries → different shows, by design. No explicit
  multi-device coordination.
- The app can **compute** which pattern each device shows now/next from (its library + clock),
  so a cycling device is never a black box.
- **Deferred:** curated drag-ordered **Playlist** w/ per-item durations + a **Shuffle** option
  (à la Pixelblaze Playlist vs Shuffle-All). For now Cycle = whole library, alphabetical.

---

## 4. Nav / modes (done 2026-07-17)

Bottom nav restored to **Devices · Patterns · Interact · Edit · Account**. The per-pattern and
editor "interact" affordance is the **🖐️** hand (matching the interactive-param hand on the
Interact page), not the old 🎛️ knob. Entering Edit/Interact must switch all devices out of
Cycle (§0).

---

## 5–7. Kept / dropped

**Kept:** device on-board library as the per-device source of truth; From Devices browse+adopt;
live-preview of the current pattern; time-synced cycle; optional account (cross-client keyring +
gallery backing); stable pattern id + author for sync/online.

**Dropped / deferred:** device→device & person→person BLE sharing; the owner-*claim* firmware
gating; global-name dedup; flag-deleted tombstone bookkeeping for the local case (recover a
deleted pattern from a device via Import).

---

## 8. Suggested build phases

1. **Nav + 🖐️** — DONE.
2. **Cycle WYSIWYG** — Cycle control always atop Patterns; auto-off on select/interact/edit and
   on Edit/Interact nav; dim lists while on. (Small, mostly app-side.)
3. **Sync button + delete-everywhere** — per-pattern `N Synced` (indicator+action, from pulled
   device libraries); Delete = library + all devices. Two-row, low-padding buttons.
4. **Sections** — My Patterns / New From Devices / Per Device (collapsible) / Online; Import flow
   (+ slide animation bonus).
5. **Identity** — stable `id` + `author` + `updatedAt` on `SerializedPattern.meta`;
   last-writer-wins sync over BLE + cloud; rename/copy = fork.
