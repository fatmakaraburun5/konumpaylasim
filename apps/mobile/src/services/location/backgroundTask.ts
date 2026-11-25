/**
 * Arka plan konum görevi.
 *
 * NEDEN MODÜLÜN EN ÜST SEVİYESİNDE ve NEDEN GİRİŞ DOSYASINDAN (index.ts) İLK İÇE AKTARILIYOR?
 * İşletim sistemi uygulamayı arka planda (ekran yokken) uyandırdığında — iOS'ta önemli konum değişikliğiyle
 * yeniden başlatma, Android'de ön plan servisinin başsız JS çalıştırması — React ağacı HİÇ render edilmez;
 * yalnızca JS paketi yüklenir ve expo-task-manager kayıtlı görevi adıyla çağırır. `defineTask` bir
 * bileşenin içinde (useEffect vb.) olsaydı, o anda tanımlı olmazdı ve konum güncellemesi kaybolurdu
 * (expo-task-manager "Task is not defined" uyarısı verip görevi atlar). Bu yüzden tanım, paket yüklenir
 * yüklenmez, herhangi bir şey render edilmeden önce çalışmalıdır.
 *
 * Faz 3 (yalnızca native; web demo `backgroundTask.web.ts` kullanır):
 *  - Kalıcı çevrimdışı kuyruk deposu olarak SQLite kaydedilir (web/jest AsyncStorage yedeğiyle çalışır).
 *  - Uyku çiti (geofence) görevi: hareketsizken kurulan çitten ÇIKIŞ → hareket makinesi uyanır, GPS satırı
 *    hemen geri gelir ve tek seferlik ölçümle konum yayınlanır. iOS uygulamayı bölge çıkışında öldürülmüş
 *    olsa bile yeniden başlatır ("Always" izniyle). [Varsayım: cihazda doğrulanmalı]
 *  - Uyarlamalı zamanlayıcı (kalp atışı + OS etkinliği) JS ayaktayken çalışır (adaptive/runtime.ts).
 *
 * Faz 5: kayıtlı bölge görevi (`konum-zone-geofence`): varış / ayrılış OS olayı → zoneMonitor (taze konum + sapma
 * filtresi → `zone_event_report`). iOS'ta bölge varken uyku çiti de bu göreve kayıtlıdır (geofenceRegistry.ts):
 * `konum-sleep` kimlikli ÇIKIŞ uyku çiti olarak işlenir. zoneMonitor'ün içe aktarılması konum hattının bölge
 * filtresi bağlantısını (zoneSampleTap) da kurar.
 *
 * Faz 8: yayın kesme anahtarı (görünmez mod / onay kapısı) açıkken bölge olayı ve uyku çiti işlenmez; konum örnekleri
 * hatta gider ama hat hiçbir hedefi kullanılabilir saymaz (hedefleri boşaltır, takibi kapatır).
 */
import { LocationGeofencingEventType, type LocationObject, type LocationRegion } from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { hydratePublishHold, isPublishHeld } from '../../state/publishHold';
import { registerOutboxStore } from '../outbox/outboxStore';
import { expoSqliteOutboxStore } from '../outbox/sqliteOutboxStore';
import { ensureAdaptiveRuntime } from './adaptive/runtime';
import { GEOFENCE_TASK_NAME, LOCATION_TASK_NAME, SLEEP_REGION_ID, ZONE_GEOFENCE_TASK_NAME } from './LocationEngine';
import { applyPublishHold, handleMotionEvent, handleSamples } from './pipeline';
import { toRawSample } from './trackingOptions';
import { zoneMonitor } from './zoneMonitor';
import { zoneIdFromRegion } from './zoneMonitorCore';

registerOutboxStore(expoSqliteOutboxStore());

/** Faz 8: kesme anahtarı açıksa hedefleri hemen boşalt (takip kapanır) ve true dön. */
async function heldNow(): Promise<boolean> {
  await hydratePublishHold();
  if (!isPublishHeld()) return false;
  await applyPublishHold().catch(() => undefined);
  return true;
}

interface LocationTaskData {
  locations?: LocationObject[];
}

interface GeofenceTaskData {
  eventType?: LocationGeofencingEventType;
  region?: LocationRegion;
}

TaskManager.defineTask<LocationTaskData>(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    if (__DEV__) console.warn('[konum] arka plan konum hatası', error.message);
    return;
  }
  const locations = data?.locations ?? [];
  if (locations.length === 0) return;
  // Başsız yeniden başlatmada zamanlayıcı ve OS etkinliği aboneliği de ayağa kalksın.
  ensureAdaptiveRuntime();
  await handleSamples(locations.map(toRawSample), 'task');
});

TaskManager.defineTask<GeofenceTaskData>(GEOFENCE_TASK_NAME, async ({ data, error }) => {
  if (error) {
    if (__DEV__) console.warn('[konum] uyku çiti hatası', error.message);
    return;
  }
  if (data?.eventType !== LocationGeofencingEventType.Exit) return;
  if (data.region?.identifier && data.region.identifier !== SLEEP_REGION_ID) return;
  if (await heldNow()) return;
  ensureAdaptiveRuntime();
  await handleMotionEvent({ type: 'geofence_exit' });
});

TaskManager.defineTask<GeofenceTaskData>(ZONE_GEOFENCE_TASK_NAME, async ({ data, error }) => {
  if (error) {
    if (__DEV__) console.warn('[konum] bölge görevi hatası', error.message);
    return;
  }
  const t = data?.eventType;
  const event = t === LocationGeofencingEventType.Enter ? 'enter' : t === LocationGeofencingEventType.Exit ? 'exit' : null;
  if (!event) return;
  const id = data?.region?.identifier;
  // Faz 8: görünmezken / onaysız bölge olayı gönderilmez (sunucu da reddeder), uyku çiti takibi uyandırmaz.
  if (await heldNow()) return;
  if (id === SLEEP_REGION_ID) {
    if (event !== 'exit') return;
    ensureAdaptiveRuntime();
    await handleMotionEvent({ type: 'geofence_exit' });
    return;
  }
  const zoneId = zoneIdFromRegion(id);
  if (!zoneId) return;
  await zoneMonitor.handleRegionEvent(zoneId, event, Date.now());
});
