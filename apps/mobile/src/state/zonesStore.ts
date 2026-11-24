/**
 * Faz 5: kayıtlı bölgeler (Ev, İş, özel nokta) ve varış / ayrılış kuralları (core `zones.ts`).
 *
 *  - `zones`: Firestore `users/{ben}/zones` dinleyicisi (f5Services → `setZones`). Yazma yalnızca `zone_upsert` /
 *    `zone_delete` callable'larıyla; yanıt gelince liste hemen güncellenir, dinleyici sonra doğrular.
 *  - Liste değişince OS bölge kaydı yenilenir (f5Services → zoneMonitor) ve asgari kopya diske yazılır
 *    (persist.ts `konum.bg.zones.v1`): başsız OS olayı bölge merkezini / yarıçapını oradan okur.
 *  - `presence`: sapma filtresinin bölge başına durumu (bilinmiyor / içeride / dışarıda) — zoneMonitor yazar.
 *  - `recentEvents`: Firestore `zone_events` (son 20) + bu cihazın az önce gönderdiği / kuyruğa aldığı olaylar.
 *  - `monitoring`: 'off' (etkin bölge yok) · 'active' · 'needs_permission' (arka plan konumu yok; ön planda yine
 *    çalışır) · 'unsupported' (cihazda bölge izleme yok).
 * Alıcılar: kabul edilmiş arkadaşlar; sunucu diğerlerini SESSİZCE düşürür (`dropped_recipient_ids`, arayüz uyarır).
 */
import {
  sanitizeNoteText,
  uuidV4,
  ZONE_KIND_EMOJI,
  ZONE_LIMITS,
  type EpochMs,
  type LatLng,
  type UserId,
  type Zone,
  type ZoneEventLog,
  type ZoneKind,
  type ZonePresence,
  type ZoneRule,
  type ZoneTrigger,
} from '@konum/core';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { now as serverClockNow } from '../lib/clock';
import { toKonumError } from '../lib/errors';
import { deviceTimeZone } from '../lib/timeZone';
import { zonesApi, type ZonesApi } from '../services/firebase/callables';
import { authStore } from './authStore';
import { permissionsStore } from './permissionsStore';
import type { Result } from './pingStore';

export type ZoneMonitoring = 'off' | 'active' | 'needs_permission' | 'unsupported';

export interface ZoneInput {
  zone_id?: string | null;
  kind: ZoneKind;
  name: string;
  emoji: string | null;
  center: LatLng;
  radius_m: number;
  rules: ZoneRule[];
  enabled: boolean;
}

export interface ZoneRecentEvent {
  zone_id: string;
  transition: ZoneTrigger;
  at: EpochMs;
  notified: number;
  /** null = bildirildi; 'cooldown' / 'stale' / … ya da cihaz: 'queued' (çevrimdışı, sırada) / 'dropped'. */
  suppressed: string | null;
}

export interface ZonesState {
  /** Sahibin bölgeleri (Firestore dinleyicisi). */
  zones: Record<string, Zone>;
  /** Filtre durumundan (bilinmiyor / içeride / dışarıda). */
  presence: Record<string, ZonePresence>;
  /** En yeni önde, ≤ 20. */
  recentEvents: ZoneRecentEvent[];
  pending: Record<string, 'saving' | 'deleting'>;
  monitoring: ZoneMonitoring;
  upsert(input: ZoneInput): Promise<Result<{ zone: Zone; dropped_recipient_ids: UserId[] }>>;
  remove(zoneId: string): Promise<boolean>;
  setEnabled(zoneId: string, enabled: boolean): Promise<boolean>;
  /** Faz 3 kademeli izin akışı: önce "Kullanırken", sonra "Her zaman" (Android ACCESS_BACKGROUND_LOCATION). */
  requestMonitoringPermission(): Promise<boolean>;
  // --- veri katmanı (f5Services / zoneMonitor) ---
  setZones(list: readonly Zone[]): void;
  setPresence(p: Record<string, ZonePresence>): void;
  setServerEvents(list: readonly ZoneEventLog[]): void;
  /** Bu cihazın raporladığı olay (sunucu kaydı gelmeden listede görünür). */
  addLocalEvent(e: ZoneRecentEvent): void;
  setMonitoring(m: ZoneMonitoring): void;
  reset(): void;
}

