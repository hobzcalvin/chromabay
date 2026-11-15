# Experimental channels

Try a branch's app and firmware on real devices without building anything, and go back to
main the same way.

## Make a branch a channel

Add `experimental.json` at the repo root of the branch:

```json
{ "id": "audio", "title": "Audio reactivity", "description": "One line for the switcher", "firmware": true }
```

- `id` is the URL slug ([a-z0-9-], at most 32 characters) and must be unique among live channels.
- `"firmware": false` publishes only the app.

Every push to that branch runs `.github/workflows/experimental.yml`. It calls the normal
release workflows (`deploy.yml` and `esp32-release.yml`) with the channel's id, so the build is
the same as a main release, signed the same way. It publishes to gh-pages:

| Path | What |
|---|---|
| `x/<id>/` | the web app, built with base path `/x/<id>` |
| `x/<id>/version.json` + `live-update-*.zip` | the iOS live-update bundle for the channel |
| `x/<id>/firmware/esp32/…` | firmware registry, OTA images and USB manifest (newest 3 builds kept) |
| `x/channels.json` | every live channel, read by the app's switcher |

Version numbers carry the id: the app is `1.2.<build>-<id>` and the firmware is
`fwv0.1.<build>-<id>`.

Deleting the branch removes its entry from `x/channels.json` and deletes `x/<id>/`. That
cleanup runs from the default branch's copy of the workflow, so it only works once
`experimental.yml` is on main.

Never merge `experimental.json` to main; the workflow ignores main anyway.

## Switch the app

- **Settings → App build** lists Main and every live channel. Tap **Switch**.
  - On the web: you go to `chromabay.app/x/<id>/`. It is the same site, so your patterns,
    settings and sign-in come along. You can also open that URL directly or bookmark it.
  - In the iOS app: it downloads the channel's live-update bundle and restarts into it. It then
    follows that channel's updates until you switch back.
- While on a channel, a yellow 🧪 banner at the top says which one. Tap it to get back to
  Settings.
- **Main** in the same list goes back. On iOS, if main's bundle can't be downloaded, the app
  resets to the build the App Store installed.

## Switch firmware

On **Devices → (device) → Firmware Update**, the **Build** menu picks which channel's firmware
to offer. It defaults to the app's own channel. Pick one and press Update: any version other
than the installed one is offered, so going back to main is just choosing **Main** and
updating. The note under the menu says which build the device runs now.

USB flashing and WLED conversion use the same choice.

## Caveats

- Patterns are shared between channels (same storage, same account). Patterns that use a
  channel's new features may not work in main: an audio automation shape shows up unnamed there,
  and older firmware treats it as "hold at Min".
- The channel switcher and the firmware **Build** menu are themselves new. Until they are
  merged to main, the way into a channel from main is the URL (web), and the way back on iOS is
  the switcher inside the channel build.
