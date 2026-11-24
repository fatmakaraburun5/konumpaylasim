import { describe, expect, it } from 'vitest';
import {
  DAY,
  GEOCODE_POLICY,
  GEOHASH_RE,
  MAPS_DAILY_LIMITS,
  MINUTE,
  PATHS,
  ROUTE_POLICY,
  SECOND,
  decodePolyline,
  encodePolyline,
  formatDistanceTr,
  formatEtaDuration,
  formatRouteSummary,
  geocodeCell,
  geocodeQueryPoint,
  geohashBounds,
  geohashCenter,
  geohashEncode,
  haversineM,
  parseReverseGeocodeResponse,
  parseRoutesResponse,
  quotaDay,
  routeCacheKey,
  routeRecomputeReason,
  routesRequestBody,
  shouldRecomputeRoute,
  shouldReverseGeocode,
  type LatLng,
  type RouteRecomputeInput,
} from '../src';

const NOW = Date.UTC(2026, 10, 24, 9, 0, 0);

/** p'den kuzeye / doğuya metre kadar kaydır. */
const move = (p: LatLng, northM: number, eastM = 0): LatLng => ({
  lat: p.lat + northM / 111_195,
  lng: p.lng + eastM / (111_195 * Math.cos((p.lat * Math.PI) / 180)),
});

describe('geohash', () => {
  it('bilinen değerler', () => {
    expect(geohashEncode(57.64911, 10.40744, 11)).toBe('u4pruydqqvj');
    expect(geohashEncode(42.6, -5.6, 5)).toBe('ezs42');
    expect(geohashEncode(-25.382708, -49.265506, 8)).toBe('6gkzwgjz');
    expect(geohashEncode(0, 0, 1)).toBe('s');
    expect(geohashEncode(90, 180, 3)).toBe('zzz');
    expect(geohashEncode(-90, -180, 3)).toBe('000');
  });

  it('merkez ve sınırlar çift yönlü', () => {
    const p = { lat: 41.008237, lng: 28.978359 };
    const h = geohashEncode(p.lat, p.lng, 7);
    expect(h).toMatch(GEOHASH_RE);
    const b = geohashBounds(h);
    expect(p.lat).toBeGreaterThanOrEqual(b.minLat);
    expect(p.lat).toBeLessThan(b.maxLat);
    expect(p.lng).toBeGreaterThanOrEqual(b.minLng);
    expect(p.lng).toBeLessThan(b.maxLng);
    const c = geohashCenter(h);
    expect(geohashEncode(c.lat, c.lng, 7)).toBe(h);
    expect(haversineM(p, c)).toBeLessThan(110); // hücre köşegeninin yarısı
    expect(geocodeQueryPoint(h)).toEqual(c);
  });

  it('geçersiz girdi', () => {
    expect(() => geohashEncode(91, 0)).toThrow();
    expect(() => geohashEncode(0, 0, 0)).toThrow();
    expect(() => geohashEncode(0, 0, 13)).toThrow();
    expect(() => geohashBounds('abc')).toThrow(); // 'a' alfabede yok
  });
});

