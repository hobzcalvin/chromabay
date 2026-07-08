# Pattern Lifecycle — Unified Plan

Status: **DESIGN / PLAN.** Supersedes the *model* in `docs/PATTERN_LIFECYCLE_PLAN.md`;
that doc's BLE push/pull mechanics remain the transport layer for Phase 1.

Covers: local ownership (the 90% case), device→device and person→person sharing,
cross-client identity (web + iOS), internet pattern sharing (a gallery), deletion
semantics, and time-synced cycling.

---

## 0. TL;DR — the one insight

Everything you asked for is a **consequence of identity**. Today a pattern *is* its
name; a device is owned by "whoever is looking at it"; you-on-web and you-on-iOS are
strangers. Fix identity and the rest collapses into one small set of mechanisms:

- **Pattern identity** = a stable `id` (+ `updatedAt` + a `deleted` flag). → renames stop
  duplicating, deletes propagate safely, sync/dedup stops being a name hack. (Content-hash
  + lineage for the internet "which one is true?" problem are **gallery-only**, deferred.)
- **Owner identity** = a *claim*: the key a client holds when it first connects is stored
  in the device's owner set and gated in firmware. → "first connector owns it," strangers
  get read-only, no UI-only fake security.
- **User identity** = an **optional** account that is just a *synced keyring* of your
  owner-keys + library. → logging in on any client gives you all your devices, everywhere;
  the *same* account backs the gallery. **Local-first works with zero account;** the
  account only unlocks cross-client ownership and the online features.

One sync algorithm (last-writer-wins by `id`/`updatedAt`, with tombstones) runs over both
BLE and the cloud. One lightweight ownership check (the client's key is in the device's
owner set) gates privileged writes. That's the whole design.

---

## 1. Current state & the core constraint

- `SerializedPattern.meta` is just `{ name?, output }`. **No id, rev, author, or time.**
- `patternsStore` keys everything off `meta.name` (`findIndex(p => p.meta.name === …)`).
- Device library (shipped) upserts **by name**; delete is **by name**.
- Playlist (shipped, unflashed) sends **full blobs per slot**, not references.

Consequences we have to live with until fixed: renaming = orphaned duplicate; two people
with a "Rainbow" can't both exist; you can't tell "the app already has this" without a
name match; a delete can't safely propagate (an offline device re-seeds it on next pull —
the classic distributed **resurrection bug**).

---

## 2. Identity model (the spine)

**Do NOT front-load the full schema.** The local/device experience needs only three new
fields; everything else is gallery-only and gets added in Phase 4.

### Minimum viable identity (Phase 0 — add now)

```jsonc
"meta": {
  "id":        "p_9f3a…",      // UUID, minted once at creation, NEVER changes
  "updatedAt": 1713247890,     // LWW clock: which copy is newer
  "deleted":   false,          // tombstone flag (see §8)
  "name":      "Rainbow Fade", // display only; may change freely without a new id
  "output":    1
}
```

- **`id`** is the durable handle. Overwrite/upsert/delete/playlist all key off `id`, not
  name. Renaming touches `name` + `updatedAt` only → no more orphaned duplicates.
- **`updatedAt`** is the last-writer-wins clock for sync (§3).
- **`deleted`** makes a delete a *record*, not a removal → it can propagate safely (§8).

That trio delivers everything you asked for locally: dup-free renames, delete-off-all-
devices, clean sync, id-based playlists. It's a schema bump + a one-time migration (on
store load, any pattern without `id` gets a fresh UUID + `updatedAt`).

### Gallery-only identity (Phase 4 — add when you build the gallery, not before)

`contentHash` (hash-dedup + "did it really change?"), `author` (attribution), and
`forkedFrom`/lineage (version history, remix credit) are needed **only** by the online
gallery. They never touch the phone or device. Deferring them keeps the fork-graph
complexity out of the 90% of the product that doesn't need it — you can even ship the
gallery without them (a dumb snapshot store) and add them later.

---

## 3. Sync model — one algorithm everywhere

Treat the library as a set of records synced by **last-writer-wins per `id`, with
tombstones**. This same routine runs app↔device (BLE) and app↔cloud (HTTPS):

1. **Exchange manifests:** each side sends `[{id, updatedAt, deleted}]` (tiny — no blobs).
2. **Diff:** transfer only records the other side lacks or has an older `updatedAt` for.
3. **Apply LWW:** newer `updatedAt` wins; equal = no-op (converged).
4. **Tombstones:** a delete is a record with `deleted:true` + bumped `updatedAt`, not a
   removal. It propagates like any change; a peer with an older live copy deletes it.
   Tombstones are GC'd after a grace window (e.g. 30 days) once all a user's devices have
   seen them.

