/**
 * "Report a problem": Sentry's feedback form, with the device side of the story attached.
 *
 * Opening it reads DIAGNOSTICS from every connected device first (firmware feat >= 7: its state
 * and its last ~40 events, millis()-stamped) and attaches that, plus a snapshot of the app's own
 * state, to the report. Sentry adds the rest: the session replay (sampled at 100%, see
 * hooks.client.ts), breadcrumbs (BLE traffic from telemetry.ts included) and an optional
 * screenshot. The report is tagged with the devices' `device_id`, which their own Sentry events
 * carry too, so scripts/sentry-triage.mjs can pull both sides of the same minutes together.
 */
import * as Sentry from '@sentry/sveltekit';
import { readDeviceDiagnostics } from './ble';
import { deviceSummary, flushGestures, bleEvent } from './telemetry';

const DIAG_TIMEOUT_MS = 4000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** The app's half of the snapshot: where it is and what it thinks the devices are doing. */
function appState(): Record<string, unknown> {
  return {
    at: new Date().toISOString(),
    route: location.pathname + location.hash,
    online: navigator.onLine,
    userAgent: navigator.userAgent,
    devices: deviceSummary(),
  };
}

let open = false;

/** Open the report form. Safe to call repeatedly; a second call while open is ignored. */
export async function openProblemReport(): Promise<void> {
  if (open) return;
  const feedback = Sentry.getFeedback();
  if (!feedback) { alert('Problem reports need Sentry, which is not running in this build.'); return; }
  open = true;
  flushGestures(); // a drag still in progress belongs in this report's breadcrumbs

  const devices = deviceSummary();
  const diags = await Promise.all(devices.map(async (d) => ({
    device: d,
    diagnostics: (d.feat ?? 0) >= 7 ? await withTimeout(readDeviceDiagnostics(d.ble_id), DIAG_TIMEOUT_MS) : null,
  })));
  bleEvent('problem report opened', { devices: devices.length, with_diagnostics: diags.filter((x) => x.diagnostics).length });

  const scope = Sentry.getCurrentScope();
  scope.clearAttachments();
  scope.addAttachment({ filename: 'app-state.json', data: JSON.stringify(appState(), null, 2), contentType: 'application/json' });
  for (const { device, diagnostics } of diags) {
    scope.addAttachment({
      filename: `device-${device.device_id ?? device.ble_id}.json`,
      data: JSON.stringify({ device, diagnostics, note: diagnostics ? undefined : 'no diagnostics (firmware before feat 7, or the read failed)' }, null, 2),
      contentType: 'application/json',
    });
  }
  const ids = devices.map((d) => d.device_id).filter(Boolean) as string[];

  const done = () => {
    open = false;
    // Attachments live on the scope; drop them once the report has gone, so they don't ride
    // on unrelated events. Delayed: the form closes as the event is still being assembled.
    setTimeout(() => scope.clearAttachments(), 10000);
  };
  try {
    const form = await feedback.createForm({
      formTitle: 'Report a problem',
      messagePlaceholder: 'What happened, and what did you expect? (The last few minutes of the app, and what your devices were doing, are attached.)',
      submitButtonLabel: 'Send report',
      successMessageText: 'Thanks — the report and its diagnostics were sent.',
      showName: false,
      showEmail: false,
      enableScreenshot: true,
      tags: {
        report_devices: String(devices.length),
        ...(ids.length ? { device_id: ids[0], device_ids: ids.join(',') } : {}),
      },
      onFormClose: () => { form.removeFromDom(); done(); },
      onSubmitSuccess: (_data, eventId) => bleEvent('problem report sent', { event_id: eventId }, { log: false }),
    });
    form.appendToDom();
    form.open();
  } catch (e) {
    done();
    console.error('[feedback] could not open the report form:', e);
  }
}
