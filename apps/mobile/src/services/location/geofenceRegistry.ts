/**
 * Native OS bölge kaydı: Faz 3 uyku çiti + Faz 5 kayıtlı bölgeler TEK yerden, sırayla uygulanır.
 *
 * NEDEN? iOS'ta `CLLocationManager.monitoredRegions` uygulama genelinde PAYLAŞILIR ve expo-location'ın bölge görevi
 * her güncellemede (`setOptions`) ve durdurmada `monitoredRegions`'daki TÜM bölgeleri bırakır (EXGeofencingTaskConsumer
 * `stopMonitoringAllRegions`). İki ayrı görev birbirinin bölgelerini silerdi (uyku çiti sık değişir). Bu yüzden iOS'ta
 * bölge varken uyku çiti de bölge görevine (`konum-zone-geofence`) eklenir ve uyku görevi durdurulur; bölge görevi
 * `konum-sleep` kimlikli olayı uyku çiti olarak işler (backgroundTask.ts).
 * Android'de her görevin kendi PendingIntent'i vardır (`GeofencingClient.removeGeofences(pendingIntent)`): görevler
 * ayrı kalır. [Varsayım: iki platformda cihazda doğrulanmalı]
 * iOS 20 bölge sınırı: uyku çiti (1) + en çok 15 bölge (core `ZONE_LIMITS.maxZones`).
 */
import type { SleepGeofence } from '@konum/core';
import * as Location from 'expo-location';
import { Platform } from 'react-native';
import { GEOFENCE_TASK_NAME, SLEEP_REGION_ID, ZONE_GEOFENCE_TASK_NAME } from './LocationEngine';

let sleepFence: SleepGeofence | null = null;
let zoneRegions: Location.LocationRegion[] = [];
let chain: Promise<unknown> = Promise.resolve();

const sleepRegion = (f: SleepGeofence): Location.LocationRegion => ({
  identifier: SLEEP_REGION_ID,
  latitude: f.lat,
  longitude: f.lng,
  radius: f.radiusM,
  notifyOnEnter: false,
  notifyOnExit: true,
});

async function stopTask(name: string): Promise<void> {
  try {
    if (await Location.hasStartedGeofencingAsync(name)) await Location.stopGeofencingAsync(name);
  } catch {
    // arka plan izni yoksa hasStarted hata fırlatır: kayıtlı görev de olamaz
  }
}

/** Dönen: bölge kaydı başarılı mı (bölge yoksa true). Uyku çiti hatası çağırana fırlatılır (Faz 3 davranışı). */
async function apply(): Promise<{ zonesOk: boolean; sleepError: unknown }> {
  let zonesOk = true;
  let sleepError: unknown = null;
  if (Platform.OS === 'ios' && zoneRegions.length > 0) {
    await stopTask(GEOFENCE_TASK_NAME);
    try {
      await Location.startGeofencingAsync(ZONE_GEOFENCE_TASK_NAME, sleepFence ? [sleepRegion(sleepFence), ...zoneRegions] : zoneRegions);
    } catch (e) {
      zonesOk = false;
      sleepError = sleepFence ? e : null;
    }
    return { zonesOk, sleepError };
  }
  if (zoneRegions.length > 0) {
    try {
      await Location.startGeofencingAsync(ZONE_GEOFENCE_TASK_NAME, zoneRegions);
    } catch {
      zonesOk = false;
    }
  } else await stopTask(ZONE_GEOFENCE_TASK_NAME);
  if (sleepFence) {
    try {
      await Location.startGeofencingAsync(GEOFENCE_TASK_NAME, [sleepRegion(sleepFence)]);
    } catch (e) {
      sleepError = e;
    }
  } else await stopTask(GEOFENCE_TASK_NAME);
  return { zonesOk, sleepError };
}

function run(): Promise<{ zonesOk: boolean; sleepError: unknown }> {
  const next = chain.then(apply, apply);
  chain = next.catch(() => undefined);
  return next;
}

/** Faz 3 uyku çiti (null = kaldır). Kurulamazsa hata fırlatır (çağıran yutar). */
export async function setSleepRegion(fence: SleepGeofence | null): Promise<void> {
  sleepFence = fence;
  const r = await run();
  if (fence && r.sleepError) throw r.sleepError;
}

/** Faz 5 bölgeleri (boş = kaldır). Dönen: kayıt başarılı mı (arka plan izni yoksa false). */
export async function setZoneRegions(regions: readonly Location.LocationRegion[]): Promise<boolean> {
  zoneRegions = [...regions];
  return (await run()).zonesOk;
}
