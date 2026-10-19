import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no types
import { renderDossier, deviceTimeline } from '../../../scripts/sentry-triage.mjs';

const diag = { id: 'a1b2c3d4e5f6', up: 10000, bri: 0, bri_pending: 0, pattern: 'Fire', events: [[9000, 'bri rx 80'], [9001, 'bri set 80'], [9500, 'pat rx 300B']] };
const report = {
  issueId: '123',
  event: {
    dateCreated: '2026-10-19T20:00:00.000Z', eventID: 'e1', projectID: '1',
    contexts: { feedback: { message: 'Slider stopped working after I opened Patterns', replay_id: 'r1', url: 'https://chromabay.app/devices' }, trace: { trace_id: 't1' } },
    entries: [{ type: 'breadcrumbs', data: { values: [{ timestamp: '2026-10-19T19:59:58.000Z', category: 'ble', level: 'info', message: 'brightness gesture', data: { first: 10, last: 80, writes: 12 } }] } }],
  },
  tags: { environment: 'web', release: 'app1.2.3' },
  deviceIds: ['a1b2c3d4e5f6'], trace: 't1', window: { start: 's', end: 'e' },
  attachments: [
    { name: 'app-state.json', text: JSON.stringify({ at: '2026-10-19T20:00:00.000Z', route: '/devices' }) },
    { name: 'device-a1b2c3d4e5f6.json', text: JSON.stringify({ device: { name: 'Lamp', device_id: 'a1b2c3d4e5f6', fw: 'fwv0.1.200' }, diagnostics: diag }) },
  ],
  appLogs: [{ timestamp: '2026-10-19T19:59:58.000Z', severity: 'info', message: 'brightness gesture' }],
  deviceLogs: { error: 'device logs: HTTP 403' },
  appErrors: [], deviceEvents: [],
};

describe('triage dossier', () => {
  it('puts device events on the report clock', () => {
    const t = deviceTimeline(diag, '2026-10-19T20:00:00.000Z');
    expect(t[0]).toEqual({ at: '2026-10-19T19:59:59.000Z', ms: 9000, text: 'bri rx 80' });
  });
  it('renders both sides, links, and says what could not be fetched', () => {
    const md = renderDossier(report);
    expect(md).toContain('> Slider stopped working after I opened Patterns');
    expect(md).toContain('/replays/r1/');
    expect(md).toContain('### Lamp (a1b2c3d4e5f6, fwv0.1.200');
    expect(md).toContain('19:59:59.000  +    9000 ms  bri rx 80');
    expect(md).toContain('brightness gesture');
    expect(md).toContain('_unavailable: device logs: HTTP 403_');
  });
});
