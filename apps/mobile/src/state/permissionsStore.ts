/**
 * İzin durumu. `refresh()` yalnızca OKUR, asla sistem penceresi açmaz: uygulama açılışında
 * izin İSTENMEZ. İstek yalnızca kullanıcı ilk paylaşımını başlatırken PermissionFlow içinden yapılır.
 */
import { iosCriticalAlertsEnabled } from '../lib/notificationConfig';
import { readBatteryOptimization, type BatteryOptimization } from '../services/location/batteryOptimization';
import * as Location from '../services/location/locationPermissions';
import * as Notifications from '../services/notifications/expoNotifications';
import { Platform } from 'react-native';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

export type PermState = 'unknown' | 'undetermined' | 'granted' | 'denied';

interface PermissionsState {
  foreground: PermState;
  foregroundCanAskAgain: boolean;
  background: PermState;
  backgroundCanAskAgain: boolean;
  notifications: PermState;
  notificationsCanAskAgain: boolean;
  /** Faz 3: tam (kesin) konum — iOS `accuracy: full`, Android FINE. null = bilinmiyor. */
  preciseLocation: boolean | null;
  /** Faz 3 (Android): pil optimizasyonu durumu. */
  batteryOptimization: BatteryOptimization;
  refresh: () => Promise<void>;
  requestForeground: () => Promise<boolean>;
  requestBackground: () => Promise<boolean>;
  requestNotifications: () => Promise<boolean>;
}

const toState = (s: { status: string; granted?: boolean }): PermState =>
  s.granted || s.status === 'granted' ? 'granted' : s.status === 'denied' ? 'denied' : 'undetermined';

/** expo-location izin yanıtından kesin konum bilgisi (web demo / eski sürüm: null). */
export function preciseOf(r: { granted?: boolean; ios?: { accuracy?: string }; android?: { accuracy?: string } }): boolean | null {
  if (!r.granted) return null;
  if (r.ios?.accuracy) return r.ios.accuracy === 'full';
  if (r.android?.accuracy) return r.android.accuracy === 'fine';
  return null;
}

/**
 * Bildirim izni sistem penceresi gerektiriyor mu? Android 13+ (API 33) POST_NOTIFICATIONS ister;
 * iOS'ta süre bitiş hatırlatması (yerel bildirim) için de izin gerekir. Web demo, iOS akışını simüle eder.
 */
export const platformNeedsNotificationPrompt = (): boolean =>
  Platform.OS === 'ios' ||
  Platform.OS === 'web' ||
  (Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version >= 33);

export const permissionsStore = createStore<PermissionsState>()((set) => ({
  foreground: 'unknown',
  foregroundCanAskAgain: true,
  background: 'unknown',
  backgroundCanAskAgain: true,
  notifications: 'unknown',
  notificationsCanAskAgain: true,
  preciseLocation: null,
  batteryOptimization: 'unknown',

  refresh: async () => {
    const [fg, bg, notif, battery] = await Promise.all([
      Location.getForegroundPermissionsAsync(),
      Location.getBackgroundPermissionsAsync().catch(() => ({ status: 'undetermined', canAskAgain: true, granted: false })),
      Notifications.getPermissionsAsync(),
      readBatteryOptimization(),
    ]);
    set({
      foreground: toState(fg),
      foregroundCanAskAgain: fg.canAskAgain,
      background: toState(bg),
      backgroundCanAskAgain: bg.canAskAgain,
      notifications: toState(notif),
      notificationsCanAskAgain: notif.canAskAgain,
      preciseLocation: preciseOf(fg),
      batteryOptimization: battery,
    });
  },

  requestForeground: async () => {
    const r = await Location.requestForegroundPermissionsAsync();
    set({ foreground: toState(r), foregroundCanAskAgain: r.canAskAgain, preciseLocation: preciseOf(r) });
    return r.granted;
  },

  /**
   * iOS: "Her zaman" ancak "Uygulamayı kullanırken" verildikten sonra istenebilir; sistem bazen
   * geçici "Her zaman" verir ve kullanıcıya daha sonra sorar. [Varsayım: doğrulanmalı]
   * Android 11+: sistem penceresi yerine Ayarlar'daki konum sayfası açılır.
   */
  requestBackground: async () => {
    const r = await Location.requestBackgroundPermissionsAsync();
    set({ background: toState(r), backgroundCanAskAgain: r.canAskAgain });
    return r.granted;
  },

  requestNotifications: async () => {
    // Faz 4: Critical Alerts yetkisi (Apple onayı + IOS_CRITICAL_ALERTS=1) varsa SOS sessiz modu da aşar.
    const r = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false, ...(iosCriticalAlertsEnabled() ? { allowCriticalAlerts: true } : {}) },
    });
    set({ notifications: toState(r), notificationsCanAskAgain: r.canAskAgain });
    return r.granted;
  },
}));

export function usePermissionsStore<T>(selector: (s: PermissionsState) => T): T {
  return useStore(permissionsStore, selector);
}
