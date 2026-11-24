/**
 * Faz 2: Google Maps sunucu vekili — `route_compute` (Routes API computeRoutes) ve `geocode_reverse`
 * (Geocoding API, ters). Anahtar YALNIZCA sunucuda (Secret Manager `GOOGLE_MAPS_SERVER_KEY`); istemci Google'a
 * doğrudan gitmez. Maliyet ve kota koruması (sırayla):
 *
 *  1. İstemci yalnızca kart görünürken ve core `shouldRecomputeRoute` / `shouldReverseGeocode` true iken sorar.
 *  2. Callable'lar App Check ister (üretimde): uygulama dışı betikler anahtarı harcayamaz.
 *  3. Önbellek (Firestore, yalnızca sunucu; `expire_at` TTL alanı):
 *     - `route_cache/{başlangıç hücresi.hedef hücresi.mod.5 dk dilimi.uid}`: 5 dk. Kullanıcıya özel (uid kapsamı):
 *       çizgi başkasının tam başlangıç noktasından başlamasın.
 *     - `geocode_cache/{geohash7}`: 30 gün [Varsayım: Google önbellek koşulları]. Google'a kullanıcının tam konumu
 *       değil HÜCRE MERKEZİ sorulur; bu yüzden önbellek kullanıcılar arasında paylaşılır.
 *     Önbellek isabeti kotadan düşmez ve anahtar gerektirmez.
 *  4. Kullanıcı başına günlük sınır (core `MAPS_DAILY_LIMITS`: route 200, geocode 100) ve proje geneli günlük
 *     bütçe / kapatma (`MAPS_DAILY_BUDGET` ortam değişkeni ya da `config/maps` belgesi). Sayaç Google'dan ÖNCE
 *     transaction ile ayrılır (eşzamanlı çağrılar sınırı aşamaz); aşımda `quota_exceeded`.
 *  5. Routes: FieldMask yalnızca süre + mesafe + çizgi (`ROUTE_POLICY.fieldMask`) ve DRIVE'da varsayılan
 *     `TRAFFIC_UNAWARE` (Essentials SKU). [Varsayım] `ROUTES_DRIVE_PREFERENCE=TRAFFIC_AWARE` Pro SKU'ya geçirir.
 *  6. Anahtar yok / Google hatası / zaman aşımı → `maps_unavailable` (yeniden denenebilir); rota yok →
 *     `route_not_found`. Arayüz ETA kartını ve adresi gizler, harita çalışmaya devam eder.
 *  7. Loglarda koordinat, hücre, polyline, adres ve URL (anahtar + koordinat içerir) YOKTUR: yalnızca tür,
 *     HTTP durum kodu ve sonuç sınıfı.
 *
 * Testler `deps` ile sahte `fetch`, anahtar, bütçe ve parça seçimi verir (gerçek Google çağrısı yok).
 */
import {
  type EpochMs,
  GEOCODE_API_URL,
  GEOCODE_POLICY,
  type GeocodeReverseRequestSchema,
  type GeocodeReverseResponse,
  MAPS_DAILY_LIMITS,
  type MapsQuotaKind,
  ROUTES_API_URL,
  ROUTE_POLICY,
  type RouteComputeRequestSchema,
  type RouteComputeResponse,
  type TravelMode,
  DAY,
  geocodeCell,
  geocodeQueryPoint,
  parseReverseGeocodeResponse,
  parseRoutesResponse,
  quotaDay,
  routeCacheKey,
  routesRequestBody,
} from '@konum/core';
import { Timestamp } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { db } from '../admin';
import type { CallCtx } from '../callable';
import { MAPS, mapsServerKey } from '../config';
import { refs } from '../docs';
import { fail } from '../errors';

// ---------------------------------------------------------------------------
// Bağımlılıklar (testlerde enjekte edilir)
// ---------------------------------------------------------------------------

export interface MapsHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type MapsFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<MapsHttpResponse>;

/** Proje geneli günlük bütçe (Google çağrısı sayısı). 0 = o tür kapalı. */
export interface MapsBudget {
  disabled: boolean;
  route: number;
  geocode: number;
}

export interface MapsDeps {
  fetch: MapsFetch;
  /** Sunucu anahtarı; yoksa null (→ `maps_unavailable`). */
  apiKey: () => string | null;
  budget: () => Promise<MapsBudget>;
  /** [0,1): bütçe parçası seçimi. */
  random: () => number;
  drivePreference: 'TRAFFIC_AWARE' | 'TRAFFIC_UNAWARE';
  timeoutMs: number;
}

