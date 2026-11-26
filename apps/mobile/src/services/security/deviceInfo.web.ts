/** Web demo: "telefon" = bu tarayıcı (kurulum kimliği + model demo oturumunda; "Yeni telefona geç" yeniler). */
import type { DeviceInfo } from '@konum/core';
import { demoInstall } from '../../demo/web/session';

export async function currentDeviceInfo(): Promise<DeviceInfo> {
  const d = demoInstall();
  return { install_id: d.id, platform: 'ios', model: d.model, os_version: '18.1', app_version: 'demo' };
}
