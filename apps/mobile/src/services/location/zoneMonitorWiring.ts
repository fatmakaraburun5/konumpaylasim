/**
 * Faz 5: bölge izleme — çekirdeğin (zoneMonitorCore) depolara ve kalıcı duruma bağlanması. Platforma özgü parçalar
 * (`ZonePlatform`: OS bölge kaydı, taze konum, izin, başsız paylaşım devralma) native `zoneMonitor.ts` ve web demo
 * `zoneMonitor.web.ts` tarafından verilir.
 *
 *  - `syncZones(zones)`: bölge listesi değişti → asgari kopya diske (başsız olay için) → OS kaydı (etkin, en yakın
 *    ≤ 15, yarıçap = core `osRegionRadius`) → `zonesStore.monitoring`.
 *  - Örnekler: ön plan (f5Services, locationStore) + arka plan görevi / nabız (pipeline → zoneSampleTap).
 *  - Rapor sonucu → `zonesStore.addLocalEvent`; `start_share` başladıysa yerel bildirim ("Ev · çıktın: Ayşe ile konum
 *    paylaşımı başladı") — otomatik paylaşım kullanıcıdan gizli kalmasın. [Varsayım]
 */
import {
  osRegionRadius,
  selectPublishTargets,
  uuidV4,
  type DurationChoice,
  type EpochMs,
  type RawLocationSample,
  type UserId,
  type Zone,
  type ZoneFilterInput,
  type ZoneFilterState,
  type ZoneSample,
} from '@konum/core';
import { Platform } from 'react-native';
import { getServerOffsetMs } from '../../lib/clock';
import { KonumError } from '../../lib/errors';
import { authStore } from '../../state/authStore';
import { friendsStore, selectFriends } from '../../state/friendsStore';
import { locationStore } from '../../state/locationStore';
import {
  clearZoneState,
  loadTargets,
  loadZoneCache,
  loadZoneFilters,
  loadZoneReports,
  saveZoneCache,
  saveZoneFilters,
  saveZoneReports,
  type PersistedZone,
} from '../../state/persist';
import { hydratePublishHold, isPublishHeld } from '../../state/publishHold';
import { sharingStore } from '../../state/sharingStore';
import { zonesStore, type ZoneMonitoring } from '../../state/zonesStore';
import { zoneEventReport } from '../firebase/callables';
import { CHANNELS } from '../notifications/constants';
import * as Notifications from '../notifications/expoNotifications';
import { setZoneSampleTap } from './zoneSampleTap';
import {
  createZoneMonitorCore,
  zoneRegionId,
  zonesForOs,
  type ZoneDecision,
  type ZoneMonitorCore,
  type ZoneReportOutcome,
  type ZoneSampleSource,
} from './zoneMonitorCore';

export interface ZoneOsRegion {
  identifier: string;
  latitude: number;
  longitude: number;
  radius: number;
  notifyOnEnter: boolean;
  notifyOnExit: boolean;
}

