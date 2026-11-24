/**
 * Faz 5 (native): kayıtlı bölgeler için varış / ayrılış algılama.
 *
 *  - OS bölge izleme: iOS `CLCircularRegion`, Android `GeofencingClient` — expo-location `startGeofencingAsync`
 *    görevi `konum-zone-geofence` (görev TANIMI modül seviyesinde backgroundTask.ts'te: OS uygulamayı ekran yokken
 *    uyandırdığında React ağacı kurulmaz, Faz 3 deseni). Kayıt `geofenceRegistry` üzerinden (iOS paylaşılan bölge
 *    listesi; bkz. orada). Etkin bölge yoksa görev durur.
 *  - OS olayı yalnızca ADAYDIR: taze yüksek doğruluklu konum (`getPreciseSample`) ve core sapma filtresi onaylar
 *    (zoneMonitorCore). Onaylanan geçiş `zone_event_report` ile gider; çevrimdışıysa kalıcı kuyrukta aynı op_id ile
 *    yeniden denenir. Yanıttaki `start_share` → `sharingStore.startShare`; uygulama kapalıysa (başsız) hedefler
 *    kalıcı listeye eklenir ve takip başlatılır. [Varsayım: Android 12+ bölge geçişi ön plan servisi başlatma
 *    istisnasıdır; cihazda doğrulanmalı]
 *  - İzin: arka plan konumu (iOS "Her zaman", Android ACCESS_BACKGROUND_LOCATION). Yoksa `needs_permission`.
 */
import * as TaskManager from 'expo-task-manager';
import { selectPublishTargets } from '@konum/core';
import { authStore } from '../../state/authStore';
import { sharingStore } from '../../state/sharingStore';
import { loadTargets, updateTargets } from '../../state/persist';
import { locationEngine } from './ExpoLocationEngine';
import { setZoneRegions } from './geofenceRegistry';
import { getBackgroundPermissionsAsync } from './locationPermissions';
import { applyTrackingNow, handleSamples, probeFirebaseAuth } from './pipeline';
import { createZoneMonitor, type ZoneMonitorApi } from './zoneMonitorWiring';

/** Başsız açılışta kural paylaşımı: sunucunun başlattığı hedefleri kalıcı listeye ekle ve takibi başlat. */
async function adoptHeadlessShare(): Promise<void> {
  const fresh = selectPublishTargets(sharingStore.getState().state);
  if (fresh.length === 0) return;
  const uid = authStore.getState().uid ?? (await loadTargets()).uid;
  if (!uid) return;
  await updateTargets((latest) => {
    if (latest.uid !== null && latest.uid !== uid) return null;
    const have = new Set(latest.targets.map((t) => t.share_id));
    const add = fresh.filter((t) => !have.has(t.share_id));
    if (add.length === 0) return null;
    return { ...latest, uid, targets: [...latest.targets, ...add], notificationBody: latest.notificationBody || 'Bölge kuralıyla paylaşım' };
  });
  await applyTrackingNow();
  const raw = await locationEngine.getCurrentSample();
  if (raw) await handleSamples([raw], 'heartbeat');
}

export const zoneMonitor: ZoneMonitorApi = createZoneMonitor({
  registerRegions: (regions) => setZoneRegions(regions),
  isSupported: async () => {
    try {
      return await TaskManager.isAvailableAsync();
    } catch {
      return false;
    }
  },
  hasBackgroundPermission: async () => {
    try {
      const r = await getBackgroundPermissionsAsync();
      return r.granted || r.status === 'granted';
    } catch {
      return false;
    }
  },
  freshSample: (timeoutMs) => (locationEngine.getPreciseSample ? locationEngine.getPreciseSample(timeoutMs) : locationEngine.getCurrentSample()),
  serverOffsetMs: async () => (await loadTargets()).serverOffsetMs,
  afterShareStarted: async (foreground) => {
    if (!foreground) await adoptHeadlessShare();
  },
  ensureAuth: async () => {
    if (authStore.getState().uid) return true;
    return (await probeFirebaseAuth()).kind === 'signed_in';
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});