describe('shouldRecomputeRoute', () => {
  const me = { lat: 41.0, lng: 29.0 };
  const friend = { lat: 41.02, lng: 29.03 };
  const last = { origin: me, destination: friend, travel_mode: 'DRIVE' as const, computed_at: NOW };
  const input = (over: Partial<RouteRecomputeInput>): RouteRecomputeInput => ({
    last,
    origin: me,
    destination: friend,
    travelMode: 'DRIVE',
    now: NOW + 10 * SECOND,
    visible: true,
    ...over,
  });

  it('kart görünmüyorsa asla', () => {
    expect(shouldRecomputeRoute(input({ visible: false, last: null }))).toBe(false);
    expect(shouldRecomputeRoute(input({ visible: false, origin: move(me, 5_000), now: NOW + DAY }))).toBe(false);
  });

  it('ilk hesap ve mod değişimi hemen', () => {
    expect(routeRecomputeReason(input({ last: null }))).toBe('first');
    expect(routeRecomputeReason(input({ travelMode: 'WALK' }))).toBe('mode_changed');
  });

  it('60 sn içinde hareket olsa da hesap yok', () => {
    expect(shouldRecomputeRoute(input({ origin: move(me, 1_000), now: NOW + 59 * SECOND }))).toBe(false);
  });

  it('başlangıç ≥ 150 m, hedef ≥ 100 m hareket', () => {
    const t = NOW + 61 * SECOND;
    expect(routeRecomputeReason(input({ origin: move(me, 149), now: t }))).toBeNull();
    expect(routeRecomputeReason(input({ origin: move(me, 151), now: t }))).toBe('origin_moved');
    expect(routeRecomputeReason(input({ destination: move(friend, 0, 99), now: t }))).toBeNull();
    expect(routeRecomputeReason(input({ destination: move(friend, 0, 101), now: t }))).toBe('destination_moved');
  });

  it('5 dk sonra tazelenir', () => {
    expect(routeRecomputeReason(input({ now: NOW + 5 * MINUTE - 1 }))).toBeNull();
    expect(routeRecomputeReason(input({ now: NOW + 5 * MINUTE }))).toBe('stale');
  });
});

describe('routeCacheKey', () => {
  const o = { lat: 41.008237, lng: 28.978359 };
  const d = { lat: 40.990, lng: 29.025 };

  it('hücre + mod + 5 dk dilimi', () => {
    const k = routeCacheKey(o, d, 'DRIVE', NOW);
    expect(k).toBe(`${geohashEncode(o.lat, o.lng, 7)}.${geohashEncode(d.lat, d.lng, 7)}.DRIVE.${Math.floor(NOW / (5 * MINUTE))}`);
    expect(k).not.toContain('/');
    expect(PATHS.routeCache(k)).toBe(`route_cache/${k}`);
    // aynı hücre içinde küçük hareket aynı anahtar
    const c = geohashCenter(geohashEncode(o.lat, o.lng, 7));
    expect(routeCacheKey(move(c, 10), d, 'DRIVE', NOW)).toBe(routeCacheKey(c, d, 'DRIVE', NOW));
    expect(routeCacheKey(o, d, 'WALK', NOW)).not.toBe(k);
    expect(routeCacheKey(o, d, 'DRIVE', NOW + 5 * MINUTE)).not.toBe(k);
    expect(routeCacheKey(o, d, 'DRIVE', NOW, 'uid_1')).toBe(`${k}.uid_1`);
  });
});

