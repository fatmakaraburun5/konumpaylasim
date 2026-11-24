/**
 * Demo Faz 5: sahte Google Places API (New) `places:searchNearby` ve Routes `computeRouteMatrix`.
 * Yanıtlar GERÇEK JSON biçimindedir; demo sunucusu bunları backend gibi core `parsePlacesNearbyResponse` /
 * `parseRouteMatrixResponse` ile okur.
 *
 *  - Yerler: istek merkezinin çevresinde, kategoriye göre deterministik Türkçe adlı 6-8 yer (ör. "Moda Kahve Durağı",
 *    "Kadıköy İskelesi"); denize düşen aday atlanır. Aynı merkez + kategori → aynı yerler.
 *  - Matris: demo yol ağı rotası (`demoRoute`, route_compute ile aynı); yol bulunamazsa hücre boş döner (sunucu o
 *    katılımcı için `fallbackEta` kullanır, `estimated: true`).
 */
import { MEETUP_CATEGORY_TYPES, type LatLng, type MeetupCategory, type TravelMode } from '@konum/core';
import { onLand } from '../web/mapGeometry';
import { demoRoute } from './fakeGoogle';

const NAMES: Record<MeetupCategory, readonly string[]> = {
  cafe: ['Moda Kahve Durağı', 'Bahariye Fırın & Kafe', 'Yeldeğirmeni Kahve Evi', 'Rıhtım Çay Bahçesi', 'Caferağa Kahvecisi', 'Altıyol Pastanesi', 'Kadife Sokak Kafe', 'Söğütlüçeşme Kahve'],
  transit: ['Kadıköy İskelesi', 'Altıyol Durağı', 'Söğütlüçeşme Marmaray', 'Moda Tramvay Durağı', 'Kadıköy Metro', 'Rıhtım Otobüs Durağı', 'Bahariye Durağı'],
  meeting_point: ['Moda Parkı', 'Yoğurtçu Parkı', 'Boğa Heykeli', 'Kadıköy Meydanı', 'Moda Sahili', 'Kalamış Parkı', 'Fenerbahçe Parkı Girişi'],
};

const STREETS = ['Moda Cd.', 'Bahariye Cd.', 'Rıhtım Cd.', 'Caferağa Mh.', 'Söğütlüçeşme Cd.', 'Kadife Sk.', 'Mühürdar Cd.', 'Dr. Esat Işık Cd.'];

/** Merkeze göre (doğu, kuzey) metre → koordinat. */
function offset(c: LatLng, eastM: number, northM: number): LatLng {
  return {
    lat: Math.round((c.lat + northM / 110_574) * 1e6) / 1e6,
    lng: Math.round((c.lng + eastM / (111_320 * Math.cos((c.lat * Math.PI) / 180))) * 1e6) / 1e6,
  };
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

interface NearbyBody {
  includedTypes?: string[];
  maxResultCount?: number;
  locationRestriction?: { circle?: { center?: { latitude?: number; longitude?: number }; radius?: number } };
}

const categoryOf = (types: readonly string[]): MeetupCategory =>
  (Object.keys(MEETUP_CATEGORY_TYPES) as MeetupCategory[]).find((c) => MEETUP_CATEGORY_TYPES[c].some((t) => types.includes(t))) ?? 'cafe';

/** `places:searchNearby` (alan maskesi: id, displayName, formattedAddress, location, primaryType, types). */
export function fakePlacesNearby(body: NearbyBody): { status: number; json: unknown } {
  const circle = body.locationRestriction?.circle;
  const lat = circle?.center?.latitude;
  const lng = circle?.center?.longitude;
  const radius = circle?.radius ?? 500;
  if (typeof lat !== 'number' || typeof lng !== 'number') return { status: 400, json: { error: { code: 400, message: 'locationRestriction' } } };
  const category = categoryOf(body.includedTypes ?? []);
  const names = NAMES[category];
  const types = MEETUP_CATEGORY_TYPES[category];
  const center = { lat, lng };
  // Hücreye bağlı tohum: yakın merkezler aynı yerleri görür (önbellek anahtarı geohash6 ile tutarlı).
  const seed = hash(`${category}:${lat.toFixed(3)}:${lng.toFixed(3)}`);
  const places: unknown[] = [];
  for (let i = 0; i < names.length && places.length < (body.maxResultCount ?? 10); i++) {
    const ang = ((seed % 360) + i * 137.5) * (Math.PI / 180);
    const d = radius * (0.2 + 0.75 * (((seed >>> (i % 16)) % 100) / 100));
    const p = offset(center, Math.cos(ang) * d, Math.sin(ang) * d);
    if (!onLand(p.lat, p.lng)) continue;
    const primary = types[(seed + i) % types.length] as string;
    places.push({
      id: `demo_${category}_${(seed + i * 7919).toString(36)}`,
      displayName: { text: names[(seed + i) % names.length], languageCode: 'tr' },
      formattedAddress: `${STREETS[(seed + i * 3) % STREETS.length]} No:${1 + ((seed + i * 13) % 120)}, Kadıköy/İstanbul`,
      location: { latitude: p.lat, longitude: p.lng },
      primaryType: primary,
      types: [primary, 'point_of_interest', 'establishment'],
    });
  }
  // Places (New) sonuç yoksa boş nesne döner.
  return { status: 200, json: places.length ? { places } : {} };
}

interface Waypoint {
  waypoint?: { location?: { latLng?: { latitude?: number; longitude?: number } } };
}

const wpLatLng = (w: Waypoint): LatLng | null => {
  const ll = w.waypoint?.location?.latLng;
  return typeof ll?.latitude === 'number' && typeof ll?.longitude === 'number' ? { lat: ll.latitude, lng: ll.longitude } : null;
};

/** `computeRouteMatrix` (alan maskesi: originIndex, destinationIndex, duration, distanceMeters, condition). */
export function fakeRouteMatrix(body: { origins?: Waypoint[]; destinations?: Waypoint[]; travelMode?: string }): { status: number; json: unknown } {
  const mode = (['DRIVE', 'WALK', 'BICYCLE'].includes(String(body.travelMode)) ? body.travelMode : 'DRIVE') as TravelMode;
  const rows: unknown[] = [];
  (body.origins ?? []).forEach((o, oi) => {
    (body.destinations ?? []).forEach((d, di) => {
      const a = wpLatLng(o);
      const b = wpLatLng(d);
      const r = a && b ? demoRoute(a, b, mode) : null;
      if (!r) {
        rows.push({ originIndex: oi, destinationIndex: di, condition: 'ROUTE_NOT_FOUND' });
        return;
      }
      rows.push({ originIndex: oi, destinationIndex: di, duration: `${Math.round(r.duration_s)}s`, distanceMeters: Math.round(r.distance_m), condition: 'ROUTE_EXISTS' });
    });
  });
  return { status: 200, json: rows };
}
