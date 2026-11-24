/**
 * Web demo: konum izinleri SİMÜLE edilir (tarayıcı konumu İSTENMEZ; konum demo/web/device.ts'teki simüle telefondur).
 * Durumlar `demo/web/permissions.ts`'te: varsayılan her şey verilmiş; demo panelindeki "İzin akışını baştan göster"
 * ilk kurulum durumuna döner ve istekler telefon çerçevesinde iOS benzeri sistem penceresi açar.
 * Native `locationPermissions.ts` ile aynı dışa aktarımlar ve aynı yanıt biçimi (`ios.scope`, `ios.accuracy`).
 */
import type { LocationPermissionResponse } from 'expo-location';
import { demoCanAsk, demoPerms, requestDemoPermission, type DemoPermStatus } from '../../demo/web/permissions';

function response(status: DemoPermStatus, canAskAgain: boolean): LocationPermissionResponse {
  const p = demoPerms();
  const granted = status === 'granted';
  return {
    status,
    granted,
    canAskAgain,
    expires: 'never',
    ios: granted ? { scope: p.background === 'granted' ? 'always' : 'whenInUse', accuracy: p.precise ? 'full' : 'reduced' } : undefined,
  } as unknown as LocationPermissionResponse;
}

const foreground = () => response(demoPerms().foreground, demoCanAsk('foreground'));
// iOS: "Her Zaman" yalnızca "Kullanırken" verildiyse anlamlıdır.
const background = () => {
  const p = demoPerms();
  return response(p.foreground === 'granted' ? p.background : 'undetermined', p.foreground === 'granted' ? demoCanAsk('background') : true);
};

export const getForegroundPermissionsAsync = async (): Promise<LocationPermissionResponse> => foreground();
export const getBackgroundPermissionsAsync = async (): Promise<LocationPermissionResponse> => background();
export const requestForegroundPermissionsAsync = async (): Promise<LocationPermissionResponse> => {
  await requestDemoPermission('foreground');
  return foreground();
};
export const requestBackgroundPermissionsAsync = async (): Promise<LocationPermissionResponse> => {
  await requestDemoPermission('background');
  return background();
};
