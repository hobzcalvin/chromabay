# Problem reports

"Something weird just happened": a report that carries what the app *and* the devices were doing
at that moment, and a dossier that puts both sides on one timeline for whoever (or whatever)
looks into it.

## Filing one

- **Settings → Help → Report a problem**, or **Cmd/Ctrl+Shift+B** anywhere in the web app.
- Sentry's feedback form opens (`src/lib/feedback.ts`). Say what happened and what you expected.
  The form can attach a screenshot.

## What a report carries

| From | What | Where it comes from |
|---|---|---|
| App | The session replay (every session is recorded, `hooks.client.ts`) | Sentry Replay |
| App | Breadcrumbs (the last 200): navigation, console, and BLE events (connects and drops, pattern pushes, **brightness gestures**, brightness pushed by the device) | `src/lib/telemetry.ts` |
| App | `app-state.json`: route, connected devices (name, `device_id`, firmware, chip, transport) | `feedback.ts` |
| Device | `device-<id>.json`: the device's **DIAGNOSTICS** (firmware feat ≥ 7), read when the form opens: state (brightness, pending writes, pattern, cycling, clock sync, streaming, sleep/schedule, OTA, heap) and its last 40 events with millisecond timestamps | `esp32/src/diag_log.h`, `onDiagnosticsRead` in `main.cpp` |
| Both | Tags `device_id` / `device_ids`, which the device's own Sentry events also carry (the factory MAC), and the trace the app hands the device on each connection | `telemetry.ts`, sentry-micro |

A brightness *gesture* is one slider drag: the first and last value, how many writes went out and
how many failed, and how long it took. The slider writes every 40 ms, so the individual writes
aren't logged. On the device the same drag shows up as `bri rx N` (received) and `bri set N`
(applied) events. So for "the slider stopped working", the report shows whether writes left the
app, reached the device, and were applied.

The device's event ring records, among others:
- `ble connect/disconnect`
- `bri rx/set`
- `pat rx`, `pat show/FAIL`
- `lib ok/FAIL`
- `ts sync`
- `cycle on/off` and `cycle ->`
- `ledcfg`, `rename`
- `ota start/ok/abort`
- `blink`, `calib`
- `sched on/off`, `sleep`, `wake`
- `stream on`
- `button single/double`
- `comm -> wifi`
- `boot ok`

## Triage

```sh
export SENTRY_TRIAGE_TOKEN=...            # Sentry token: org:read, project:read, event:read (+ event:write for --comment)
npm run triage -- --list                  # recent reports
npm run triage -- --issue <issue id>      # triage/<id>.md (+ .json): the dossier
npm run triage -- --comment <id> notes.md # post findings onto the report in Sentry
```

The dossier (`scripts/sentry-triage.mjs`) has:
- the person's words and links to the report, its replay and its trace;
- each device's state, plus its events placed on the report's clock;
- the app's breadcrumbs, the app's and the device's logs in the 15 minutes before the report
  (joined on the shared trace and `device_id`);
- errors from both projects in that window;
- the app state.

Anything it couldn't fetch is named in place, rather than left out.

**Reports stay private.** They contain people's words, device ids and app state. This
repository is public, so dossiers live in the gitignored `triage/` and findings go back onto the
report in Sentry. They are never posted in GitHub issues or CI logs.

### Automatic triage

A scheduled Claude routine (private to the account that owns it, not GitHub Actions) can:
1. run `npm run triage -- --list` for reports without a triage comment;
2. build each dossier;
3. investigate it against the code;
4. post its findings with `--comment`.

It needs `SENTRY_TRIAGE_TOKEN` in the routine's environment.
