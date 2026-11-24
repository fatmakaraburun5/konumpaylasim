/**
 * Google Maps Platform maliyet ve kota koruma kuralları (Maps SDK, Routes API, Geocoding API).
 * Saf: ağ çağrısı yok. Mobil "ne zaman sor" kararını, backend önbellek anahtarını ve
 * Google yanıtının ayrıştırılmasını buradan alır.
 *
 * Kurallar:
 *  1. Maps SDK (iOS / Android, native): harita yüklemesi ücretsiz. Tek `MapView` örneği tutulur,
 *     sekme değişiminde yeniden kurulmaz; statik harita / Street View kullanılmaz.
 *     Web görüntüleyicide Maps JavaScript API ücretlidir (yükleme başına): sayfa başına TEK harita,
 *     yeniden çizimde yeniden oluşturulmaz. [Varsayım: güncel fiyat listesi kontrol edilmeli]
 *  2. Routes API YALNIZCA sunucudan (`route_compute` callable) çağrılır; anahtar istemciye inmez.
 *     - İstemci yalnızca ETA kartı GÖRÜNÜRKEN ve `shouldRecomputeRoute` true iken sorar.
 *     - FieldMask yalnızca süre + mesafe + çizgi ister (`ROUTE_POLICY.fieldMask`): fazla alan
 *       daha pahalı SKU'ya geçirir.
 *     - DRIVE varsayılanı `TRAFFIC_UNAWARE` (Compute Routes Essentials SKU). Canlı trafik
 *       (`TRAFFIC_AWARE`, Pro SKU) yalnızca sunucu yapılandırmasıyla açılır. [Varsayım: Google SKU tablosu]
 *     - Sunucu önbelleği: başlangıç ve hedef hücresi (geohash 7 ≈ 150 m) + mod + 5 dk dilimi.
 *     - Kullanıcı başına günlük sınır; aşılınca `quota_exceeded`.
 *  3. Geocoding API (ters): yalnızca sunucudan (`geocode_reverse`). Hücre (geohash 7) başına
 *     önbellek; sunucu Google'a kullanıcının tam konumunu değil HÜCRE MERKEZİNİ sorar
 *     (önbellek kullanıcılar arası paylaşılır, kimsenin tam konumu başkasına sızmaz).
 *     İstemci yalnızca hücre değişip en az 200 m hareket olunca ve en çok dakikada bir sorar.
 *  4. Anahtar yoksa / Google hata verirse callable `maps_unavailable` döner; arayüz ETA kartını
 *     ve adresi gizler, harita ve pinler çalışmaya devam eder.
 *  5. Web görüntüleyici (salt okunur, anonim) Routes / Geocoding ÇAĞIRMAZ.
 *  6. Anahtarlar: sunucu anahtarı Secret Manager'da, yalnızca Routes + Geocoding API'lerine
 *     kısıtlı; mobil anahtarlar paket kimliği / SHA-1 ile, web anahtarı HTTP referrer ile kısıtlı.
 *     GCP konsolunda API başına günlük kota tavanı ve bütçe uyarısı. [Varsayım: sayılar]
 */
import { haversineM, type LatLng } from './geo';
import { DAY, MINUTE, SECOND, type EpochMs } from './time';

// ---------------------------------------------------------------------------
// Geohash
// ---------------------------------------------------------------------------

const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';
export const GEOHASH_RE = /^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/;