describe('Routes API gövdesi ve yanıtı', () => {
  it('DRIVE varsayılanı trafiksiz (Essentials), sunucu açarsa trafikli; WALK tercihsiz', () => {
    const body = routesRequestBody({ lat: 41, lng: 29 }, { lat: 41.1, lng: 29.1 }, 'DRIVE');
    expect(body).toMatchObject({
      origin: { location: { latLng: { latitude: 41, longitude: 29 } } },
      destination: { location: { latLng: { latitude: 41.1, longitude: 29.1 } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_UNAWARE',
      computeAlternativeRoutes: false,
    });
    expect(ROUTE_POLICY.drivePreference).toBe('TRAFFIC_UNAWARE');
    expect(routesRequestBody({ lat: 41, lng: 29 }, { lat: 41.1, lng: 29.1 }, 'DRIVE', { drivePreference: 'TRAFFIC_AWARE' })).toMatchObject({
      routingPreference: 'TRAFFIC_AWARE',
    });
    expect(
      routesRequestBody({ lat: 41, lng: 29 }, { lat: 41.1, lng: 29.1 }, 'BICYCLE', { drivePreference: 'TRAFFIC_AWARE' }),
    ).not.toHaveProperty('routingPreference');
    expect(routesRequestBody({ lat: 41, lng: 29 }, { lat: 41.1, lng: 29.1 }, 'WALK')).not.toHaveProperty('routingPreference');
    expect(ROUTE_POLICY.fieldMask).toBe('routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline');
  });

  it('yanıt ayrıştırma', () => {
    expect(parseRoutesResponse({ routes: [{ distanceMeters: 3215, duration: '845s', polyline: { encodedPolyline: 'abc' } }] })).toEqual({
      distance_m: 3215,
      duration_s: 845,
      polyline: 'abc',
    });
    expect(parseRoutesResponse({ routes: [{ duration: '0s' }] })).toEqual({ distance_m: 0, duration_s: 0, polyline: '' });
    expect(parseRoutesResponse({ routes: [{ distanceMeters: 10, duration: '12.6s' }] })?.duration_s).toBe(13);
    expect(parseRoutesResponse({})).toBeNull();
    expect(parseRoutesResponse(null)).toBeNull();
    expect(parseRoutesResponse({ routes: [{ distanceMeters: 10, duration: 12 }] })).toBeNull();
    expect(parseRoutesResponse({ routes: [{ distanceMeters: -1, duration: '1s' }] })).toBeNull();
  });
});

describe('ters geocode', () => {
  const p = { lat: 40.987, lng: 29.027 };

  it('aynı hücre / 200 m altı / 60 sn içinde sorgu yok', () => {
    expect(shouldReverseGeocode({ last: null, position: p, now: NOW })).toBe(true);
    expect(shouldReverseGeocode({ last: null, position: p, now: NOW, visible: false })).toBe(false);
    const last = { ...p, at: NOW };
    expect(shouldReverseGeocode({ last, position: move(p, 5_000), now: NOW + 30 * SECOND })).toBe(false);
    expect(shouldReverseGeocode({ last, position: move(p, 5), now: NOW + DAY })).toBe(false);
    const q = move(p, 180);
    expect(geocodeCell(q)).not.toBe(geocodeCell(p));
    expect(shouldReverseGeocode({ last, position: q, now: NOW + DAY })).toBe(false); // hücre değişti ama < 200 m
    expect(shouldReverseGeocode({ last, position: move(p, 250), now: NOW + 61 * SECOND })).toBe(true);
  });

  it('politika', () => {
    expect(GEOCODE_POLICY.cacheTtlMs).toBe(30 * DAY);
    expect(geocodeCell(p)).toHaveLength(GEOCODE_POLICY.cellPrecision);
    expect(PATHS.geocodeCache(geocodeCell(p))).toBe(`geocode_cache/${geocodeCell(p)}`);
  });

  it('yanıt → kısa etiket', () => {
    const ok = {
      status: 'OK',
      results: [
        {
          formatted_address: 'Caferağa, Moda Cd. No:12, 34710 Kadıköy/İstanbul, Türkiye',
          address_components: [
            { long_name: '12', types: ['street_number'] },
            { long_name: 'Moda Caddesi', types: ['route'] },
            { long_name: 'Caferağa', types: ['administrative_area_level_4', 'political'] },
            { long_name: 'Kadıköy', types: ['administrative_area_level_2', 'political'] },
            { long_name: 'İstanbul', types: ['administrative_area_level_1', 'political'] },
          ],
        },
      ],
    };
    expect(parseReverseGeocodeResponse(ok)).toEqual({ ok: true, label: 'Moda Caddesi, Kadıköy' });
    const noRoute = { status: 'OK', results: [{ address_components: [ok.results[0]!.address_components[2]!, ok.results[0]!.address_components[3]!] }] };
    expect(parseReverseGeocodeResponse(noRoute)).toEqual({ ok: true, label: 'Caferağa, Kadıköy' });
    expect(parseReverseGeocodeResponse({ status: 'OK', results: [{ formatted_address: 'Bir Yer, Türkiye', address_components: [] }] })).toEqual({
      ok: true,
      label: 'Bir Yer',
    });
    expect(parseReverseGeocodeResponse({ status: 'ZERO_RESULTS', results: [] })).toEqual({ ok: true, label: null });
    expect(parseReverseGeocodeResponse({ status: 'OVER_QUERY_LIMIT' })).toEqual({ ok: false, retryable: true });
    expect(parseReverseGeocodeResponse({ status: 'REQUEST_DENIED' })).toEqual({ ok: false, retryable: false });
    expect(parseReverseGeocodeResponse(null)).toEqual({ ok: false, retryable: true });
  });
});

describe('kota', () => {
  it('UTC gün anahtarı ve sınırlar', () => {
    expect(quotaDay(Date.UTC(2026, 10, 24, 23, 59, 59))).toBe('2026-11-24');
    expect(quotaDay(Date.UTC(2026, 10, 25, 0, 0, 0))).toBe('2026-11-25');
    expect(PATHS.mapsQuota('uid1', '2026-11-24')).toBe('maps_quota/uid1_2026-11-24');
    expect(MAPS_DAILY_LIMITS).toEqual({ route: 200, geocode: 100 });
  });
});

describe('encoded polyline', () => {
  it('Google örneği', () => {
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts).toHaveLength(3);
    expect(pts[0]!.lat).toBeCloseTo(38.5, 5);
    expect(pts[0]!.lng).toBeCloseTo(-120.2, 5);
    expect(pts[1]!.lat).toBeCloseTo(40.7, 5);
    expect(pts[1]!.lng).toBeCloseTo(-120.95, 5);
    expect(pts[2]!.lat).toBeCloseTo(43.252, 5);
    expect(pts[2]!.lng).toBeCloseTo(-126.453, 5);
    expect(encodePolyline([{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }])).toBe(
      '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
    );
  });

  it('çift yönlü (rastgele noktalar)', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const pts = Array.from({ length: 300 }, () => ({
      lat: Math.round((rand() * 180 - 90) * 1e5) / 1e5,
      lng: Math.round((rand() * 360 - 180) * 1e5) / 1e5,
    }));
    const back = decodePolyline(encodePolyline(pts));
    expect(back).toHaveLength(pts.length);
    back.forEach((p, i) => {
      expect(p.lat).toBeCloseTo(pts[i]!.lat, 5);
      expect(p.lng).toBeCloseTo(pts[i]!.lng, 5);
    });
  });

  it('bozuk girdide fırlatmaz', () => {
    expect(decodePolyline('')).toEqual([]);
    expect(decodePolyline('_p~iF~ps|U_ulL')).toHaveLength(1); // yarım nokta atılır
    expect(decodePolyline('\u0001\u0002')).toEqual([]);
  });
});

