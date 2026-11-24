/**
 * Faz 5: harita üzerinde "Buluşma noktası" önerisi.
 *
 * Hesap (sunucu `meetup_suggest`, saf parçalar burada):
 *  1. Merkez: 2 kişi için büyük daire orta noktası; 3–5 kişi için geometrik medyan (Weiszfeld, `meetupCenter`).
 *     Katılımcı konumu = arkadaşın canlı konumu, kendi konumum ya da seçilen hedef.
 *  2. Aday arama: Google Places API (New) `places:searchNearby`, merkez çevresinde `searchRadiusM(yayılım)` yarıçapı,
 *     kategoriye göre `includedTypes` (`MEETUP_CATEGORY_TYPES`), alan maskesi en dar (`PLACES_FIELD_MASK`).
 *  3. Erişim süresi: Routes API `computeRouteMatrix` (kaynaklar = katılımcılar, hedefler = en yakın `matrixTopK` aday;
 *     ulaşım modu katılımcı başına, aynı moddakiler tek matriste).
 *  4. Sıralama (`rankMeetupCandidates`): en uzun yolculuk süresini ve iki taraf arasındaki farkı en aza indir
 *     (adalet), puanı düşük / değerlendirmesi az yerlere küçük ceza. İlk `resultCount` öneri döner.
 *  5. Yedek: Places yanıt vermezse / kota dolarsa yalnızca "Orta nokta" önerisi (ETA'sı kuş uçuşu tahmini).
 *
 * Paylaşım: `meetup_share` ile Firestore `meetups/{id}` (gönderen + alıcılar okur), alıcıya push. Her iki taraf
 * öneri kartında herkesin ETA'sını görür; kendi canlı rotasını mevcut `route_compute` ile önizler.
 */
import { z } from 'zod';
import { haversineM, roundCoord, type LatLng } from './geo';
import { formatDistanceTr, formatEtaDuration, geohashEncode, TRAVEL_MODES, type TravelMode } from './mapsPolicy';
import type { UserId } from './model';
import { HOUR, MINUTE, type EpochMs } from './time';

export const MEETUP_CATEGORIES = ['cafe', 'transit', 'meeting_point'] as const;
export type MeetupCategory = (typeof MEETUP_CATEGORIES)[number];
export const MEETUP_CATEGORY_TEXT: Record<MeetupCategory, string> = { cafe: 'Kafe', transit: 'Durak', meeting_point: 'Buluşma noktası' };
export const MEETUP_CATEGORY_EMOJI: Record<MeetupCategory, string> = { cafe: '☕', transit: '🚏', meeting_point: '📍' };

/** Places API (New) Table A türleri. [Varsayım] Tür listesi Google belgesiyle doğrulanmalı. */
export const MEETUP_CATEGORY_TYPES: Record<MeetupCategory, readonly string[]> = {
  cafe: ['cafe', 'coffee_shop', 'bakery'],
  transit: ['bus_station', 'subway_station', 'train_station', 'light_rail_station', 'transit_station', 'ferry_terminal'],
  meeting_point: ['park', 'shopping_mall', 'plaza', 'tourist_attraction'],
};

export const PLACES_NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';
export const ROUTE_MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
/** En dar alan maskesi (maliyet: Nearby Search Pro SKU). `rating`/`userRatingCount` Enterprise SKU'dur: KULLANILMAZ. [Varsayım] */
export const PLACES_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.types';
export const ROUTE_MATRIX_FIELD_MASK = 'originIndex,destinationIndex,duration,distanceMeters,condition';

export const MEETUP_LIMITS = {
  minParticipants: 2,
  maxParticipants: 5,
  /** Places'ten istenen en fazla aday. */
  placesMaxResults: 10,
  /** Matris için en yakın aday sayısı (maliyet: katılımcı × K öğe). */
  matrixTopK: 5,
  resultCount: 3,
  minSearchRadiusM: 300,
  maxSearchRadiusM: 3_000,
  /** Sunucu önbelleği (merkez geohash6 + kategori + katılımcı hücreleri + modlar). */
  cacheTtlMs: 10 * MINUTE,
  /** Kullanıcı başına günlük öneri sorgusu (Places + matris). [Varsayım] */
  perUserDailyLimit: 30,
  /** Paylaşılan buluşma önerisi geçerlilik süresi. */
  shareTtlMs: 12 * HOUR,
  maxShareRecipients: 4,
  /** Adalet ağırlığı: fark cezası çarpanı. [Varsayım] */
  fairnessWeight: 0.5,
  /** Katılımcılar bu kadar yakınsa (m) arama yapmadan "Buradasınız" önerisi. */
  tooCloseM: 150,
  /** Katılımcılar arası bundan uzaksa öneri yapılmaz (şehirlerarası). */
  maxSpreadM: 100_000,
} as const;

