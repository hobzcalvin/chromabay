import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sentry and BLE are mocked: what is under test is what the app hands them.
const crumbs: any[] = [], logs: any[] = [], tags: Record<string, any> = {}, contexts: Record<string, any> = {};
const attachments: any[] = [];
let formOptions: any = null;
const form = { appendToDom: vi.fn(), open: vi.fn(), removeFromDom: vi.fn() };
vi.mock('@sentry/sveltekit', () => ({
  addBreadcrumb: (c: any) => crumbs.push(c),
  logger: { info: (m: string, a: any) => logs.push({ level: 'info', m, a }), warn: (m: string, a: any) => logs.push({ level: 'warn', m, a }), error: (m: string, a: any) => logs.push({ level: 'error', m, a }) },
  setTag: (k: string, v: any) => { tags[k] = v; },
  setContext: (k: string, v: any) => { contexts[k] = v; },
  getCurrentScope: () => ({ clearAttachments: () => attachments.splice(0), addAttachment: (a: any) => attachments.push(a) }),
  getFeedback: () => ({ createForm: async (o: any) => { formOptions = o; return form; } }),
}));
const diag = { id: 'a1b2c3d4e5f6', bri: 80, events: [[100, 'bri rx 80'], [101, 'bri set 80']] };
vi.mock('../ble', () => ({ readDeviceDiagnostics: vi.fn(async () => diag) }));

import { connectedDevices } from '../stores/deviceStore';
import { startDeviceTelemetry, noteBrightnessWrite, flushGestures } from '../telemetry';
import { openProblemReport } from '../feedback';

function connect(id: string, info: any) {
  connectedDevices.update((m) => new Map(m).set(id, { deviceId: id, name: info.name, services: [], deviceInfo: info, lastConnected: 0 }));
}

describe('telemetry', () => {
  beforeEach(() => { crumbs.length = 0; logs.length = 0; connectedDevices.set(new Map()); });

  it('tags events with the device_id the firmware reports', () => {
    startDeviceTelemetry();
    connect('ble-1', { fw_ver: 'fwv0.1.200', hw_ver: 'h', id: 'a1b2c3d4e5f6', name: 'Lamp', feat: 7 });
    expect(tags.device_id).toBe('a1b2c3d4e5f6');
    expect(tags.device_fw).toBe('fwv0.1.200');
    expect(contexts.chromabay_devices.devices[0]).toMatchObject({ name: 'Lamp', device_id: 'a1b2c3d4e5f6' });
    expect(crumbs.some((c) => c.message === 'device connected')).toBe(true);
  });

  it('coalesces a slider drag into one brightness gesture', () => {
    vi.useFakeTimers();
    for (const v of [10, 40, 90, 120]) noteBrightnessWrite('ble-1', v, true);
    noteBrightnessWrite('ble-1', 130, false);
    expect(crumbs.filter((c) => c.message === 'brightness gesture')).toHaveLength(0);
    vi.advanceTimersByTime(700);
    const g = crumbs.filter((c) => c.message === 'brightness gesture');
    expect(g).toHaveLength(1);
    expect(g[0].data).toMatchObject({ first: 10, last: 130, writes: 5, failures: 1 });
    expect(g[0].level).toBe('warning');
    expect(logs.find((l) => l.m === 'brightness gesture')?.level).toBe('warn');
    vi.useRealTimers();
  });

  it('flushes an open gesture when a report is filed', () => {
    noteBrightnessWrite('ble-1', 50, true);
    flushGestures();
    expect(crumbs.filter((c) => c.message === 'brightness gesture')).toHaveLength(1);
  });
});

describe('problem report', () => {
  it('attaches device diagnostics and app state, and tags the report with the device', async () => {
    connectedDevices.set(new Map());
    connect('ble-1', { fw_ver: 'fwv0.1.200', hw_ver: 'h', id: 'a1b2c3d4e5f6', name: 'Lamp', feat: 7 });
    connect('ble-2', { fw_ver: 'fwv0.1.140', hw_ver: 'h', name: 'Old', feat: 6 }); // no diagnostics endpoint
    await openProblemReport();
    expect(form.appendToDom).toHaveBeenCalled();
    expect(form.open).toHaveBeenCalled();
    const names = attachments.map((a) => a.filename);
    expect(names).toEqual(['app-state.json', 'device-a1b2c3d4e5f6.json', 'device-ble-2.json']);
    const lamp = JSON.parse(attachments[1].data);
    expect(lamp.diagnostics.events[0]).toEqual([100, 'bri rx 80']);
    expect(JSON.parse(attachments[2].data).diagnostics).toBeNull();
    expect(JSON.parse(attachments[0].data).devices).toHaveLength(2);
    expect(formOptions.tags).toMatchObject({ device_id: 'a1b2c3d4e5f6', report_devices: '2' });
    formOptions.onFormClose();
    expect(form.removeFromDom).toHaveBeenCalled();
  });
});
