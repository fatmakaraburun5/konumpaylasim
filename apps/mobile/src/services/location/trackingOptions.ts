/**
 * core takip profili (TRACKING_PROFILES / selectTrackingProfile) → expo-location seçenekleri.
 */
import type { RawLocationSample, TrackingProfile } from '@konum/core';
import * as Location from 'expo-location';
import { lightColors } from '../../ui/tokens';

export const FOREGROUND_SERVICE_TITLE = 'Konumun paylaşılıyor';

const ACCURACY: Record<TrackingProfile['accuracy'], Location.LocationAccuracy> = {
  high: Location.Accuracy.High,
  balanced: Location.Accuracy.Balanced,
  low: Location.Accuracy.Low,
};

export function toTaskOptions(
  profile: TrackingProfile,
  notificationBody: string,
  platform: 'ios' | 'android' | string,
): Location.LocationTaskOptions {
  return {
    accuracy: ACCURACY[profile.accuracy],
    // Android: en kısa aralık. iOS bu alanı yok sayar (yalnızca mesafe + doğruluk).
    timeInterval: profile.timeIntervalMs,
    /**
     * Android'de işletim sistemi mesafe filtresi 0: güncellemeler `timeInterval` ile gelir, mesafe filtresi
     * JS'te core `shouldPublish` ile uygulanır. Böylece hareketsizken de nabız (heartbeat) gidebilir.
     * iOS'ta zaman aralığı yok; 0 verilirse saniyede bir uyanır → profil mesafesi kullanılır ve hareketsizken
     * nabız garanti DEĞİLDİR (alıcı "Az önce" / "Son bilinen konum" görür). [Varsayım: pil ölçümüyle doğrulanmalı]
     */
    distanceInterval: platform === 'android' ? 0 : profile.distanceFilterM,
    showsBackgroundLocationIndicator: true,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.Other,
    foregroundService: {
      notificationTitle: FOREGROUND_SERVICE_TITLE,
      notificationBody,
      notificationColor: lightColors.primary,
      // Kullanıcı uygulamayı son uygulamalardan kaydırsa da paylaşım sürsün (OEM izin verirse).
      killServiceOnDestroy: false,
    },
  };
}

export function toWatchOptions(profile: TrackingProfile): Location.LocationOptions {
  return {
    accuracy: ACCURACY[profile.accuracy],
    timeInterval: profile.timeIntervalMs,
    distanceInterval: profile.distanceFilterM,
    mayShowUserSettingsDialog: false,
  };
}

export function toRawSample(loc: Location.LocationObject): RawLocationSample {
  return {
    latitude: loc.coords.latitude,
    longitude: loc.coords.longitude,
    accuracy: loc.coords.accuracy,
    speed: loc.coords.speed,
    heading: loc.coords.heading,
    timestamp: loc.timestamp,
    mocked: loc.mocked ?? null,
  };
}