Why this matters: it kills the resurrection bug, makes propagation loop-free (idempotent
by `id` — no more "seen" set), and gives us **one** mental model instead of separate
ad-hoc rules for device sync vs. cloud sync. "App-wins for my own devices" is just a
special case: for devices you own, the app is authoritative, so it always pushes and its
copy wins.

---

## 4. Ownership model

Goal: *you* control your devices' patterns/settings/OTA; strangers can look and borrow but
not change. Enforced **in firmware**, not just hidden in the UI.

### Primitive
- Every client has an **identity keypair** (ECDSA P-256 — we already ship PSA crypto on
  the ESP32 for OTA signature verification; reuse it, no new crypto stack).
- A device stores a small **owner set**: a list of authorised owner public keys (allow
  several, so your web + iOS + a deputised friend can each be an owner).

### Claim (first connect)
- **Virgin device** (empty owner set) → connecting client offers "Claim this device" →
  writes its owner pubkey. Now owned. This is "if you connected first, it's yours."

### Enforcement (lightweight — chosen over full challenge-response)
- Owner-only ops: settings, OTA flash, library `UPSERT`/`DELETE`, playlist push, layout.
- The client presents its owner key; firmware checks it's in the owner set before honouring
  a privileged write. Read ops (deviceInfo, library dump, live pattern mirror) are open to
  anyone. (A signed nonce-challenge is a later hardening step if devices end up in public
  installs; for a home LED product, "holds a key in the owner set" is enough.)
- A non-owner's write is **rejected by the device** — the app also greys the controls, but
  the device is the real gate.

### Cross-client — the account is a synced keyring (your model)
- Each client generates a local key. **Claiming a device records that key as an owner** —
  that client now owns it.
- **The account is just a synced keyring** (your owner-keys + your library). Log in on any
  client → it pulls down every device key you hold → you own all your devices, everywhere.
  It works **retroactively**: claim while logged out, log in later, that key is backed up
  and propagated. No per-client blessing, no nonce dance — logging in *is* the mechanism.
- No account = single-client ownership (fine for one person, one phone). To own from a
  second client without an account, re-claim it via the power-on window below.

### Claim / re-claim / reset (no hardware button assumed)
- **Unclaimed device** (empty owner set): claimable **anytime** by the first client that
  connects (first-come = owner).
- **Already-owned device**: accepts a *re-claim* (adds/replaces the owner key) **only in the
  first ~15 s after power-on** — firmware just gates on `millis() < 15000`. This is the
  presence proof that replaces a physical button: whoever can power-cycle it can re-own it.
- That same window is the **reset/transfer** path — lost your key, or got a hand-me-down
  device? Power-cycle, connect fast, re-claim. Physical/power access = ultimate authority.
  Correct for a consumer LED product; do **not** over-secure it.

---

## 5. Owning your own devices (the 90% case)

This is Phase 1 and should feel invisible:
- On connect to a device you own, the app **pushes its full library** (LWW, app-wins) so
  every device mirrors your patterns; tweaks to a same-`id` pattern overwrite the device
  copy. (Existing `docs/PATTERN_LIFECYCLE_PLAN.md` transport, upgraded name→id+rev.)
- Bulk sync stays **off the connect critical path** (device usable first, sync in the
  background, `bleSerial`-serialised, manifest-diff so only deltas move). This is the known
  BLE danger zone — treat it with the same care as the config/name-persistence races.

---

## 6. Sharing between devices / people

- Connect to a device you **don't** own → it serves its library **read-only**.
- Pulled foreign patterns land on a separate **"From this device" shelf** — *not* your
  library, *not* auto-pushed to your own devices, *not* persisted unless you adopt them.
- **Adopt = "Save a Copy":** copying a foreign pattern into your library mints it a **new
  `id`**. You now own your copy; the original is untouched, and your later edits never
  pretend to be the origin's. (Once the gallery exists, also stamp `forkedFrom` for remix
  credit — but the local behaviour needs nothing more than a new id.)
- This cleanly separates "I'm browsing someone's device" from "this is mine now."

---

## 7. Internet sharing — the gallery

A `patterns.chromabay.app`-style gallery: publish, browse, search, upvote, one-tap import.

### Backend (cheap, low-ops)
- **Recommended: Supabase** (Postgres + object storage + Auth + row-level security, generous
  free tier). Its Auth *is* the cross-client account from §4/§2 — one dependency solves
  identity, ownership-sync, and the gallery.
- **Alt: Cloudflare Workers + D1 + R2** (cheapest at scale, edge) if you'd rather bring your
  own auth. Either is fine; patterns are <300 B and previews are small, so cost is trivial.

### "Which version is true?" — content-address + lineage
There is deliberately **no single true version**. Instead:
- A published pattern is an **immutable snapshot** addressed by `contentHash`. Re-uploading
  identical bytes = the same object (dedup, no clutter).
