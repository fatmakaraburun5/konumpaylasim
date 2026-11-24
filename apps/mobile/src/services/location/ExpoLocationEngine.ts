import type { MotionState, RawLocationSample, SleepGeofence, TrackingPlanRow, TrackingProfile } from '@konum/core';
import * as Location from 'expo-location';
import { AppState, Platform } from 'react-native';
import { toPlanTaskOptions, type ServiceNotification } from './adaptive/planOptions';
import { setSleepRegion } from './geofenceRegistry';
import { LOCATION_TASK_NAME, type LocationEngine } from './LocationEngine';
import { toRawSample, toTaskOptions, toWatchOptions } from './trackingOptions';

export class ExpoLocationEngine implements LocationEngine {
  async startBackground(profile: TrackingProfile, notificationBody: string): Promise<void> {
    // Aynı görev adıyla tekrar çağrı, çalışan görevin seçeneklerini günceller (durdurmadan).
    // [Varsayım: doğrulanmalı] Android'de ön plan servisi bildirimi de yeni metinle güncellenir.
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, toTaskOptions(profile, notificationBody, Platform.OS));
  }

  /**
   * Faz 3: matris satırı. Uyku (gps 'off') dahil görev HİÇ durdurulmaz: Android'de ön plan servisi arka planda
   * yeniden başlatılamaz (expo-location 58 `ForegroundServiceStartNotAllowedException`), iOS'ta oturum kapanırsa
   * uygulama askıya alınır. Uyku = düşük güçlü seyrek istek + uyku çiti (bkz. planOptions.ts).
   */
  async applyPlan(row: TrackingPlanRow, motion: MotionState, notification: ServiceNotification): Promise<void> {
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, toPlanTaskOptions(row, motion, notification, Platform.OS));
  }

  /**
   * Uyku çiti: yalnızca ÇIKIŞ bildirilir. iOS CLCircularRegion (~100 m altı güvenilmez, core 100–150 m verir),
   * Android GeofencingClient (ACCESS_BACKGROUND_LOCATION gerekir; yoksa expo-location hata fırlatır → çağıran yutar).
   * Aynı görev adıyla yeniden çağrı bölge listesini DEĞİŞTİRİR. Faz 5: kayıt `geofenceRegistry` üzerinden (iOS'ta
   * kayıtlı bölgeler varken uyku çiti bölge görevine eklenir; bkz. geofenceRegistry.ts).
   */
  async setSleepGeofence(fence: SleepGeofence | null): Promise<void> {
    await setSleepRegion(fence);
  }

  async stopBackground(): Promise<void> {
    await setSleepRegion(null).catch(() => undefined);
    if (await this.isBackgroundRunning()) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  }

  async isBackgroundRunning(): Promise<boolean> {
    try {
      return await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    } catch {
      return false;
    }
  }

  canReconfigureNow(): boolean {
    // Android 12+: arka plandan ön plan servisi başlatılamaz/güncellenemez (expo-location hata fırlatır).
    // iOS: konum güncellemeleri zaten çalışırken arka planda yeniden yapılandırma serbest. [Varsayım: doğrulanmalı]
    return Platform.OS === 'ios' || AppState.currentState === 'active';
  }

  async watchForeground(profile: TrackingProfile, onSample: (raw: RawLocationSample) => void): Promise<() => void> {
    const sub = await Location.watchPositionAsync(toWatchOptions(profile), (loc) => onSample(toRawSample(loc)));
    return () => sub.remove();
  }

  async getCurrentSample(): Promise<RawLocationSample | null> {
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      return toRawSample(loc);
    } catch {
      return null;
    }
  }

  /** Faz 4 (SOS): `Highest` doğruluk (iOS kBest, Android PRIORITY_HIGH_ACCURACY), zaman aşımlı. */
  async getPreciseSample(timeoutMs: number): Promise<RawLocationSample | null> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const fix = Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }).then(toRawSample, () => null);
      const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs)));
      return await Promise.race([fix, timeout]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export const locationEngine: LocationEngine = new ExpoLocationEngine();
