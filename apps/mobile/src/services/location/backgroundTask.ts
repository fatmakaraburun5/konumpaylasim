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
 */
import { LocationGeofencingEventType, type LocationObject, type LocationRegion } from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { registerOutboxStore } from '../outbox/outboxStore';
import { expoSqliteOutboxStore } from '../outbox/sqliteOutboxStore';
import { ensureAdaptiveRuntime } from './adaptive/runtime';
import { GEOFENCE_TASK_NAME, LOCATION_TASK_NAME, SLEEP_REGION_ID } from './LocationEngine';
import { handleMotionEvent, handleSamples } from './pipeline';
import { toRawSample } from './trackingOptions';

registerOutboxStore(expoSqliteOutboxStore());

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
  ensureAdaptiveRuntime();
  await handleMotionEvent({ type: 'geofence_exit' });
});