const nodeFetch: MapsFetch = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown> };
};

/** `MAPS_DAILY_BUDGET`: `5000` (iki tür için) ya da `route=5000,geocode=3000`. Geçersizse varsayılan. */
export function parseBudgetEnv(raw: string | undefined): { route: number; geocode: number } {
  const out: { route: number; geocode: number } = { ...MAPS.defaultDailyBudget };
  const s = (raw ?? '').trim();
  if (!s) return out;
  if (/^\d+$/.test(s)) return { route: Number(s), geocode: Number(s) };
  for (const part of s.split(',')) {
    const m = /^\s*(route|geocode)\s*=\s*(\d+)\s*$/.exec(part);
    if (m) out[m[1] as MapsQuotaKind] = Number(m[2]);
  }
  return out;
}

interface MapsConfigDoc {
  disabled?: unknown;
  route_daily_budget?: unknown;
  geocode_daily_budget?: unknown;
}

let configCache: { at: EpochMs; value: MapsBudget } | null = null;

/** Testler: `config/maps` önbelleğini sıfırlar. */
export function resetMapsConfigCache(): void {
  configCache = null;
}

/** Ortam değişkeni + `config/maps` belgesi (belge önceliklidir; örnek içinde 60 sn önbellek). */
export async function loadMapsBudget(now: EpochMs = Date.now()): Promise<MapsBudget> {
  if (configCache && now - configCache.at < MAPS.configCacheMs) return configCache.value;
  const env = parseBudgetEnv(process.env.MAPS_DAILY_BUDGET);
  let value: MapsBudget = { disabled: false, ...env };
  try {
    const d = (await refs.mapsConfig().get()).data() as MapsConfigDoc | undefined;
    if (d) {
      const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fb);
      value = {
        disabled: d.disabled === true,
        route: num(d.route_daily_budget, env.route),
        geocode: num(d.geocode_daily_budget, env.geocode),
      };
    }
  } catch (err) {
    logger.warn('config/maps okunamadı (ortam değişkeni kullanılıyor)', { err: String(err) });
  }
  configCache = { at: now, value };
  return value;
}