export interface ZonesStoreDeps {
  api: ZonesApi;
  now: () => EpochMs;
  myUid: () => UserId | null;
  newOpId: () => string;
  timeZone: () => string;
  /** İzin isteği (true = arka plan konumu verildi). */
  requestPermission: () => Promise<boolean>;
}

/** Yeni (henüz kimliği olmayan) bölgenin `pending` anahtarı. */
export const NEW_ZONE_KEY = 'new';
export const RECENT_EVENTS_MAX = 20;

type Listener = () => void;
const monitoringRequestListeners = new Set<Listener>();

/** f5Services: izin değişti → OS bölge kaydını yeniden dene. */
export function onZoneMonitoringRequest(l: Listener): () => void {
  monitoringRequestListeners.add(l);
  return () => monitoringRequestListeners.delete(l);
}

async function defaultRequestPermission(): Promise<boolean> {
  const ps = permissionsStore.getState();
  if (ps.foreground !== 'granted') {
    const fg = await ps.requestForeground().catch(() => false);
    if (!fg) return false;
  }
  return permissionsStore.getState().requestBackground().catch(() => false);
}

const sameEvent = (a: ZoneRecentEvent, b: ZoneRecentEvent) => a.zone_id === b.zone_id && a.transition === b.transition && Math.abs(a.at - b.at) < 2_000;

const sortEvents = (list: ZoneRecentEvent[]) => list.sort((a, b) => b.at - a.at).slice(0, RECENT_EVENTS_MAX);

