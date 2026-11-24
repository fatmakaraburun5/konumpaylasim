import type { DeviceStatus } from '@konum/core';
import { demoDeviceStatus } from '../../demo/web/device';

/** Web demo: simüle pil (varsayılan %78; demo panelinden değiştirilebilir). */
export async function readDeviceStatus(): Promise<DeviceStatus> {
  return demoDeviceStatus();
}