export function defaultMapsDeps(): MapsDeps {
  return {
    fetch: nodeFetch,
    apiKey: mapsServerKey,
    budget: () => loadMapsBudget(),
    random: Math.random,
    drivePreference: MAPS.drivePreference,
    timeoutMs: MAPS.fetchTimeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Kota
// ---------------------------------------------------------------------------

const nextUtcDay = (now: EpochMs): EpochMs => (Math.floor(now / DAY) + 1) * DAY;

/**
 * Google çağrısından ÖNCE bir birim ayırır: kullanıcı sayacı (`maps_quota/{uid}_{gün}`) ve proje geneli bütçenin
 * rastgele bir parçası (`maps_budget/{gün}_{parça}`) aynı transaction'da. Sınır doluysa `quota_exceeded`.
 * Başarısız Google çağrısı birimi geri vermez (kötüye kullanımda da sayaç işler). [Varsayım]
 */
export async function reserveMapsQuota(uid: string, kind: MapsQuotaKind, now: EpochMs, deps: Pick<MapsDeps, 'budget' | 'random'>): Promise<void> {
  const budget = await deps.budget();
  const total = budget.disabled ? 0 : Math.max(0, Math.floor(budget[kind]));
  const retry = { retry_after_ms: nextUtcDay(now) - now };
  if (total <= 0) throw fail('quota_exceeded', { extra: { scope: 'global', ...retry } });
  const shards = Math.max(1, Math.min(MAPS.budgetShards, total));
  const perShard = Math.floor(total / shards);
  const shard = Math.min(shards - 1, Math.floor(Math.max(0, deps.random()) * shards));
  const day = quotaDay(now);
  const userRef = refs.mapsQuota(uid, day);
  const budgetRef = refs.mapsBudget(day, shard);
  const purge_at = Timestamp.fromMillis(now + MAPS.quotaDocTtlMs);
  await db().runTransaction(async (tx) => {
    const [u, g] = await tx.getAll(userRef, budgetRef);
    const used = Number((u?.data() as Record<string, unknown> | undefined)?.[kind] ?? 0) || 0;
    if (used >= MAPS_DAILY_LIMITS[kind]) throw fail('quota_exceeded', { extra: { scope: 'user', ...retry } });
    const spent = Number((g?.data() as Record<string, unknown> | undefined)?.[kind] ?? 0) || 0;
    if (spent >= perShard) throw fail('quota_exceeded', { extra: { scope: 'global', ...retry } });
    tx.set(userRef, { uid, day, [kind]: used + 1, updated_at: now, purge_at }, { merge: true });
    tx.set(budgetRef, { day, shard, [kind]: spent + 1, updated_at: now, purge_at }, { merge: true });
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function callGoogle(
  kind: MapsQuotaKind,
  deps: MapsDeps,
  url: string,
  init: Parameters<MapsFetch>[1],
): Promise<{ status: number; ok: boolean; json: unknown }> {
  let res: MapsHttpResponse;
  try {
    res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs) });
  } catch (err) {
    // Hata mesajı URL (anahtar + koordinat) içerebilir: yalnızca hata türü loglanır.
    logger.warn('maps: Google isteği başarısız', { kind, error: (err as { name?: string } | null)?.name ?? 'Error' });
    throw fail('maps_unavailable');
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json };
}

// ---------------------------------------------------------------------------
// route_compute
// ---------------------------------------------------------------------------

interface RouteCacheDoc {
  uid: string;
  distance_m: number;
  duration_s: number;
  polyline: string;
  computed_at: EpochMs;
  expire_at: Timestamp;
}

export async function routeCompute(
  ctx: CallCtx,
  data: z.output<typeof RouteComputeRequestSchema>,
  deps: MapsDeps = defaultMapsDeps(),
): Promise<RouteComputeResponse> {
  const mode: TravelMode = data.travel_mode;
  const key = routeCacheKey(data.origin, data.destination, mode, ctx.now, ctx.uid);
  const cacheRef = refs.routeCache(key);

  // 1. Önbellek (kota sayılmaz, anahtar gerekmez).
  const hit = (await cacheRef.get()).data() as RouteCacheDoc | undefined;
  if (hit && hit.uid === ctx.uid && hit.expire_at.toMillis() > ctx.now) {
    return { distance_m: hit.distance_m, duration_s: hit.duration_s, polyline: hit.polyline, cached: true, computed_at: hit.computed_at };
  }

  // 2. Anahtar, 3. kota.
  const apiKey = deps.apiKey();
  if (!apiKey) throw fail('maps_unavailable', { extra: { reason: 'not_configured' } });
  await reserveMapsQuota(ctx.uid, 'route', ctx.now, deps);

  // 4. Google Routes API (computeRoutes).
  const body = routesRequestBody(data.origin, data.destination, mode, { drivePreference: deps.drivePreference });
  const r = await callGoogle('route', deps, ROUTES_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': ROUTE_POLICY.fieldMask,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    // 400: geçersiz / desteklenmeyen rota (ör. yürüyüş için çok uzak); 401/403: anahtar; 429/5xx: geçici.
    logger.warn('maps: Routes API hata kodu', { status: r.status });
    if (r.status === 400 || r.status === 404) throw fail('route_not_found');
    throw fail('maps_unavailable');
  }
  const parsed = parseRoutesResponse(r.json);
  if (!parsed) throw fail('route_not_found');
  const polyline = parsed.polyline.length <= MAPS.maxPolylineLength ? parsed.polyline : '';

  // 5. Önbelleğe yaz (en iyi çaba).
  const doc: RouteCacheDoc = {
    uid: ctx.uid,
    distance_m: parsed.distance_m,
    duration_s: parsed.duration_s,
    polyline,
    computed_at: ctx.now,
    expire_at: Timestamp.fromMillis(ctx.now + ROUTE_POLICY.cacheTtlMs),
  };
  try {
    await cacheRef.set(doc);
  } catch (err) {
    logger.warn('maps: rota önbelleğe yazılamadı', { err: String(err) });
  }
  return { distance_m: doc.distance_m, duration_s: doc.duration_s, polyline, cached: false, computed_at: ctx.now };
}

// ---------------------------------------------------------------------------
// geocode_reverse
// ---------------------------------------------------------------------------

interface GeocodeCacheDoc {
  label: string | null;
  created_at: EpochMs;
  expire_at: Timestamp;
}

export function geocodeRequestUrl(cell: string, apiKey: string): string {
  const p = geocodeQueryPoint(cell);
  const q = new URLSearchParams({
    latlng: `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`,
    language: GEOCODE_POLICY.language,
    result_type: MAPS.geocodeResultTypes,
    key: apiKey,
  });
  return `${GEOCODE_API_URL}?${q.toString()}`;
}

export async function geocodeReverse(
  ctx: CallCtx,
  data: z.output<typeof GeocodeReverseRequestSchema>,
  deps: MapsDeps = defaultMapsDeps(),
): Promise<GeocodeReverseResponse> {
  const cell = geocodeCell(data);
  const cacheRef = refs.geocodeCache(cell);

  const hit = (await cacheRef.get()).data() as GeocodeCacheDoc | undefined;
  if (hit && hit.expire_at.toMillis() > ctx.now) return { label: hit.label ?? null, cell, cached: true };

  const apiKey = deps.apiKey();
  if (!apiKey) throw fail('maps_unavailable', { extra: { reason: 'not_configured' } });
  await reserveMapsQuota(ctx.uid, 'geocode', ctx.now, deps);

  const r = await callGoogle('geocode', deps, geocodeRequestUrl(cell, apiKey), { method: 'GET', headers: { Accept: 'application/json' } });
  if (!r.ok) {
    logger.warn('maps: Geocoding API hata kodu', { status: r.status });
    throw fail('maps_unavailable');
  }
  const parsed = parseReverseGeocodeResponse(r.json);
  if (!parsed.ok) {
    // REQUEST_DENIED / INVALID_REQUEST: yapılandırma hatası (anahtar kısıtı). Durum metni koordinat taşımaz.
    const status = typeof (r.json as { status?: unknown } | null)?.status === 'string' ? (r.json as { status: string }).status : '';
    (parsed.retryable ? logger.warn : logger.error)('maps: Geocoding API yanıt durumu', { status });
    throw fail('maps_unavailable');
  }
  const label = parsed.label === null ? null : parsed.label.slice(0, MAPS.maxLabelLength);
  try {
    await cacheRef.set({ label, created_at: ctx.now, expire_at: Timestamp.fromMillis(ctx.now + GEOCODE_POLICY.cacheTtlMs) } satisfies GeocodeCacheDoc);
  } catch (err) {
    logger.warn('maps: adres önbelleğe yazılamadı', { err: String(err) });
  }
  return { label, cell, cached: false };
}

// Callable sarmalayıcısı `(ctx, data)` imzası bekler.
export const routeComputeHandler = (ctx: CallCtx, data: z.output<typeof RouteComputeRequestSchema>) => routeCompute(ctx, data);
export const geocodeReverseHandler = (ctx: CallCtx, data: z.output<typeof GeocodeReverseRequestSchema>) => geocodeReverse(ctx, data);

// ---------------------------------------------------------------------------
// Faz 4: SOS adresi (en iyi çaba, kota DIŞI)
// ---------------------------------------------------------------------------

/**
 * Acil durum paketi için okunabilir adres: önce `geocode_cache` hücresi, yoksa (anahtar varsa) Google ters geocode.
 * Kullanıcı kotası ve proje bütçesi UYGULANMAZ [Varsayım: acil durum, saatlik SOS tavanı kötüye kullanımı sınırlar];
 * en çok `timeoutMs` beklenir; her hata yutulur → null (gönderimi asla engellemez). Sonuç önbelleğe yazılır.
 */
export async function sosAddressLookup(
  p: { lat: number; lng: number },
  now: EpochMs,
  deps: MapsDeps = defaultMapsDeps(),
  timeoutMs = 2_000,
): Promise<string | null> {
  const work = (async (): Promise<string | null> => {
    const cell = geocodeCell(p);
    const cacheRef = refs.geocodeCache(cell);
    const hit = (await cacheRef.get()).data() as GeocodeCacheDoc | undefined;
    if (hit && hit.expire_at.toMillis() > now) return hit.label ?? null;
    const apiKey = deps.apiKey();
    if (!apiKey) return null;
    const r = await callGoogle('geocode', { ...deps, timeoutMs: Math.min(deps.timeoutMs, timeoutMs) }, geocodeRequestUrl(cell, apiKey), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) return null;
    const parsed = parseReverseGeocodeResponse(r.json);
    if (!parsed.ok) return null;
    const label = parsed.label === null ? null : parsed.label.slice(0, MAPS.maxLabelLength);
    await cacheRef
      .set({ label, created_at: now, expire_at: Timestamp.fromMillis(now + GEOCODE_POLICY.cacheTtlMs) } satisfies GeocodeCacheDoc)
      .catch(() => undefined);
    return label;
  })().catch(() => null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