- An edit publishes a **new version** linked by lineage (same root `id`, new `rev`/hash,
  `parent` pointer). The gallery shows a version history; **"canonical" = the author's
  latest** (or highest-voted), a social signal, not a hard truth.
- Someone else's fork gets its **own `id`** and records ancestry → a **fork/remix graph**
  (Thingiverse/GitHub model). Upvotes attach to the **lineage root**, so votes accrue
  across versions and forks credit their parent.

### Killer feature we already have
Auto-generate each gallery entry's **preview thumbnail/GIF from the WASM render engine** —
the same operators run in the browser, so listings show the actual animation with zero
extra art pipeline.

### Safety (a real advantage over Pixelblaze)
ChromaBay patterns are **declarative data (a node graph), not code**. Importing a stranger's
pattern can't execute anything — unlike Pixelblaze's JS patterns. The moderation surface is
tiny: name/thumbnail abuse + a report/flag queue. Worth leaning on in messaging.

---

## 8. Deletion semantics

- **Delete a pattern you own, in the app** → mark a **tombstone** (`deleted:true`, `rev++`),
  remove locally, and propagate to **devices you own** via §3 (immediately if connected,
  else on next connect — the tombstone guarantees it eventually deletes and won't
  resurrect). This is the "delete off all devices too" you want, done safely.
- Only delete the copy that traces to that **`id`** — never nuke a device-local pattern that
  merely shares a name.
- **Foreign/adopted-then-unwanted** patterns: deleting removes them from your shelf/library
  only; never touches the source device or the gallery.
- **Gallery**: unpublish hides a version; forks already made by others survive (they're
  independent ids). Immutable snapshots aren't hard-deleted, they're delisted.

---

## 9. Cycling / playlist (all devices, same pattern, same instant)

We already have firmware-driven, BLE-clock-synced cycling (`PLAYLIST_SYNC`, persistent,
survives app disconnect — see `pattern-cycling-playlist`). Upgrade it onto the new model:
- Playlist becomes an ordered list of **pattern `id`s + interval**, not inline blobs — the
  device already holds the patterns in its library (§5), so the playlist is tiny.
- Lockstep switching needs three things, all of which the model now provides: same
  **library** (sync), same **clock** (existing timestamp sync), same **playlist** (owner
  pushes to all owned devices at once). `index = (syncedTime / interval) % count`.
- Cross-owner "join my show" (a friend's device in your sequence) is out of scope for v1
  but the id-based playlist doesn't preclude it later.

---

## 10. Phasing (each phase ships value; verify BLE-heavy ones on hardware)

- **Phase 0 — Identity retrofit.** Add `id/rev/contentHash/author/lineage` to `meta`;
  migrate existing patterns; switch store + device library + playlist from name→id. Purely
  app-side + a firmware field; no new UX. *Unblocks everything.*
- **Phase 1 — Own-device sync, done right.** id+rev+tombstone LWW over the existing
  push/pull BLE transport. The invisible 90% case. (HW-verify: bulk sync off critical path.)
- **Phase 2 — Ownership.** Keypair claim + firmware challenge-response + read-only for
  non-owners + physical-presence claim + factory reset. (Reuse PSA ECDSA.)
- **Phase 3 — Borrow/adopt.** Foreign-pattern shelf + adopt-as-fork.
- **Phase 4 — Cloud + gallery.** Account (Supabase Auth), publish/browse/upvote,
  content-address + lineage, WASM-rendered previews, one-tap import. Account also syncs your
  owner key → cross-client ownership "just works."
- **Phase 5 — Show coordination.** id-based playlist pushed to all owned devices; polish
  multi-device lockstep cycling on hardware.

---

## 11. Decisions (resolved 2026-07-07)

1. **Account: OPTIONAL, local-first.** ✅ The account is a synced keyring (§4); logging in
   propagates your owner-keys to every client. No account = single-client ownership.
2. **Ownership: LIGHTWEIGHT.** ✅ "Client holds a key in the device's owner set" gates
   privileged ops; no button (power-on re-claim window instead, §4). Signed nonce-challenge
   is a deferred hardening step only if devices land in public installs.
3. **Adopt = NEW id** ("Save a Copy"). ✅ No shared-id/merge complexity.
4. **Backend: SUPABASE.** ✅ Its Auth doubles as the account/keyring store.
5. **Metadata: MINIMAL now.** ✅ Ship only `id`+`updatedAt`+`deleted` (§2); defer
   `contentHash`/`author`/lineage to the gallery phase.

### Still open (decide when you reach the gallery, Phase 4)
- **Gallery canonical-version policy:** author's-latest vs. highest-voted as the default
  surfaced version. (No need to decide until the gallery exists — or ship the gallery as a
  dumb snapshot store with no versioning at all and revisit.)
```