/** Kuş uçuşu ETA tahmini için ortalama hızlar (m/s) ve dolambaç katsayısı (yedek yol). [Varsayım] */
export const FALLBACK_SPEED_MPS: Record<TravelMode, number> = { DRIVE: 8.3, WALK: 1.3, BICYCLE: 4.2 };
export const FALLBACK_DETOUR = 1.35;

export interface MeetupParticipant {
  /** 'me' = çağıran; diğerleri arkadaş uid'i. */
  key: 'me' | UserId;
  position: LatLng;
  mode: TravelMode;
}

export interface MeetupEta {
  key: 'me' | UserId;
  duration_s: number;
  distance_m: number;
  /** true = Routes yerine kuş uçuşu tahmini. */
  estimated: boolean;
}

export interface MeetupPlace {
  /** Google place id; "Orta nokta" önerisinde null. */
  place_id: string | null;
  name: string;
  address: string | null;
  location: LatLng;
  primary_type: string | null;
  category: MeetupCategory | 'midpoint';
}

export interface MeetupSuggestion {
  place: MeetupPlace;
  etas: MeetupEta[];
  /** Puan (düşük = iyi), saniye cinsinden. */
  score: number;
  max_duration_s: number;
  spread_s: number;
}

// --- geometri --------------------------------------------------------------------------------

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Büyük daire orta noktası. */
export function geoMidpoint(a: LatLng, b: LatLng): LatLng {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const Bx = Math.cos(φ2) * Math.cos(Δλ);
  const By = Math.cos(φ2) * Math.sin(Δλ);
  const φ = Math.atan2(Math.sin(φ1) + Math.sin(φ2), Math.sqrt((Math.cos(φ1) + Bx) ** 2 + By ** 2));
  const λ = toRad(a.lng) + Math.atan2(By, Math.cos(φ1) + Bx);
  return { lat: roundCoord(toDeg(φ)), lng: roundCoord(((toDeg(λ) + 540) % 360) - 180) };
}

/**
 * Buluşma merkezi. 2 kişi: orta nokta. 3+: geometrik medyan (toplam mesafeyi en aza indirir; uç değerdeki tek kişi
 * merkezi kendine çekmez). Yerel düzlem yaklaşımı (≤ 100 km yayılımda hata ihmal edilebilir).
 */
export function meetupCenter(points: readonly LatLng[]): LatLng {
  if (points.length === 0) throw new Error('meetupCenter: nokta yok');
  if (points.length === 1) return { ...points[0]! };
  if (points.length === 2) return geoMidpoint(points[0]!, points[1]!);
  let cur = { lat: points.reduce((s, p) => s + p.lat, 0) / points.length, lng: points.reduce((s, p) => s + p.lng, 0) / points.length };
  for (let i = 0; i < 50; i++) {
    let wSum = 0;
    let lat = 0;
    let lng = 0;
    for (const p of points) {
      const d = Math.max(1, haversineM(cur, p));
      wSum += 1 / d;
      lat += p.lat / d;
      lng += p.lng / d;
    }
    const next = { lat: lat / wSum, lng: lng / wSum };
    if (haversineM(cur, next) < 0.5) {
      cur = next;
      break;
    }
    cur = next;
  }
  return { lat: roundCoord(cur.lat), lng: roundCoord(cur.lng) };
}

/** Katılımcıların merkeze en uzak mesafesi (yayılım). */
export const meetupSpreadM = (center: LatLng, points: readonly LatLng[]): number => Math.max(0, ...points.map((p) => haversineM(center, p)));

/** Arama yarıçapı: yayılımın dörtte biri, [300 m, 3 km]. */
export function searchRadiusM(spreadM: number): number {
  return Math.round(Math.min(MEETUP_LIMITS.maxSearchRadiusM, Math.max(MEETUP_LIMITS.minSearchRadiusM, spreadM / 4)));
}