export function createZonesStore(overrides: Partial<ZonesStoreDeps> = {}): StoreApi<ZonesState> {
  const deps: ZonesStoreDeps = {
    api: zonesApi,
    now: serverClockNow,
    myUid: () => authStore.getState().uid,
    newOpId: uuidV4,
    timeZone: deviceTimeZone,
    requestPermission: defaultRequestPermission,
    ...overrides,
  };
  /** Sunucu kaydı gelince yerel kopya düşer (aynı bölge + yön + an). */
  let serverEvents: ZoneRecentEvent[] = [];
  let localEvents: ZoneRecentEvent[] = [];

  const clearPending = (key: string) => (s: ZonesState) => {
    const { [key]: _gone, ...rest } = s.pending;
    return { pending: rest };
  };

  return createStore<ZonesState>()((set, get) => {
    const mergeEvents = () => {
      localEvents = localEvents.filter((l) => !serverEvents.some((e) => sameEvent(e, l)));
      set({ recentEvents: sortEvents([...serverEvents, ...localEvents]) });
    };

    return {
      zones: {},
      presence: {},
      recentEvents: [],
      pending: {},
      monitoring: 'off',

      upsert: async (input) => {
        const name = sanitizeNoteText(input.name, ZONE_LIMITS.nameMaxChars);
        if (!name) return { ok: false, error: { code: 'invalid_argument', message: 'Bölgeye bir ad ver' } };
        const key = input.zone_id ?? NEW_ZONE_KEY;
        if (get().pending[key]) return { ok: false, error: { code: 'rate_limited', message: 'Bölge kaydediliyor…' } };
        const me = deps.myUid();
        const radius = Math.min(ZONE_LIMITS.maxRadiusM, Math.max(ZONE_LIMITS.minRadiusM, Math.round(input.radius_m)));
        const rules: ZoneRule[] = input.rules.slice(0, ZONE_LIMITS.maxRulesPerZone).map((r) => ({
          ...r,
          rule_id: r.rule_id || deps.newOpId(),
          recipient_ids: [...new Set(r.recipient_ids)].filter((u) => u !== me).slice(0, ZONE_LIMITS.maxRecipientsPerRule),
          share_duration: r.action === 'start_share' ? r.share_duration : null,
        }));
        // Alıcısı kalmayan kural gönderilmez (şema en az bir alıcı ister; sunucu da siler).
        const sendable = rules.filter((r) => r.recipient_ids.length > 0);
        set((s) => ({ pending: { ...s.pending, [key]: 'saving' } }));
        try {
          const existing = input.zone_id ? get().zones[input.zone_id] : undefined;
          const res = await deps.api.zoneUpsert({
            op_id: deps.newOpId(),
            zone_id: input.zone_id ?? null,
            kind: input.kind,
            name,
            emoji: input.emoji ? sanitizeNoteText(input.emoji, 8) : ZONE_KIND_EMOJI[input.kind],
            center: { lat: input.center.lat, lng: input.center.lng },
            radius_m: radius,
            rules: sendable,
            enabled: input.enabled,
            // Düzenlemede bölgenin kayıtlı dilimi korunur (taşınan cihaz kural saatlerini kaydırmasın). [Varsayım]
            time_zone: existing?.time_zone ?? deps.timeZone(),
          });
          set((s) => ({ zones: { ...s.zones, [res.zone.zone_id]: res.zone } }));
          return { ok: true, zone: res.zone, dropped_recipient_ids: res.dropped_recipient_ids };
        } catch (e) {
          return { ok: false, error: toKonumError(e).toSharingError() };
        } finally {
          set(clearPending(key));
        }
      },

      remove: async (zoneId) => {
        if (get().pending[zoneId] === 'deleting') return false;
        set((s) => ({ pending: { ...s.pending, [zoneId]: 'deleting' } }));
        const drop = () =>
          set((s) => {
            const { [zoneId]: _z, ...zones } = s.zones;
            const { [zoneId]: _p, ...presence } = s.presence;
            return { zones, presence };
          });
        try {
          await deps.api.zoneDelete({ op_id: deps.newOpId(), zone_id: zoneId });
          drop();
          return true;
        } catch (e) {
          // Bölge zaten yoksa (başka cihazdan silindi) amaç gerçekleşmiştir.
          if (toKonumError(e).code === 'zone_not_found') {
            drop();
            return true;
          }
          return false;
        } finally {
          set(clearPending(zoneId));
        }
      },

      setEnabled: async (zoneId, enabled) => {
        const z = get().zones[zoneId];
        if (!z) return false;
        if (z.enabled === enabled) return true;
        const r = await get().upsert({ zone_id: z.zone_id, kind: z.kind, name: z.name, emoji: z.emoji, center: z.center, radius_m: z.radius_m, rules: z.rules, enabled });
        return r.ok;
      },

      requestMonitoringPermission: async () => {
        const ok = await deps.requestPermission().catch(() => false);
        for (const l of [...monitoringRequestListeners]) {
          try {
            l();
          } catch {
            // dinleyici hatası depoyu etkilemez
          }
        }
        return ok;
      },

      setZones: (list) => {
        const zones: Record<string, Zone> = {};
        for (const z of list) zones[z.zone_id] = z;
        const presence: Record<string, ZonePresence> = {};
        for (const [id, p] of Object.entries(get().presence)) if (zones[id]) presence[id] = p;
        set({ zones, presence });
      },

      setPresence: (p) => {
        const zones = get().zones;
        const presence: Record<string, ZonePresence> = {};
        for (const [id, v] of Object.entries(p)) if (zones[id]) presence[id] = v;
        set({ presence });
      },

      setServerEvents: (list) => {
        serverEvents = list.map((e) => ({ zone_id: e.zone_id, transition: e.transition, at: e.occurred_at, notified: e.notified, suppressed: e.suppressed }));
        mergeEvents();
      },

      addLocalEvent: (e) => {
        localEvents = [e, ...localEvents.filter((l) => !sameEvent(l, e))].slice(0, RECENT_EVENTS_MAX);
        mergeEvents();
      },

      setMonitoring: (m) => {
        if (get().monitoring !== m) set({ monitoring: m });
      },

      reset: () => {
        serverEvents = [];
        localEvents = [];
        set({ zones: {}, presence: {}, recentEvents: [], pending: {}, monitoring: 'off' });
      },
    };
  });
}

export const zonesStore = createZonesStore();

export function useZonesStore<T>(selector: (s: ZonesState) => T): T {
  return useStore(zonesStore, selector);
}

/** Liste sırası: önce etkinler, sonra tür (Ev, İş, Okul, Özel) ve ad. */
export function selectZoneList(s: Pick<ZonesState, 'zones'>): Zone[] {
  const order: Record<ZoneKind, number> = { home: 0, work: 1, school: 2, custom: 3 };
  return Object.values(s.zones).sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || order[a.kind] - order[b.kind] || a.name.localeCompare(b.name, 'tr'),
  );
}
