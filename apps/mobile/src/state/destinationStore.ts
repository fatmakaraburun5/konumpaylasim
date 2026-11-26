/**
 * Faz 9: paylaşım hedefi ve 200 m yaklaşma durumu — core `approach.ts`, docs/PHASE9.md §2.
 *
 *  - Kullanıcının aynı anda TEK etkin hedefi vardır (`konum.bg.destination.v1`), tüm arkadaş paylaşım oturumlarına
 *    uygulanır. Kaynak: kayıtlı bölge (yarıçap bölgeninki), haritadan nokta ("Hedefim yap", 75 m), etkinlik mekanı,
 *    buluşma noktası. Koordinat cihazdan ÇIKMAZ; alıcılara yalnızca ad + durum, sunucuya koordinatsız `dest_key`.
 *  - Algılama ve "Neredeyse vardım" raporu konum hattındadır (`services/location/f9Hooks`, başsız da çalışır); bu
 *    depo kaydı okur ve kancanın değişikliklerini (`onF9HookChange`) yansıtır.
 *  - Hedef değişince / kalkınca `onDestinationChange` (f9Services hemen yayınlar). Tüm arkadaş paylaşımları bitince
 *    f9Services hedefi siler.
 */
import {
  makeDestination,
  type ApproachState,
  type DestinationKind,
  type DestState,
  type EpochMs,
  type LatLng,
  type SessionId,
  type ShareDestination,
  type UserId,
  type Zone,
} from '@konum/core';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { now as serverClockNow } from '../lib/clock';
import { onF9HookChange } from '../services/location/f9Hooks';
import { authStore } from './authStore';
import { loadDestination, saveDestination, type ApproachReportResult, type PersistedDestination } from './persist';

export interface DestinationInput {
  kind: DestinationKind;
  /** Bölge / etkinlik / buluşma kimliği; nokta için yok. */
  ref_id?: string | null;
  name: string;
  center: LatLng;
  /** Varış yarıçapı (bölgeninki); verilmezse nokta varsayılanı (75 m). */
  radius_m?: number | null;
}

export interface DestinationState {
  hydrated: boolean;
  destination: ShareDestination | null;
  /** Oturum başına yaklaşma durumu (core `ApproachState`). */
  approach: Record<SessionId, ApproachState>;
  /** Son "Neredeyse vardım" raporu (toast: `APPROACH_TEXT.sentToast(notified_count)`). */
  lastReport: ApproachReportResult | null;
  /** Rapor çevrimdışı bekliyor mu. */
  reportPending: boolean;
  hydrate(): Promise<void>;
  /** Kancanın / başka bağlamın yazdığı kaydı yeniden okur. */
  reload(): Promise<void>;
  setDestination(input: DestinationInput): Promise<ShareDestination | null>;
  /** Kayıtlı bölgeyi hedef yap (Faz 5 `Zone`). */
  setZoneDestination(zone: Pick<Zone, 'zone_id' | 'name' | 'center' | 'radius_m'>): Promise<ShareDestination | null>;
  clear(): Promise<void>;
  reset(): Promise<void>;
}

export interface DestinationStoreDeps {
  now: () => EpochMs;
  myUid: () => UserId | null;
  load: () => Promise<PersistedDestination | null>;
  save: (v: PersistedDestination | null) => Promise<void>;
}

const listeners = new Set<() => void>();
/** Hedef eklendi / değişti / kalktı (paket alanları değişti → f9Services hemen yayınlar). */
export function onDestinationChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
const notifyChange = () => {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // önemsiz
    }
  }
};

const RANK: Record<DestState, number> = { en_route: 0, near: 1, arrived: 2 };

/** Gönderen kitapçığı için hedef durumu: oturumların en ilerisi (yoksa en_route). Saf. */
export function selectDestinationStatus(s: Pick<DestinationState, 'destination' | 'approach'>): { state: DestState; distance_m: number | null } | null {
  if (!s.destination) return null;
  let state: DestState = 'en_route';
  let distance: number | null = null;
  for (const a of Object.values(s.approach)) {
    if (a.dest_key !== s.destination.key) continue;
    const st: DestState = a.arrived_at !== null ? 'arrived' : a.phase === 'fired' ? 'near' : 'en_route';
    if (RANK[st] > RANK[state]) state = st;
    if (a.last_distance_m !== null && (distance === null || a.last_distance_m < distance)) distance = a.last_distance_m;
  }
  return { state, distance_m: distance };
}

export function createDestinationStore(overrides: Partial<DestinationStoreDeps> = {}): StoreApi<DestinationState> {
  const deps: DestinationStoreDeps = {
    now: serverClockNow,
    myUid: () => authStore.getState().uid,
    load: loadDestination,
    save: saveDestination,
    ...overrides,
  };

  return createStore<DestinationState>()((set, get) => {
    const apply = (rec: PersistedDestination | null) => {
      const me = deps.myUid();
      if (!rec || !me || rec.uid !== me) {
        set({ destination: null, approach: {}, lastReport: null, reportPending: false, hydrated: true });
        return;
      }
      set({ destination: rec.destination, approach: rec.approach, lastReport: rec.last_report, reportPending: rec.pending_report !== null, hydrated: true });
    };

    return {
      hydrated: false,
      destination: null,
      approach: {},
      lastReport: null,
      reportPending: false,

      hydrate: async () => apply(await deps.load().catch(() => null)),
      reload: async () => apply(await deps.load().catch(() => null)),

      setDestination: async (input) => {
        const me = deps.myUid();
        if (!me) return null;
        const dest = makeDestination({ kind: input.kind, ref_id: input.ref_id ?? null, name: input.name, center: input.center, radius_m: input.radius_m ?? null, now: deps.now() });
        const prev = await deps.load().catch(() => null);
        // Aynı hedef yeniden seçildi: tek seferlik hak korunur (durum sıfırlanmaz).
        const same = prev && prev.uid === me && prev.destination.key === dest.key;
        const rec: PersistedDestination = same
          ? { ...prev, destination: { ...dest, set_at: prev.destination.set_at } }
          : { uid: me, destination: dest, approach: {}, pending_report: null, last_report: null };
        await deps.save(rec);
        apply(rec);
        notifyChange();
        return rec.destination;
      },

      setZoneDestination: (zone) => get().setDestination({ kind: 'zone', ref_id: zone.zone_id, name: zone.name, center: zone.center, radius_m: zone.radius_m }),

      clear: async () => {
        const had = get().destination !== null;
        await deps.save(null).catch(() => undefined);
        apply(null);
        if (had) notifyChange();
      },

      reset: async () => {
        await deps.save(null).catch(() => undefined);
        set({ destination: null, approach: {}, lastReport: null, reportPending: false, hydrated: false });
      },
    };
  });
}

export const destinationStore = createDestinationStore();

// Konum hattı (aynı JS bağlamı) yaklaşma durumunu yazdı → depo yeniden okur.
onF9HookChange((e) => {
  if (e.kind === 'destination') void destinationStore.getState().reload();
});

export function useDestinationStore<T>(selector: (s: DestinationState) => T): T {
  return useStore(destinationStore, selector);
}
