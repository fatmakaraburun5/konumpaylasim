/**
 * Faz 10: `device_register` için cihaz bilgisi. Kurulum kimliği Faz 6 `konum.device.id.v1` (hesaptan bağımsız,
 * çıkışta silinmez); model adı kaba (`expo-device` eklenmedi [Varsayım]: iOS'ta "iPhone", Android'de üretici modeli).
 * Web demosu aynı adla `deviceInfo.web.ts` sağlar.
 */
import type { DeviceInfo } from '@konum/core';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { getDeviceId } from '../widgets/deviceId';

export async function currentDeviceInfo(): Promise<DeviceInfo> {
  const c = (Platform.constants ?? {}) as { Model?: string; Manufacturer?: string; Brand?: string };
  const android = [c.Brand ?? c.Manufacturer, c.Model].filter(Boolean).join(' ');
  const isPad = Platform.OS === 'ios' && (Platform as { isPad?: boolean }).isPad === true;
  return {
    install_id: await getDeviceId(),
    platform: Platform.OS === 'android' ? 'android' : 'ios',
    model: Platform.OS === 'android' ? android || 'Android telefon' : isPad ? 'iPad' : 'iPhone',
    os_version: String(Platform.Version ?? '') || null,
    app_version: Constants.expoConfig?.version ?? null,
  };
}