/** Standart geohash (base32). precision 7 ≈ 153 m × 153 m (ekvatorda; boylamda cos(enlem) ile daralır). */
export function geohashEncode(lat: number, lng: number, precision = 7): string {
  if (!Number.isInteger(precision) || precision < 1 || precision > 12) throw new Error('Geohash hassasiyeti 1..12 olmalı');
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error('Geçersiz koordinat');
  }
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180; // prettier-ignore
  let hash = '';
  let bit = 0;
  let ch = 0;
  let even = true; // çift bitler boylam
  while (hash.length < precision) {
    if (even) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) {
        ch = (ch << 1) | 1;
        lngLo = mid;
      } else {
        ch <<= 1;
        lngHi = mid;
      }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) {
        ch = (ch << 1) | 1;
        latLo = mid;
      } else {
        ch <<= 1;
        latHi = mid;
      }
    }
    even = !even;
    if (++bit === 5) {
      hash += GEOHASH_ALPHABET[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

export interface GeohashBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export function geohashBounds(hash: string): GeohashBounds {
  if (!GEOHASH_RE.test(hash)) throw new Error('Geçersiz geohash');
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180; // prettier-ignore
  let even = true;
  for (const c of hash) {
    const v = GEOHASH_ALPHABET.indexOf(c);
    for (let b = 4; b >= 0; b--) {
      const on = (v >> b) & 1;
      if (even) {
        const mid = (lngLo + lngHi) / 2;
        if (on) lngLo = mid;
        else lngHi = mid;
      } else {
        const mid = (latLo + latHi) / 2;
        if (on) latLo = mid;
        else latHi = mid;
      }
      even = !even;
    }
  }
  return { minLat: latLo, maxLat: latHi, minLng: lngLo, maxLng: lngHi };
}

/** Hücre merkezi. Sunucu ters geocode'u bu noktaya yapar. */
export function geohashCenter(hash: string): LatLng {
  const b = geohashBounds(hash);
  return { lat: (b.minLat + b.maxLat) / 2, lng: (b.minLng + b.maxLng) / 2 };
}

// ---------------------------------------------------------------------------
// Routes API
// ---------------------------------------------------------------------------

/** Routes API `travelMode` değerleri (alt küme). */
export type TravelMode = 'DRIVE' | 'WALK' | 'BICYCLE';
export const TRAVEL_MODES: readonly TravelMode[] = ['DRIVE', 'WALK', 'BICYCLE'];

export const TRAVEL_MODE_TEXT: Record<TravelMode, string> = {
  DRIVE: 'Araçla',
  WALK: 'Yürüyerek',
  BICYCLE: 'Bisikletle',
};

export const ROUTES_API_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

export const ROUTE_POLICY = {
  /** Başlangıç (ben) bu kadar hareket edince yeniden hesap. */
  minOriginMoveM: 150,
  /** Hedef (arkadaş) bu kadar hareket edince yeniden hesap. */
  minDestMoveM: 100,
  /** Aynı hedef için iki hesap arası en az süre (başarısız denemeler dahil). */
  minIntervalMs: 60 * SECOND,
  /** Kimse hareket etmese de ETA bu kadar eskiyince tazelenir (trafik değişir). */
  staleAfterMs: 5 * MINUTE,
  /** Sunucu önbelleği dilimi (anahtardaki zaman dilimi). [Varsayım: Google önbellek koşulları] */
  cacheTtlMs: 5 * MINUTE,
  /** Önbellek anahtarındaki geohash hassasiyeti. */
  cellPrecision: 7,
  /** Kullanıcı başına günlük `route_compute` (önbellekten dönenler sayılmaz). [Varsayım] */
  perUserDailyLimit: 200,
  /** `X-Goog-FieldMask`: Essentials alanları. */
  fieldMask: 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
  /**
   * Yalnızca DRIVE için varsayılan `routingPreference`. `TRAFFIC_UNAWARE` Essentials SKU'da kalır;
   * `TRAFFIC_AWARE` Pro SKU'dur ve yalnızca sunucu ayarıyla (`routesRequestBody` 4. parametre) açılır. [Varsayım]
   */
  drivePreference: 'TRAFFIC_UNAWARE' as DrivePreference,
} as const;

/** Routes API `routingPreference` (yalnızca DRIVE). */
export type DrivePreference = 'TRAFFIC_UNAWARE' | 'TRAFFIC_AWARE';

/** Bir hedef için son hesap (başarılı veya başarısız deneme). */
export interface RouteSnapshot {
  origin: LatLng;
  destination: LatLng;
  travel_mode: TravelMode;
  /** Denemenin yapıldığı an (istemci saati yeterli). */
  computed_at: EpochMs;
}

export interface RouteRecomputeInput {
  /** AYNI hedef için son deneme; hedef (seçili arkadaş / nokta) değişince null verin. */
  last: RouteSnapshot | null;
  origin: LatLng;
  destination: LatLng;
  travelMode: TravelMode;
  now: EpochMs;
  /** ETA kartı ekranda mı. Görünmüyorsa ASLA hesaplanmaz. */
  visible: boolean;
}

export type RouteRecomputeReason = 'first' | 'mode_changed' | 'origin_moved' | 'destination_moved' | 'stale';

/** Neden yeniden hesaplanmalı; gerekmiyorsa null. */
export function routeRecomputeReason(i: RouteRecomputeInput): RouteRecomputeReason | null {
  if (!i.visible) return null;
  if (!i.last) return 'first';
  // Kullanıcının açık seçimi: hemen (çoğu zaman sunucu önbelleğine düşer).
  if (i.last.travel_mode !== i.travelMode) return 'mode_changed';
  if (i.now - i.last.computed_at < ROUTE_POLICY.minIntervalMs) return null;
  if (haversineM(i.last.origin, i.origin) >= ROUTE_POLICY.minOriginMoveM) return 'origin_moved';
  if (haversineM(i.last.destination, i.destination) >= ROUTE_POLICY.minDestMoveM) return 'destination_moved';
  if (i.now - i.last.computed_at >= ROUTE_POLICY.staleAfterMs) return 'stale';
  return null;
}

export function shouldRecomputeRoute(i: RouteRecomputeInput): boolean {
  return routeRecomputeReason(i) !== null;
}

/**
 * Sunucu önbellek anahtarı: `<başlangıç hücresi>.<hedef hücresi>.<mod>.<5 dk dilimi>[.<kapsam>]`.
 * Firestore belge kimliği olarak güvenlidir (`/` yok). `scope` verilirse (ör. uid) önbellek
 * kullanıcıya özel olur: başkasının tam başlangıç noktasıyla başlayan çizgi paylaşılmaz.
 * [Varsayım] Önerilen: scope = uid (kullanıcılar arası isabet zaten nadir).
 */
export function routeCacheKey(origin: LatLng, destination: LatLng, mode: TravelMode, now: EpochMs, scope?: string): string {
  const o = geohashEncode(origin.lat, origin.lng, ROUTE_POLICY.cellPrecision);
  const d = geohashEncode(destination.lat, destination.lng, ROUTE_POLICY.cellPrecision);
  const bucket = Math.floor(now / ROUTE_POLICY.cacheTtlMs);
  const key = `${o}.${d}.${mode}.${bucket}`;
  return scope ? `${key}.${scope}` : key;
}

/** `computeRoutes` istek gövdesi. Başlık: `X-Goog-FieldMask: ROUTE_POLICY.fieldMask`. */
export function routesRequestBody(
  origin: LatLng,
  destination: LatLng,
  mode: TravelMode,
  opts: { drivePreference?: DrivePreference } = {},
): Record<string, unknown> {
  const point = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  return {
    origin: point(origin),
    destination: point(destination),
    travelMode: mode,
    // WALK / BICYCLE'da routingPreference verilirse API hata döner.
    ...(mode === 'DRIVE' ? { routingPreference: opts.drivePreference ?? ROUTE_POLICY.drivePreference } : {}),
    computeAlternativeRoutes: false,
    languageCode: 'tr-TR',
    units: 'METRIC',
  };
}

export interface ParsedRoute {
  distance_m: number;
  duration_s: number;
  polyline: string;
}

/**
 * `computeRoutes` yanıtı → ilk rota. Rota yoksa (`{}`) null.
 * `duration` "123s" biçiminde metindir; proto3 varsayılanı olarak 0 değerli alanlar gelmeyebilir.
 */
export function parseRoutesResponse(json: unknown): ParsedRoute | null {
  const routes = (json as { routes?: unknown } | null)?.routes;
  if (!Array.isArray(routes) || routes.length === 0) return null;
  const r = routes[0] as { distanceMeters?: unknown; duration?: unknown; polyline?: { encodedPolyline?: unknown } } | null;
  if (!r || typeof r !== 'object') return null;
  const dm = r.distanceMeters ?? 0;
  const dur = typeof r.duration === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(r.duration) : null;
  if (typeof dm !== 'number' || !Number.isFinite(dm) || dm < 0 || !dur) return null;
  const polyline = typeof r.polyline?.encodedPolyline === 'string' ? r.polyline.encodedPolyline : '';
  return { distance_m: Math.round(dm), duration_s: Math.round(Number(dur[1])), polyline };
}

// ---------------------------------------------------------------------------
// Geocoding API (ters)
// ---------------------------------------------------------------------------

export const GEOCODE_API_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

export const GEOCODE_POLICY = {
  /** Önbellek hücresi (geohash 7 ≈ 150 m). */
  cellPrecision: 7,
  /** Hücre değişse bile en az bu kadar hareket gerekir (hücre sınırında titreme). */
  minMoveM: 200,
  /** İki sorgu arası en az süre. [Varsayım] */
  minIntervalMs: 60 * SECOND,
  /** [Varsayım: Google Maps Platform önbellek koşulları kontrol edilmeli; enlem/boylam için 30 gün.] */
  cacheTtlMs: 30 * DAY,
  /** Kullanıcı başına günlük `geocode_reverse` (önbellekten dönenler sayılmaz). [Varsayım] */
  perUserDailyLimit: 100,
  language: 'tr',
} as const;

/** Konumun adres hücresi (önbellek anahtarı, `geocode_reverse` yanıtındaki `cell`). */
export function geocodeCell(p: LatLng): string {
  return geohashEncode(p.lat, p.lng, GEOCODE_POLICY.cellPrecision);
}

export interface GeocodeSnapshot extends LatLng {
  /** Son sorgunun yapıldığı an. */
  at: EpochMs;
}

export interface ReverseGeocodeInput {
  last: GeocodeSnapshot | null;
  position: LatLng;
  now: EpochMs;
  /** Adres ekranda mı. Varsayılan true. */
  visible?: boolean;
}

/** İstemci tarafı: `geocode_reverse` çağrılmalı mı. Aynı hücre → hayır (etiket hücreye bağlı). */
export function shouldReverseGeocode(i: ReverseGeocodeInput): boolean {
  if (i.visible === false) return false;
  if (!i.last) return true;
  if (i.now - i.last.at < GEOCODE_POLICY.minIntervalMs) return false;
  if (geocodeCell(i.last) === geocodeCell(i.position)) return false;
  return haversineM(i.last, i.position) >= GEOCODE_POLICY.minMoveM;
}

/** Sunucunun Google'a sorduğu nokta: hücre merkezi (tam konum değil). */
export function geocodeQueryPoint(cell: string): LatLng {
  return geohashCenter(cell);
}

export type ReverseGeocodeResult = { ok: true; label: string | null } | { ok: false; retryable: boolean };

interface AddressComponent {
  long_name?: unknown;
  types?: unknown;
}

const component = (comps: readonly AddressComponent[], ...types: string[]): string | null => {
  for (const t of types) {
    const c = comps.find((x) => Array.isArray(x.types) && x.types.includes(t));
    if (c && typeof c.long_name === 'string' && c.long_name.trim()) return c.long_name.trim();
  }
  return null;
};

/**
 * Geocoding yanıtı → kısa Türkçe etiket ("Moda Caddesi, Kadıköy").
 * [Varsayım] Sokak/mahalle + ilçe; yoksa `formatted_address` (", Türkiye" atılır).
 * ZERO_RESULTS → `label: null` (deniz, orman). Kota/geçici hata → yeniden denenebilir.
 */
export function parseReverseGeocodeResponse(json: unknown): ReverseGeocodeResult {
  const j = json as { status?: unknown; results?: unknown } | null;
  const status = typeof j?.status === 'string' ? j.status : '';
  if (status === 'ZERO_RESULTS') return { ok: true, label: null };
  if (status !== 'OK') return { ok: false, retryable: status === 'OVER_QUERY_LIMIT' || status === 'UNKNOWN_ERROR' || status === '' };
  const first = Array.isArray(j?.results) ? (j.results[0] as { formatted_address?: unknown; address_components?: unknown }) : undefined;
  if (!first) return { ok: true, label: null };
  const comps = Array.isArray(first.address_components) ? (first.address_components as AddressComponent[]) : [];
  const street = component(comps, 'route');
  const area = component(comps, 'neighborhood', 'sublocality_level_1', 'administrative_area_level_4', 'sublocality');
  const district = component(comps, 'administrative_area_level_2', 'locality', 'administrative_area_level_1');
  const parts = [street ?? area, district].filter((p, i, a): p is string => !!p && a.indexOf(p) === i);
  if (parts.length) return { ok: true, label: parts.join(', ') };
  const fa = typeof first.formatted_address === 'string' ? first.formatted_address.replace(/,\s*(Türkiye|Turkey)$/i, '').trim() : '';
  return { ok: true, label: fa || null };
}

// ---------------------------------------------------------------------------
// Kota
// ---------------------------------------------------------------------------

export type MapsQuotaKind = 'route' | 'geocode';

export const MAPS_DAILY_LIMITS: Record<MapsQuotaKind, number> = {
  route: ROUTE_POLICY.perUserDailyLimit,
  geocode: GEOCODE_POLICY.perUserDailyLimit,
};

/** Kota günü: UTC "YYYY-MM-DD" (`PATHS.mapsQuota(uid, day)`). [Varsayım] UTC gün sınırı. */
export function quotaDay(now: EpochMs): string {
  return new Date(now).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Encoded polyline (Google algoritması, 1e5 hassasiyet)
// ---------------------------------------------------------------------------

/** Bozuk girdide o ana kadar çözülen noktaları döner (asla fırlatmaz; harita çökmesin). */
export function decodePolyline(encoded: string, precision = 5): LatLng[] {
  const factor = 10 ** precision;
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = (): number | null => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (index >= encoded.length) return null;
      const b = encoded.charCodeAt(index++) - 63;
      if (b < 0 || b > 63) return null;
      result += (b & 0x1f) * 2 ** shift;
      shift += 5;
      if (b < 0x20) break;
      if (shift > 35) return null;
    }
    return result % 2 === 1 ? -(result + 1) / 2 : result / 2;
  };
  while (index < encoded.length) {
    const dLat = next();
    if (dLat === null) break;
    const dLng = next();
    if (dLng === null) break;
    lat += dLat;
    lng += dLng;
    points.push({ lat: lat / factor, lng: lng / factor });
  }
  return points;
}

/** Testler ve sahte (mock) Routes yanıtları için. */
export function encodePolyline(points: readonly LatLng[], precision = 5): string {
  const factor = 10 ** precision;
  const enc = (v: number): string => {
    let n = v < 0 ? -2 * v - 1 : 2 * v;
    let out = '';
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n % 32)) + 63);
      n = Math.floor(n / 32);
    }
    return out + String.fromCharCode(n + 63);
  };
  let pLat = 0;
  let pLng = 0;
  let out = '';
  for (const p of points) {
    const lat = Math.round(p.lat * factor);
    const lng = Math.round(p.lng * factor);
    out += enc(lat - pLat) + enc(lng - pLng);
    pLat = lat;
    pLng = lng;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Türkçe ETA ve mesafe metinleri
// ---------------------------------------------------------------------------

const DASH = '–';

/** ETA: "4 dk", "1 sa 5 dk", "2 sa", "1 gün 3 sa". Dakikaya yuvarlanır, en az "1 dk". */
export function formatEtaDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return DASH;
  const totalMin = Math.max(1, Math.round(seconds / 60));
  if (totalMin < 60) return `${totalMin} dk`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m ? `${h} sa ${m} dk` : `${h} sa`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d} gün ${hh} sa` : `${d} gün`;
}

const groupThousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Mesafe: "45 m", "850 m", "3,2 km", "5 km", "12 km", "1.234 km" (Türkçe ondalık virgül). */
export function formatDistanceTr(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return DASH;
  if (meters < 1000) {
    const r = meters < 100 ? Math.round(meters) : Math.round(meters / 10) * 10;
    if (r < 1000) return `${r} m`;
  }
  const km = meters / 1000;
  if (km < 10) {
    const v = Math.round(km * 10) / 10;
    if (v < 10) {
      const s = v.toFixed(1).replace('.', ',');
      return `${s.endsWith(',0') ? s.slice(0, -2) : s} km`;
    }
  }
  return `${groupThousands(Math.round(km))} km`;
}

/** ETA alt kartı özeti: "12 dk · 3,2 km". */
export function formatRouteSummary(durationS: number, distanceM: number): string {
  return `${formatEtaDuration(durationS)} · ${formatDistanceTr(distanceM)}`;
}