/** Kuş uçuşu ETA tahmini (Routes yoksa). */
export function fallbackEta(from: LatLng, to: LatLng, mode: TravelMode): { duration_s: number; distance_m: number } {
  const distance_m = Math.round(haversineM(from, to) * FALLBACK_DETOUR);
  return { distance_m, duration_s: Math.round(distance_m / FALLBACK_SPEED_MPS[mode]) };
}

// --- sıralama --------------------------------------------------------------------------------

/** Adalet puanı: en uzun yolculuk + ağırlık × (en uzun − en kısa). Düşük = iyi. */
export function meetupScore(etas: readonly Pick<MeetupEta, 'duration_s'>[]): { score: number; max_duration_s: number; spread_s: number } {
  const ds = etas.map((e) => e.duration_s);
  const max = Math.max(...ds);
  const min = Math.min(...ds);
  return { score: Math.round(max + MEETUP_LIMITS.fairnessWeight * (max - min)), max_duration_s: max, spread_s: max - min };
}

/** Adayları puana göre sıralar; eşitlikte merkeze yakın olan önde. ETA'sı eksik aday elenir. */
export function rankMeetupCandidates(
  candidates: readonly { place: MeetupPlace; etas: readonly MeetupEta[] }[],
  participantKeys: readonly ('me' | UserId)[],
  center: LatLng,
  limit: number = MEETUP_LIMITS.resultCount,
): MeetupSuggestion[] {
  const out: (MeetupSuggestion & { centerDist: number })[] = [];
  for (const c of candidates) {
    const etas = participantKeys.map((k) => c.etas.find((e) => e.key === k)).filter((e): e is MeetupEta => !!e);
    if (etas.length !== participantKeys.length) continue;
    out.push({ place: c.place, etas, ...meetupScore(etas), centerDist: haversineM(center, c.place.location) });
  }
  out.sort((a, b) => a.score - b.score || a.centerDist - b.centerDist);
  return out.slice(0, limit).map(({ centerDist: _c, ...s }) => s);
}

/** Matris için merkeze en yakın K aday (Places DISTANCE sıralaması yoksa da tutarlı). */
export function nearestCandidates<T extends { location: LatLng }>(places: readonly T[], center: LatLng, k: number = MEETUP_LIMITS.matrixTopK): T[] {
  return [...places].sort((a, b) => haversineM(center, a.location) - haversineM(center, b.location)).slice(0, k);
}

// --- Google istek / yanıt yardımcıları (sunucu) ----------------------------------------------------

export function placesNearbyRequestBody(center: LatLng, radiusM: number, category: MeetupCategory) {
  return {
    includedTypes: [...MEETUP_CATEGORY_TYPES[category]],
    maxResultCount: MEETUP_LIMITS.placesMaxResults,
    rankPreference: 'DISTANCE',
    languageCode: 'tr',
    regionCode: 'TR',
    locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: radiusM } },
  };
}

/** Places (New) yanıtını aday listesine çevirir; bozuk kayıtlar atılır. */
export function parsePlacesNearbyResponse(json: unknown, category: MeetupCategory): MeetupPlace[] {
  const places = (json as { places?: unknown[] } | null)?.places;
  if (!Array.isArray(places)) return [];
  const out: MeetupPlace[] = [];
  for (const p of places) {
    const o = p as { id?: unknown; displayName?: { text?: unknown }; formattedAddress?: unknown; location?: { latitude?: unknown; longitude?: unknown }; primaryType?: unknown };
    const lat = o.location?.latitude;
    const lng = o.location?.longitude;
    const name = o.displayName?.text;
    if (typeof o.id !== 'string' || typeof name !== 'string' || typeof lat !== 'number' || typeof lng !== 'number') continue;
    out.push({
      place_id: o.id,
      name: name.slice(0, 80),
      address: typeof o.formattedAddress === 'string' ? o.formattedAddress.slice(0, 160) : null,
      location: { lat: roundCoord(lat), lng: roundCoord(lng) },
      primary_type: typeof o.primaryType === 'string' ? o.primaryType : null,
      category,
    });
  }
  return out;
}

const ROUTES_MODE: Record<TravelMode, string> = { DRIVE: 'DRIVE', WALK: 'WALK', BICYCLE: 'BICYCLE' };

