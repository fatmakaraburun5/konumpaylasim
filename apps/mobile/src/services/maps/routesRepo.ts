/**
 * Rota + Tahmini Varış Süresi (ETA): `route_compute` callable'ı (Google Routes API anahtarı yalnızca sunucuda).
 *
 * Maliyet ve kota koruması (istemci tarafı; sunucu ayrıca önbellek + günlük sınır uygular):
 *  - Core `shouldRecomputeRoute`: kart görünmüyorsa ASLA; aynı hedef + mod için en az 60 sn ara;
 *    ben ≥150 m ya da hedef ≥100 m hareket edince ya da sonuç 5 dk eskiyince yeniden hesap.
 *  - Başarısız denemeler de "son deneme" sayılır (hata döngüsünde çağrı yağmuru olmaz).
 *  - Hedef + mod başına bellek içi önbellek: Araç → Yürüyüş → Araç geçişi tekrar ücret doğurmaz.
 *  - Aynı istek sürerken ikincisi gönderilmez (tek uçuş).
 *  - `quota_exceeded`: o UTC günü (core `quotaDay`) için hiç çağrı yapılmaz.
 *  - `maps_unavailable` (anahtar yok / Google hatası): sakin bir mesaj, 60 sn sonra kendiliğinden yeniden.
 * Önbellek yalnızca bellektedir (konum diske yazılmaz).
 */
import {
  decodePolyline,
  quotaDay,
  routeRecomputeReason,
  type EpochMs,
  type ErrorCode,
  type LatLng,
  type RouteComputeResponse,
  type RouteRecomputeReason,
  type RouteSnapshot,
  type TravelMode,
} from '@konum/core';
import { toKonumError } from '../../lib/errors';
import { routeCompute } from '../firebase/callables';

export interface RouteResult extends RouteComputeResponse {
  /** Çözülmüş çizgi (core `decodePolyline`); boş polyline → []. */
  points: LatLng[];
}

export interface RouteFailure {
  code: ErrorCode;
  /** Kartta ETA yerine gösterilen sakin Türkçe metin. */
  message: string;
}

export interface RouteEntry {
  targetKey: string;
  mode: TravelMode;
  /** Son deneme (başarılı ya da başarısız). */
  snapshot: RouteSnapshot;
  /** Son başarılı sonuç (hata sonrası da tutulur; hedef çok uzaklaşmadıkça gösterilebilir). */
  result: RouteResult | null;
  /** Son denemenin hatası (başarıda null). */
  error: RouteFailure | null;
}

export interface RouteQuery {
  /** Hedefin kimliği: `friend:<share_id>` ya da `pin:<lat,lng>`. Hedef değişince yeni kayıt. */
  targetKey: string;
  origin: LatLng;
  destination: LatLng;
  mode: TravelMode;
  /** ETA kartı ekranda ve uygulama ön planda mı. */
  visible: boolean;
}

export interface RoutesRepo {
  peek: (targetKey: string, mode: TravelMode) => RouteEntry | null;
  /** Politika izin verirse `route_compute` çağırır; vermezse önbellekteki kaydı döndürür (yoksa null). */
  refresh: (q: RouteQuery) => Promise<RouteEntry | null>;
  /** Neden çağrılacağı (teşhis/test); çağrı yapılmayacaksa null. */
  wouldRecompute: (q: RouteQuery) => RouteRecomputeReason | null;
  clear: () => void;
  /** Bu süreçte yapılan ağ çağrısı sayısı (teşhis/test). */
  calls: () => number;
}

export interface RoutesRepoDeps {
  compute: typeof routeCompute;
  now: () => EpochMs;
  /** Bellek içi kayıt üst sınırı (en eski silinir). */
  maxEntries: number;
}

/** Sakin hata metinleri (ETA'nın yerine). */
export const ROUTE_ERROR_TEXT: Partial<Record<ErrorCode, string>> = {
  maps_unavailable: 'Varış süresi şu an hesaplanamıyor. Birazdan yeniden denenecek.',
  quota_exceeded: 'Bugünlük rota hesaplama sınırına ulaşıldı. Yarın yeniden açılır.',
  route_not_found: 'Bu iki nokta arasında rota bulunamadı.',
  rate_limited: 'Çok sık rota istendi. Birazdan yeniden denenecek.',
  unavailable: 'Bağlantı yok. Varış süresi bağlantı gelince hesaplanacak.',
};
const DEFAULT_ROUTE_ERROR = 'Varış süresi şu an hesaplanamıyor.';

export const routeFailure = (code: ErrorCode): RouteFailure => ({ code, message: ROUTE_ERROR_TEXT[code] ?? DEFAULT_ROUTE_ERROR });

