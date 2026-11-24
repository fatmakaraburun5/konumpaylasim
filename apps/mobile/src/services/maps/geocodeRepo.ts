/**
 * Adres satırı: `geocode_reverse` callable'ı (Google Geocoding API anahtarı yalnızca sunucuda).
 *
 * Maliyet koruması (istemci tarafı; sunucu ayrıca 30 günlük hücre önbelleği + günlük sınır uygular):
 *  - Adres, konumun geohash hücresine (core `geocodeCell`, ≈150 m) bağlıdır; aynı hücre için ikinci çağrı yok.
 *  - Core `shouldReverseGeocode`: görünmüyorsa asla; aynı özne için en az 60 sn ara ve ≥200 m hareket.
 *    Özne (seçili arkadaş / bırakılan nokta) değişince ilk sorgu hemen yapılır.
 *  - Başarısız sorgu 60 sn boyunca tekrarlanmaz; `quota_exceeded` o UTC günü boyunca çağrıyı durdurur.
 *  - Bellek içi önbellek (hücre → etiket), en çok 200 hücre; diske yazılmaz.
 */
import {
  geocodeCell,
  GEOCODE_POLICY,
  quotaDay,
  shouldReverseGeocode,
  type EpochMs,
  type ErrorCode,
  type GeocodeSnapshot,
  type LatLng,
} from '@konum/core';
import { toKonumError } from '../../lib/errors';
import { geocodeReverse } from '../firebase/callables';

export type AddressSource = 'cache' | 'network' | 'stale' | 'none';

export interface AddressResult {
  /** Kısa adres; null = adres yok (deniz, kır) ya da henüz bilinmiyor (`source` ile ayırt edilir). */
  label: string | null;
  cell: string;
  source: AddressSource;
  error: ErrorCode | null;
}

export interface GeocodeQuery {
  /** Öznenin kimliği (aynı `targetKey` ile). */
  subjectKey: string;
  position: LatLng;
  visible: boolean;
}

export interface GeocodeRepo {
  /** Hücre önbelleğindeki etiket (çağrı yapmaz). undefined = bilinmiyor. */
  peek: (position: LatLng) => string | null | undefined;
  lookup: (q: GeocodeQuery) => Promise<AddressResult>;
  clear: () => void;
  calls: () => number;
}

export interface GeocodeRepoDeps {
  reverse: typeof geocodeReverse;
  now: () => EpochMs;
  maxCells: number;
}

interface SubjectState {
  last: GeocodeSnapshot | null;
  label: string | null;
  failedAt: EpochMs | null;
}

export function createGeocodeRepo(overrides: Partial<GeocodeRepoDeps> = {}): GeocodeRepo {
  const deps: GeocodeRepoDeps = { reverse: geocodeReverse, now: () => Date.now(), maxCells: 200, ...overrides };
  const cells = new Map<string, string | null>();
  const subjects = new Map<string, SubjectState>();
  const inflight = new Map<string, Promise<AddressResult>>();
  let quotaBlockedDay: string | null = null;
  let callCount = 0;

  const remember = (cell: string, label: string | null) => {
    cells.delete(cell);
    cells.set(cell, label);
    while (cells.size > deps.maxCells) {
      const oldest = cells.keys().next().value;
      if (oldest === undefined) break;
      cells.delete(oldest);
    }
  };

  return {
    peek: (position) => {
      const cell = geocodeCell(position);
      return cells.has(cell) ? (cells.get(cell) ?? null) : undefined;
    },

    lookup: (q) => {
      const cell = geocodeCell(q.position);
      const subject = subjects.get(q.subjectKey) ?? { last: null, label: null, failedAt: null };
      if (cells.has(cell)) {
        const label = cells.get(cell) ?? null;
        subjects.set(q.subjectKey, { ...subject, label });
        return Promise.resolve({ label, cell, source: 'cache', error: null });
      }
      const stale = (error: ErrorCode | null): AddressResult => ({ label: subject.label, cell, source: subject.label === null ? 'none' : 'stale', error });
      const t = deps.now();
      if (!q.visible) return Promise.resolve(stale(null));
      if (quotaBlockedDay !== null) {
        if (quotaBlockedDay === quotaDay(t)) return Promise.resolve(stale('quota_exceeded'));
        quotaBlockedDay = null;
      }
      if (subject.failedAt !== null && t - subject.failedAt < GEOCODE_POLICY.minIntervalMs) return Promise.resolve(stale(null));
      if (!shouldReverseGeocode({ last: subject.last, position: q.position, now: t, visible: q.visible })) return Promise.resolve(stale(null));

      const running = inflight.get(cell);
      if (running) return running;
      callCount++;
      subjects.set(q.subjectKey, { ...subject, last: { lat: q.position.lat, lng: q.position.lng, at: t } });
      const p = (async (): Promise<AddressResult> => {
        try {
          const res = await deps.reverse(q.position);
          remember(res.cell, res.label);
          if (res.cell !== cell) remember(cell, res.label);
          const cur = subjects.get(q.subjectKey);
          subjects.set(q.subjectKey, { last: cur?.last ?? null, label: res.label, failedAt: null });
          return { label: res.label, cell, source: 'network', error: null };
        } catch (e) {
          const err = toKonumError(e);
          if (err.code === 'quota_exceeded') quotaBlockedDay = quotaDay(deps.now());
          const cur = subjects.get(q.subjectKey);
          // Başarısız sorgu "son sorgu" sayılmaz (aynı noktada sonra yeniden denensin) ama 60 sn beklenir.
          subjects.set(q.subjectKey, { last: subject.last, label: cur?.label ?? subject.label, failedAt: deps.now() });
          return { label: subject.label, cell, source: subject.label === null ? 'none' : 'stale', error: err.code };
        } finally {
          inflight.delete(cell);
        }
      })();
      inflight.set(cell, p);
      return p;
    },

    clear: () => {
      cells.clear();
      subjects.clear();
      inflight.clear();
      quotaBlockedDay = null;
    },

    calls: () => callCount,
  };
}

/** Uygulamanın tek adres deposu (bellek içi). */
export const geocodeRepo = createGeocodeRepo();