export function routeMatrixRequestBody(origins: readonly LatLng[], destinations: readonly LatLng[], mode: TravelMode) {
  const wp = (p: LatLng) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
  return {
    origins: origins.map(wp),
    destinations: destinations.map(wp),
    travelMode: ROUTES_MODE[mode],
    ...(mode === 'DRIVE' ? { routingPreference: 'TRAFFIC_UNAWARE' } : {}),
  };
}

/** computeRouteMatrix yanıtı (JSON dizi ya da akış satırları birleşik) → [kaynak][hedef] süre/mesafe; bulunamayan null. */
export function parseRouteMatrixResponse(json: unknown, originCount: number, destCount: number): ({ duration_s: number; distance_m: number } | null)[][] {
  const grid: ({ duration_s: number; distance_m: number } | null)[][] = Array.from({ length: originCount }, () => Array.from({ length: destCount }, () => null));
  const rows = Array.isArray(json) ? json : [];
  for (const r of rows) {
    const o = r as { originIndex?: unknown; destinationIndex?: unknown; duration?: unknown; distanceMeters?: unknown; condition?: unknown };
    const oi = typeof o.originIndex === 'number' ? o.originIndex : 0;
    const di = typeof o.destinationIndex === 'number' ? o.destinationIndex : 0;
    if (o.condition !== undefined && o.condition !== 'ROUTE_EXISTS') continue;
    const dur = typeof o.duration === 'string' ? Number.parseFloat(o.duration.replace(/s$/, '')) : NaN;
    if (!Number.isFinite(dur) || oi >= originCount || di >= destCount) continue;
    grid[oi]![di] = { duration_s: Math.round(dur), distance_m: typeof o.distanceMeters === 'number' ? o.distanceMeters : 0 };
  }
  return grid;
}

/** Sunucu önbellek anahtarı: merkez geohash6 + kategori + katılımcı hücreleri (geohash6) + modlar. */
export function meetupCacheKey(center: LatLng, category: MeetupCategory, participants: readonly Pick<MeetupParticipant, 'position' | 'mode'>[]): string {
  const parts = participants.map((p) => `${geohashEncode(p.position.lat, p.position.lng, 6)}:${p.mode}`).sort();
  return `${geohashEncode(center.lat, center.lng, 6)}_${category}_${parts.join('_')}`;
}

// --- sözleşmeler -------------------------------------------------------------------------------

const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const LatLngZ = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

export const MeetupParticipantSchema = z.object({
  key: z.union([z.literal('me'), uid]),
  position: LatLngZ,
  mode: z.enum(TRAVEL_MODES as [TravelMode, ...TravelMode[]]),
});

export const MeetupSuggestRequestSchema = z.object({
  op_id: z.uuid(),
  participants: z.array(MeetupParticipantSchema).min(MEETUP_LIMITS.minParticipants).max(MEETUP_LIMITS.maxParticipants),
  category: z.enum(MEETUP_CATEGORIES),
});
export type MeetupSuggestRequest = z.input<typeof MeetupSuggestRequestSchema>;

const MeetupPlaceSchema = z.object({
  place_id: z.string().nullable(),
  name: z.string(),
  address: z.string().nullable(),
  location: LatLngZ,
  primary_type: z.string().nullable(),
  category: z.enum([...MEETUP_CATEGORIES, 'midpoint']),
});
const MeetupEtaSchema = z.object({ key: z.union([z.literal('me'), uid]), duration_s: z.number(), distance_m: z.number(), estimated: z.boolean() });
const MeetupSuggestionSchema = z.object({ place: MeetupPlaceSchema, etas: z.array(MeetupEtaSchema), score: z.number(), max_duration_s: z.number(), spread_s: z.number() });

export interface MeetupSuggestResponse {
  center: LatLng;
  search_radius_m: number;
  suggestions: MeetupSuggestion[];
  /** `places_unavailable` / `quota_exceeded` → yalnızca orta nokta; `too_close` → zaten yakınsınız; `too_far` → öneri yok. */
  fallback: 'places_unavailable' | 'quota_exceeded' | 'too_close' | 'too_far' | 'no_results' | null;
  cached: boolean;
  server_now: EpochMs;
}
export const MeetupSuggestResponseSchema: z.ZodType<MeetupSuggestResponse> = z.object({
  center: LatLngZ,
  search_radius_m: z.number(),
  suggestions: z.array(MeetupSuggestionSchema),
  fallback: z.enum(['places_unavailable', 'quota_exceeded', 'too_close', 'too_far', 'no_results']).nullable(),
  cached: z.boolean(),
  server_now: z.number(),
});

