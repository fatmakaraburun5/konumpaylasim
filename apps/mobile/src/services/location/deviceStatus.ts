import type { DeviceStatus } from '@konum/core';
import * as Battery from 'expo-battery';

/** Pil seviyesi (0..1) ve şarj durumu; okunamazsa null (pakette alan atlanır). */
export async function readDeviceStatus(): Promise<DeviceStatus> {
  try {
    const [level, state] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync()]);
    const isCharging =
      state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL
        ? true
        : state === Battery.BatteryState.UNPLUGGED || state === Battery.BatteryState.NOT_CHARGING
          ? false
          : null;
    return { batteryLevel: level >= 0 ? level : null, isCharging };
  } catch {
    return { batteryLevel: null, isCharging: null };
  }
}
