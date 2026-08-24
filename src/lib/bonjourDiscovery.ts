import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle
} from '@capacitor/core';

export type BonjourDevice = {
  name: string;
  host: string;
  port: number;
};

type DevicesPayload = { devices: BonjourDevice[] };
type ErrorPayload = { message: string };

interface BonjourDiscoveryPlugin {
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  getDevices(): Promise<DevicesPayload>;
  addListener(
    eventName: 'devicesChanged',
    listener: (payload: DevicesPayload) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'discoveryError',
    listener: (payload: ErrorPayload) => void
  ): Promise<PluginListenerHandle>;
}

const BonjourDiscovery = registerPlugin<BonjourDiscoveryPlugin>('BonjourDiscovery');

/**
 * Browse the iPhone's current LAN for ChromaBay's `_chromabay._tcp` service.
 * Browsers cannot browse mDNS, so non-iOS callers get an inert cleanup function.
 */
export async function watchBonjourDevices(
  onDevices: (devices: BonjourDevice[]) => void,
  onError: (message: string) => void
): Promise<() => Promise<void>> {
  if (
    Capacitor.getPlatform() !== 'ios'
    || !Capacitor.isPluginAvailable('BonjourDiscovery')
  ) return async () => {};

  const devicesListener = await BonjourDiscovery.addListener(
    'devicesChanged',
    ({ devices }) => onDevices(devices)
  );
  const errorListener = await BonjourDiscovery.addListener(
    'discoveryError',
    ({ message }) => onError(message)
  );

  try {
    await BonjourDiscovery.startDiscovery();
    onDevices((await BonjourDiscovery.getDevices()).devices);
  } catch (error) {
    await devicesListener.remove();
    await errorListener.remove();
    throw error;
  }

  return async () => {
    await devicesListener.remove();
    await errorListener.remove();
    await BonjourDiscovery.stopDiscovery().catch(() => { /* plugin/app already stopped */ });
  };
}