describe('Türkçe ETA ve mesafe', () => {
  it('formatEtaDuration', () => {
    expect(formatEtaDuration(240)).toBe('4 dk');
    expect(formatEtaDuration(3_900)).toBe('1 sa 5 dk');
    expect(formatEtaDuration(7_200)).toBe('2 sa');
    expect(formatEtaDuration(20)).toBe('1 dk');
    expect(formatEtaDuration(0)).toBe('1 dk');
    expect(formatEtaDuration(89)).toBe('1 dk');
    expect(formatEtaDuration(91)).toBe('2 dk');
    expect(formatEtaDuration(3_570)).toBe('1 sa');
    expect(formatEtaDuration(27 * 3_600)).toBe('1 gün 3 sa');
    expect(formatEtaDuration(48 * 3_600)).toBe('2 gün');
    expect(formatEtaDuration(-1)).toBe('–');
    expect(formatEtaDuration(Number.NaN)).toBe('–');
  });

  it('formatDistanceTr', () => {
    expect(formatDistanceTr(850)).toBe('850 m');
    expect(formatDistanceTr(45.4)).toBe('45 m');
    expect(formatDistanceTr(0)).toBe('0 m');
    expect(formatDistanceTr(854)).toBe('850 m');
    expect(formatDistanceTr(994)).toBe('990 m');
    expect(formatDistanceTr(996)).toBe('1 km');
    expect(formatDistanceTr(1_050)).toBe('1,1 km');
    expect(formatDistanceTr(3_200)).toBe('3,2 km');
    expect(formatDistanceTr(3_249)).toBe('3,2 km');
    expect(formatDistanceTr(5_000)).toBe('5 km');
    expect(formatDistanceTr(9_960)).toBe('10 km');
    expect(formatDistanceTr(12_400)).toBe('12 km');
    expect(formatDistanceTr(1_234_567)).toBe('1.235 km');
    expect(formatDistanceTr(-5)).toBe('–');
  });

  it('formatRouteSummary', () => {
    expect(formatRouteSummary(720, 3_200)).toBe('12 dk · 3,2 km');
  });
});
