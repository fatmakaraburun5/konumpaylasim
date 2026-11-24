/**
 * Web demo (Faz 5): bölge algılama — native `zoneMonitor.ts` ile aynı dışa aktarım ve aynı çekirdek
 * (zoneMonitorCore + zoneMonitorWiring). Farklar:
 *  - OS bölge izleme SİMÜLE edilir: kayıtlı bölgeler 2 sn'de bir simüle telefon konumuna (demo/web/device.ts) göre
 *    yoklanır; `osRegionRadius` sınırı geçilince (ve kayıt anında ilk durum için, iOS `didDetermineState` gibi)
 *    "OS olayı" → taze konum → filtre.
 *  - Arka plan izni demo izinlerinden (`demo/web/permissions.ts`); bölge izleme her zaman desteklenir.
 *  - Panel senaryoları için kancalar `demo/web/zoneSim.ts`'e kaydedilir (zaman atlamalı yürüyüş, GPS sapması).
 * Sunucu saati = cihaz saati (demo sunucusu).
 */
import { haversineM } from '@konum/core';
import { demoPosition } from '../../demo/web/device';
import { registerDemoZoneHooks } from '../../demo/web/zoneSim';
import { locationEngine } from './ExpoLocationEngine';
import { getBackgroundPermissionsAsync } from './locationPermissions';
import { zoneIdFromRegion } from './zoneMonitorCore';
import { createZoneMonitor, type ZoneMonitorApi, type ZoneOsRegion } from './zoneMonitorWiring';

const POLL_MS = 2_000;

let regions: ZoneOsRegion[] = [];
const regionState = new Map<string, 'inside' | 'outside'>();
let timer: ReturnType<typeof setInterval> | null = null;

function poll(): void {
  const here = demoPosition();
  for (const r of regions) {
    const inside = haversineM({ lat: r.latitude, lng: r.longitude }, here) <= r.radius ? 'inside' : 'outside';
    if (regionState.get(r.identifier) === inside) continue;
    regionState.set(r.identifier, inside);
    const zoneId = zoneIdFromRegion(r.identifier);
    if (zoneId) void zoneMonitor.handleRegionEvent(zoneId, inside === 'inside' ? 'enter' : 'exit', Date.now());
  }
}

export const zoneMonitor: ZoneMonitorApi = createZoneMonitor({
  registerRegions: async (next) => {
    const ids = new Set(next.map((r) => r.identifier));
    for (const id of [...regionState.keys()]) if (!ids.has(id)) regionState.delete(id);
    // Merkez / yarıçap değişen bölge yeniden "belirlenir".
    for (const r of next) {
      const old = regions.find((x) => x.identifier === r.identifier);
      if (old && (old.latitude !== r.latitude || old.longitude !== r.longitude || old.radius !== r.radius)) regionState.delete(r.identifier);
    }
    regions = [...next];
    if (regions.length > 0 && !timer) timer = setInterval(poll, POLL_MS);
    if (regions.length === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
    if (regions.length > 0) setTimeout(poll, 300);
    return true;
  },
  isSupported: async () => true,
  hasBackgroundPermission: async () => {
    const r = await getBackgroundPermissionsAsync();
    return r.granted;
  },
  freshSample: (timeoutMs) => (locationEngine.getPreciseSample ? locationEngine.getPreciseSample(timeoutMs) : locationEngine.getCurrentSample()),
  serverOffsetMs: async () => 0,
  afterShareStarted: async () => undefined,
  ensureAuth: async () => true,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

registerDemoZoneHooks({
  replay: (zoneId, inputs) => zoneMonitor.replay(zoneId, inputs, 'demo'),
  decisions: () => zoneMonitor.decisions(),
  onDecision: (l) => zoneMonitor.onDecision(l),
  states: () => zoneMonitor.states(),
});