/** Paylaşılan buluşma önerisi: Firestore `meetups/{meetup_id}` (gönderen + alıcılar okur, callable yazar). */
export interface Meetup {
  meetup_id: string;
  from: UserId;
  from_name: string;
  to: UserId[];
  place: MeetupPlace;
  /** Paylaşım anındaki ETA'lar ('me' yerine gerçek uid'ler). */
  etas: MeetupEta[];
  /** İsteğe bağlı buluşma saati. */
  meet_at: EpochMs | null;
  note: string | null;
  responses: Record<UserId, 'accepted' | 'declined'>;
  status: 'active' | 'cancelled';
  created_at: EpochMs;
  expires_at: EpochMs;
}

export const MeetupShareRequestSchema = z.object({
  op_id: z.uuid(),
  to: z.array(uid).min(1).max(MEETUP_LIMITS.maxShareRecipients),
  place: MeetupPlaceSchema,
  etas: z.array(MeetupEtaSchema).max(MEETUP_LIMITS.maxParticipants),
  meet_at: z.number().int().positive().nullable().default(null),
  note: z.string().max(120).nullable().default(null),
});
export type MeetupShareRequest = z.input<typeof MeetupShareRequestSchema>;

export const MeetupRespondRequestSchema = z.object({ op_id: z.uuid(), meetup_id: z.string().min(1).max(64), response: z.enum(['accepted', 'declined']) });
export type MeetupRespondRequest = z.input<typeof MeetupRespondRequestSchema>;
export const MeetupCancelRequestSchema = z.object({ op_id: z.uuid(), meetup_id: z.string().min(1).max(64) });
export type MeetupCancelRequest = z.input<typeof MeetupCancelRequestSchema>;

export const MeetupSchema: z.ZodType<Meetup> = z.object({
  meetup_id: z.string().min(1),
  from: uid,
  from_name: z.string(),
  to: z.array(uid),
  place: MeetupPlaceSchema,
  etas: z.array(MeetupEtaSchema),
  meet_at: z.number().nullable(),
  note: z.string().nullable(),
  responses: z.record(z.string(), z.enum(['accepted', 'declined'])),
  status: z.enum(['active', 'cancelled']),
  created_at: z.number(),
  expires_at: z.number(),
});
export interface MeetupResponse {
  meetup: Meetup;
  server_now: EpochMs;
}
export const MeetupResponseSchema: z.ZodType<MeetupResponse> = z.object({ meetup: MeetupSchema, server_now: z.number() });

export function parseMeetup(raw: unknown): Meetup | null {
  const r = MeetupSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export const isMeetupActive = (m: Pick<Meetup, 'status' | 'expires_at'>, now: EpochMs): boolean => m.status === 'active' && m.expires_at > now;

/** "Ayşe 12 dk · Sen 9 dk" satırı. `names` uid → ad; 'me' için "Sen". */
export function formatMeetupEtas(etas: readonly MeetupEta[], names: Record<string, string>, meKey: string | null = null): string {
  return etas
    .map((e) => {
      const n = e.key === 'me' || e.key === meKey ? 'Sen' : (names[e.key] ?? 'Arkadaşın');
      return `${n} ${e.estimated ? '~' : ''}${formatEtaDuration(e.duration_s)}`;
    })
    .join(' · ');
}

export function meetupPushText(fromName: string, place: Pick<MeetupPlace, 'name'>): { title: string; body: string } {
  return { title: fromName, body: `Buluşma noktası önerdi: ${place.name}` };
}

export function meetupResponsePushText(name: string, response: 'accepted' | 'declined', place: Pick<MeetupPlace, 'name'>): { title: string; body: string } {
  return { title: name, body: response === 'accepted' ? `${place.name} için "Geliyorum" dedi` : `${place.name} önerisine uyamayacağını söyledi` };
}

/** Kart alt satırı: "Merkeze 350 m". */
export const formatFromCenter = (center: LatLng, p: LatLng): string => `Orta noktaya ${formatDistanceTr(haversineM(center, p))}`;