const entryKey = (targetKey: string, mode: TravelMode) => `${targetKey}|${mode}`;

export function createRoutesRepo(overrides: Partial<RoutesRepoDeps> = {}): RoutesRepo {
  const deps: RoutesRepoDeps = { compute: routeCompute, now: () => Date.now(), maxEntries: 32, ...overrides };
  const entries = new Map<string, RouteEntry>();
  const inflight = new Map<string, Promise<RouteEntry | null>>();
  let quotaBlockedDay: string | null = null;
  let callCount = 0;

  const put = (e: RouteEntry) => {
    const k = entryKey(e.targetKey, e.mode);
    entries.delete(k);
    entries.set(k, e);
    while (entries.size > deps.maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  const reason = (q: RouteQuery, t: EpochMs): RouteRecomputeReason | null => {
    if (quotaBlockedDay !== null && quotaBlockedDay === quotaDay(t)) return null;
    // Hedef + mod başına son deneme: mod değişimi kendi kaydına bakar (önbellekteyse ücret yok).
    const last = entries.get(entryKey(q.targetKey, q.mode))?.snapshot ?? null;
    return routeRecomputeReason({ last, origin: q.origin, destination: q.destination, travelMode: q.mode, now: t, visible: q.visible });
  };

  const peekWithQuota = (targetKey: string, mode: TravelMode): RouteEntry | null => {
    const e = entries.get(entryKey(targetKey, mode)) ?? null;
    const t = deps.now();
    if (quotaBlockedDay !== null && quotaBlockedDay === quotaDay(t)) {
      // Kota dolduysa yeni hesap yok; eldeki sonuç varsa o, yoksa kota mesajı.
      if (e?.result) return e;
      return e ? { ...e, error: routeFailure('quota_exceeded') } : null;
    }
    return e;
  };

  return {
    peek: peekWithQuota,

    wouldRecompute: (q) => reason(q, deps.now()),

    refresh: (q) => {
      const k = entryKey(q.targetKey, q.mode);
      const running = inflight.get(k);
      if (running) return running;
      const t = deps.now();
      if (quotaBlockedDay !== null && quotaBlockedDay !== quotaDay(t)) quotaBlockedDay = null; // yeni gün
      if (q.visible && quotaBlockedDay !== null) {
        const prev = entries.get(k);
        const snapshot: RouteSnapshot = prev?.snapshot ?? { origin: q.origin, destination: q.destination, travel_mode: q.mode, computed_at: t };
        const blocked: RouteEntry = { targetKey: q.targetKey, mode: q.mode, snapshot, result: prev?.result ?? null, error: routeFailure('quota_exceeded') };
        return Promise.resolve(blocked);
      }
      if (reason(q, t) === null) return Promise.resolve(peekWithQuota(q.targetKey, q.mode));

      const snapshot: RouteSnapshot = { origin: q.origin, destination: q.destination, travel_mode: q.mode, computed_at: t };
      const prev = entries.get(k);
      // Denemeyi HEMEN kaydet: istek sürerken ya da hata alırsa 60 sn kuralı işlesin.
      put({ targetKey: q.targetKey, mode: q.mode, snapshot, result: prev?.result ?? null, error: prev?.error ?? null });
      callCount++;
      const p = (async (): Promise<RouteEntry | null> => {
        try {
          const res = await deps.compute({ origin: q.origin, destination: q.destination, travel_mode: q.mode });
          const entry: RouteEntry = { targetKey: q.targetKey, mode: q.mode, snapshot, result: { ...res, points: decodePolyline(res.polyline) }, error: null };
          put(entry);
          return entry;
        } catch (e) {
          const err = toKonumError(e);
          if (err.code === 'quota_exceeded') quotaBlockedDay = quotaDay(deps.now());
          // Rota yoksa eski çizgi yanıltır: sonucu düşür. Diğer hatalarda son başarılı sonuç kalır.
          const keepResult = err.code === 'route_not_found' ? null : (prev?.result ?? null);
          const entry: RouteEntry = { targetKey: q.targetKey, mode: q.mode, snapshot, result: keepResult, error: routeFailure(err.code) };
          put(entry);
          return entry;
        } finally {
          inflight.delete(k);
        }
      })();
      inflight.set(k, p);
      return p;
    },

    clear: () => {
      entries.clear();
      inflight.clear();
      quotaBlockedDay = null;
    },

    calls: () => callCount,
  };
}

/** Uygulamanın tek rota deposu (bellek içi). */
export const routesRepo = createRoutesRepo();