export interface ZonePlatform {
  /** OS bölge kaydı (boş liste = kaldır). Dönen: başarılı mı. */
  registerRegions(regions: readonly ZoneOsRegion[]): Promise<boolean>;
  isSupported(): Promise<boolean>;
  hasBackgroundPermission(): Promise<boolean>;
  freshSample(timeoutMs: number): Promise<RawLocationSample | null>;
  /** Sunucu saati farkı (başsız açılışta kalıcı değerden). */
  serverOffsetMs(): Promise<number>;
  /** Kural paylaşımı başladı; uygulama ön planda değilse (başsız) hedefleri devral ve takibi başlat. */
  afterShareStarted(foreground: boolean): Promise<void>;
  /** Oturum yoksa (başsız) kimliğin geri yüklenmesini bekle; false = rapor kuyrukta kalsın. */
  ensureAuth(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface ZoneMonitorApi {
  feedRaw(raws: readonly RawLocationSample[], source: ZoneSampleSource): Promise<void>;
  handleRegionEvent(zoneId: string, event: 'enter' | 'exit', atDevice: EpochMs): Promise<void>;
  syncZones(zones: readonly Zone[]): Promise<ZoneMonitoring>;
  flushReports(): Promise<void>;
  /** Oturum servisleri çalışıyor mu (ön plan): başsız paylaşım devralma yalnızca false iken. */
  setForeground(v: boolean): void;
  /** Son filtre kararları (en yeni önde, ≤ 30). */
  decisions(): ZoneDecision[];
  onDecision(l: (d: ZoneDecision) => void): () => void;
  states(): Readonly<Record<string, ZoneFilterState>>;
  replay(zoneId: string, inputs: readonly ZoneFilterInput[], source?: ZoneSampleSource): Promise<void>;
  /** Çıkış: OS kaydı kalkar, kalıcı bölge durumu silinir. */
  stop(): Promise<void>;
}

const DECISIONS_MAX = 30;

export const toZoneSample = (raw: RawLocationSample): ZoneSample => ({
  lat: raw.latitude,
  lng: raw.longitude,
  // Doğruluğu bilinmeyen örnek karar vermez (doğruluk kapısı reddeder). [Varsayım]
  accuracy: raw.accuracy ?? 5_000,
  at: raw.timestamp,
});

const toPersisted = (z: Zone): PersistedZone => ({ zone_id: z.zone_id, name: z.name, center: { lat: z.center.lat, lng: z.center.lng }, radius_m: z.radius_m, enabled: z.enabled });

export function createZoneMonitor(platform: ZonePlatform): ZoneMonitorApi {
  let foreground = false;
  let names: Record<string, string> = {};
  const decisionLog: ZoneDecision[] = [];
  const decisionListeners = new Set<(d: ZoneDecision) => void>();

  const myUid = async (): Promise<UserId | null> => authStore.getState().uid ?? (await loadZoneCache()).uid;

  const friendName = (uid: UserId): string | null => selectFriends(friendsStore.getState()).find((f) => f.uid === uid)?.displayName ?? null;

  async function notifyShareStarted(o: ZoneReportOutcome): Promise<void> {
    const zoneName = names[o.zone_id] ?? zonesStore.getState().zones[o.zone_id]?.name ?? 'Bölge';
    const known = o.started_share.map(friendName).filter((n): n is string => !!n);
    const who = known.length === o.started_share.length && known.length > 0 && known.length <= 2 ? known.join(' ve ') : `${o.started_share.length} kişi`;
    const body = `${zoneName} · ${o.transition === 'arrive' ? 'vardın' : 'çıktın'}: ${who} ile konum paylaşımı başladı`;
    try {
      await Notifications.scheduleNotificationAsync({
        content: { title: 'Bölge kuralı', body, data: { type: 'zone_share_started', zone_id: o.zone_id } },
        trigger: Platform.OS === 'ios' ? null : { channelId: CHANNELS.ping },
      });
    } catch {
      // bildirim izni yok: paylaşım kartı uygulamada yine görünür
    }
  }

  const core: ZoneMonitorCore = createZoneMonitorCore({
    myUid,
    loadZones: async () => {
      const c = await loadZoneCache();
      for (const z of c.zones) names[z.zone_id] = z.name;
      return c;
    },
    loadFilters: loadZoneFilters,
    saveFilters: saveZoneFilters,
    loadReports: loadZoneReports,
    saveReports: saveZoneReports,
    report: async (req) => {
      // Faz 8: görünmezken / onaysız bölge olayı sunucuya gitmez (yeniden denenmez, kuyruktan düşer).
      await hydratePublishHold();
      if (isPublishHeld()) throw new KonumError('invisible_mode');
      if (!(await platform.ensureAuth())) throw new KonumError('unavailable');
      return zoneEventReport(req);
    },
    sharingWith: async () => {
      const out = new Set<UserId>();
      for (const t of selectPublishTargets(sharingStore.getState().state)) out.add(t.receiver_id);
      // Başsız açılış: depo boş olabilir, kalıcı hedefler de sayılır.
      const p = await loadTargets().catch(() => null);
      const t = Date.now() + (p?.serverOffsetMs ?? 0);
      for (const x of p?.targets ?? []) if (x.expires_at === null || x.expires_at > t) out.add(x.receiver_id);
      return out;
    },
    startShare: async (recipients: UserId[], duration: DurationChoice) => {
      const r = await sharingStore.getState().startShare(recipients, duration);
      if (r.ok) await platform.afterShareStarted(foreground).catch(() => undefined);
      return r.ok;
    },
    getFreshSample: async (timeoutMs) => {
      const raw = await platform.freshSample(timeoutMs).catch(() => null);
      return raw ? toZoneSample(raw) : null;
    },
    toServerTime: (() => {
      let persisted = 0;
      void platform.serverOffsetMs().then((v) => (persisted = v)).catch(() => undefined);
      return (deviceMs: EpochMs) => deviceMs + (getServerOffsetMs() || persisted);
    })(),
    deviceNow: () => Date.now(),
    sleep: (ms) => platform.sleep(ms),
    newOpId: uuidV4,
    onDecision: (d) => {
      decisionLog.unshift(d);
      decisionLog.length = Math.min(decisionLog.length, DECISIONS_MAX);
      for (const l of [...decisionListeners]) {
        try {
          l(d);
        } catch {
          // dinleyici hatası izlemeyi etkilemez
        }
      }
    },
    onPresence: (p) => zonesStore.getState().setPresence(p),
    onReport: (o) => {
      zonesStore.getState().addLocalEvent({ zone_id: o.zone_id, transition: o.transition, at: o.at, notified: o.notified, suppressed: o.suppressed });
      if (o.started_share.length > 0) void notifyShareStarted(o);
    },
  });

  setZoneSampleTap((raws, source) => {
    void core.feedSamples(raws.map(toZoneSample), source === 'task' ? 'background' : 'foreground');
  });

  let syncSeq = 0;

  return {
    feedRaw: (raws, source) => core.feedSamples(raws.map(toZoneSample), source),
    handleRegionEvent: (zoneId, event, at) => core.handleOsEvent(zoneId, event, at),

    syncZones: async (zones) => {
      const mySeq = ++syncSeq;
      const uid = authStore.getState().uid;
      if (!uid) return 'off';
      const lite = zones.map(toPersisted);
      names = Object.fromEntries(lite.map((z) => [z.zone_id, z.name]));
      await saveZoneCache({ uid, zones: lite });
      await core.pruneZones(lite.map((z) => z.zone_id));
      const enabled = lite.filter((z) => z.enabled);
      let result: ZoneMonitoring;
      if (enabled.length === 0) {
        await platform.registerRegions([]);
        result = 'off';
      } else if (!(await platform.isSupported())) {
        result = 'unsupported';
      } else if (!(await platform.hasBackgroundPermission())) {
        // Arka plan izni yok: OS kaydı yapılamaz; ön plandaki örneklerle filtre yine çalışır.
        await platform.registerRegions([]);
        result = 'needs_permission';
      } else {
        const p = locationStore.getState().myPosition;
        const regions = zonesForOs(enabled, p ? { lat: p.lat, lng: p.lng } : null).map(
          (z): ZoneOsRegion => ({
            identifier: zoneRegionId(z.zone_id),
            latitude: z.center.lat,
            longitude: z.center.lng,
            radius: osRegionRadius(z.radius_m),
            notifyOnEnter: true,
            notifyOnExit: true,
          }),
        );
        result = (await platform.registerRegions(regions)) ? 'active' : 'needs_permission';
      }
      if (mySeq === syncSeq) zonesStore.getState().setMonitoring(result);
      return result;
    },

    flushReports: () => core.flushReports(),
    setForeground: (v) => {
      foreground = v;
    },
    decisions: () => [...decisionLog],
    onDecision: (l) => {
      decisionListeners.add(l);
      return () => decisionListeners.delete(l);
    },
    states: () => core.states(),
    replay: (zoneId, inputs, source = 'demo') => core.replay(zoneId, inputs, source),

    stop: async () => {
      syncSeq++;
      await platform.registerRegions([]).catch(() => false);
      core.reset();
      decisionLog.length = 0;
      names = {};
      await clearZoneState();
    },
  };
}
