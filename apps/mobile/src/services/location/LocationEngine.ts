/**
 * Konum motoru soyutlaması. Faz 1: expo-location (ExpoLocationEngine).
 * Faz 3: uyarlamalı satır uygulama (`applyPlan`) ve uyku çiti (`setSleepGeofence`) İSTEĞE BAĞLI yöntemlerdir;
 * sağlamayan motor (web demo) Faz 1 `startBackground(profile)` yoluyla çalışır.
 */
import type { MotionState, RawLocationSample, SleepGeofence, TrackingPlanRow, TrackingProfile } from '@konum/core';
import type { ServiceNotification } from './adaptive/planOptions';

/** TaskManager görev adı. Değiştirilirse eski sürümden kalan kayıtlı görev yetim kalır. */
export const LOCATION_TASK_NAME = 'konum-location-updates';
/** Faz 3: uyku çiti (geofence) görevi. */
export const GEOFENCE_TASK_NAME = 'konum-sleep-geofence';
/** Uyku çitinin bölge kimliği. */
export const SLEEP_REGION_ID = 'konum-sleep';

export interface LocationEngine {
  /**
   * Arka plan konum görevini (Android: ön plan servisi + kalıcı bildirim) başlatır ya da
   * zaten çalışıyorsa seçeneklerini günceller.
   * Android 12+: ön plan servisi uygulama arka plandayken BAŞLATILAMAZ; bu yüzden yalnızca
   * uygulama ön plandayken çağrılmalıdır (bkz. `canReconfigureNow`).
   */
  startBackground(profile: TrackingProfile, notificationBody: string): Promise<void>;
  stopBackground(): Promise<void>;
  isBackgroundRunning(): Promise<boolean>;
  /** Şu an (uygulama durumuna göre) arka plan seçenekleri değiştirilebilir mi? */
  canReconfigureNow(): boolean;
  /** Arayüz için ön plan izleme (kendi konumum, yeniden ortalama) ve ön plan yayını. */
  watchForeground(profile: TrackingProfile, onSample: (raw: RawLocationSample) => void): Promise<() => void>;
  /** Tek seferlik konum (ön plan nabzı için). */
  getCurrentSample(): Promise<RawLocationSample | null>;
  /**
   * Faz 4 (SOS): en yüksek doğrulukta tek ölçüm, en çok `timeoutMs` beklenir; olmazsa null (çağıran son bilinen
   * konuma düşer). Sağlamayan motorda `getCurrentSample` kullanılır.
   */
  getPreciseSample?(timeoutMs: number): Promise<RawLocationSample | null>;
  /**
   * Faz 3: core matris satırını arka plan görevine uygular (aynı görev adıyla yeniden kayıt = seçenek güncelleme).
   * Android arka planında çağrılmamalı (`canReconfigureNow`).
   */
  applyPlan?(row: TrackingPlanRow, motion: MotionState, notification: ServiceNotification): Promise<void>;
  /** Faz 3: uyku çitini kurar (null = kaldırır). Always / arka plan izni gerekir. */
  setSleepGeofence?(fence: SleepGeofence | null): Promise<void>;
}
