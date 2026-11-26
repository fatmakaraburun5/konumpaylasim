/**
 * Faz 7: İzin & Gizlilik Merkezi ve ilk açılış akışının platform katmanı. Saf karar mantığı core `permissionCenter.ts`te;
 * burada yalnızca cihazdan OKUMA (`readPermissionSnapshot`, sistem penceresi açmaz) ve İSTEME (`requestPermission`).
 *
 * iOS: "Her zaman" yalnızca "Kullanırken" verildikten sonra istenebilir (iOS 13+ önce geçici izin verir, sonra sorar);
 * reddedilmiş izin yalnızca Ayarlar'dan açılır. Android 11+ (API 30) arka plan konumu yalnızca Ayarlar'daki konum
 * sayfasından verilir; Android 13+ bildirim izni (POST_NOTIFICATIONS) çalışma zamanında sorulur.
 * Web demo bir iPhone'u taklit eder (platform `ios`).
 *
 * Faz 9: Rehber (`contactsPermissions`, iOS 18 `limited`) ve SMS kullanılabilirliği (`smsComposer`; izin YOK) da
 * okunur. `requestPermission('contacts')` sistem istemini açar; `sms` uygulama içi açık onaydır (smsFallbackStore),
 * burada istem yok.
 */
import type { CenterRowId, OnboardingStep, PermissionSnapshot, PermState } from '@konum/core';
import { Linking, Platform } from 'react-native';
import { iosCriticalAlertsEnabled } from '../../lib/notificationConfig';
import { permissionsStore } from '../../state/permissionsStore';
import { activityPermission, askActivityPermission } from '../location/adaptive/activitySource';
import { openBatteryOptimizationSettings } from '../location/batteryOptimization';
import * as Notifications from '../notifications/expoNotifications';
import { isSmsAvailable } from '../sms/smsComposer';
import { readContactsPermission, requestContactsPermission } from './contactsPermissions';
import { readMediaPermissions, requestCameraPermission, requestPhotosPermission } from './mediaPermissions';

const core = (s: string): PermState => (s === 'granted' || s === 'denied' || s === 'restricted' ? s : 'undetermined');

function platformInfo(): Pick<PermissionSnapshot, 'platform' | 'osVersion'> {
  if (Platform.OS === 'android') return { platform: 'android', osVersion: typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version) || 0 };
  if (Platform.OS === 'ios') return { platform: 'ios', osVersion: Number.parseInt(String(Platform.Version), 10) || 0 };
  return { platform: 'ios', osVersion: 18 };
}

/** iOS bildirim ayrıntıları (zaman duyarlı / kritik); bilinmiyorsa null. */
async function iosNotificationDetails(): Promise<{ timeSensitive: boolean | null; criticalAlerts: boolean | null }> {
  if (Platform.OS !== 'ios') return { timeSensitive: null, criticalAlerts: null };
  try {
    const r = await Notifications.getPermissionsAsync();
    const ios = (r as { ios?: Record<string, unknown> }).ios ?? {};
    const ts = ios.allowsTimeSensitive;
    const critical = ios.allowsCriticalAlerts;
    return {
      timeSensitive: typeof ts === 'boolean' ? ts : null,
      criticalAlerts: iosCriticalAlertsEnabled() && typeof critical === 'boolean' ? critical : null,
    };
  } catch {
    return { timeSensitive: null, criticalAlerts: null };
  }
}

/** Cihazdaki güncel izinler (yalnızca okur). */
export async function readPermissionSnapshot(): Promise<PermissionSnapshot> {
  await permissionsStore.getState().refresh().catch(() => undefined);
  const p = permissionsStore.getState();
  const [media, motion, ios, contacts, smsAvailable] = await Promise.all([
    readMediaPermissions(),
    activityPermission().catch(() => 'restricted' as const),
    iosNotificationDetails(),
    readContactsPermission(),
    isSmsAvailable().catch(() => null),
  ]);
  return {
    ...platformInfo(),
    foreground: core(p.foreground),
    foregroundCanAskAgain: p.foregroundCanAskAgain,
    background: core(p.background),
    backgroundCanAskAgain: p.backgroundCanAskAgain,
    precise: p.preciseLocation,
    notifications: core(p.notifications),
    notificationsCanAskAgain: p.notificationsCanAskAgain,
    timeSensitive: ios.timeSensitive,
    criticalAlerts: ios.criticalAlerts,
    camera: media.camera,
    cameraCanAskAgain: media.cameraCanAskAgain,
    photos: media.photos,
    photosCanAskAgain: media.photosCanAskAgain,
    motion: motion === 'restricted' ? null : motion,
    batteryOptimization: Platform.OS === 'android' ? (p.batteryOptimization === 'unknown' ? 'unknown' : p.batteryOptimization) : null,
    contacts: contacts.contacts,
    contactsCanAskAgain: contacts.contactsCanAskAgain,
    smsAvailable,
  };
}

export const openSystemSettings = (): Promise<void> => Linking.openSettings().catch(() => undefined);

/** Gizlilik Merkezi satırı / akış adımı için sistem istemi. Dönen: izin verildi mi. */
export async function requestPermission(id: CenterRowId | OnboardingStep): Promise<boolean> {
  const perms = permissionsStore.getState();
  switch (id) {
    case 'location':
      if (perms.foreground !== 'granted') return perms.requestForeground();
      return perms.requestBackground();
    case 'location_always':
      if (perms.foreground !== 'granted' && !(await perms.requestForeground())) return false;
      return perms.requestBackground();
    case 'notifications':
    case 'sos_alerts':
      return perms.requestNotifications();
    case 'camera':
      return (await requestCameraPermission()) === 'granted';
    case 'photos': {
      const r = await requestPhotosPermission();
      return r === 'granted' || r === 'limited';
    }
    case 'camera_photos': {
      const cam = await requestCameraPermission();
      const lib = await requestPhotosPermission();
      return cam === 'granted' || lib === 'granted' || lib === 'limited';
    }
    case 'motion':
      return (await askActivityPermission()) === 'granted';
    case 'contacts': {
      const r = await requestContactsPermission();
      return r === 'granted' || r === 'limited';
    }
    case 'sms':
      // İzin yok: SMS yedeği uygulama içi açık onaydır (smsFallbackStore.enable).
      return false;
    case 'battery_optimization':
      await openBatteryOptimizationSettings().catch(() => undefined);
      return false;
    case 'precise':
      await openSystemSettings();
      return false;
    default:
      return false;
  }
}
