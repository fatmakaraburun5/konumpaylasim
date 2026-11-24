/**
 * Faz 2 Maps sunucu vekili: `route_compute` ve `geocode_reverse`. Google'a hiç gidilmez: işleyiciler test
 * sürecinde sahte `fetch`, anahtar ve bütçe ile doğrudan çağrılır (Firestore emülatörü önbellek ve kota için).
 * Uçtan uca bölüm Functions emülatöründe anahtarsız çalışmayı (`maps_unavailable`) doğrular.
 */
import { randomUUID } from 'node:crypto';
import {
  GEOCODE_API_URL,
  GeocodeReverseResponseSchema,
  MAPS_DAILY_LIMITS,
  ROUTES_API_URL,
  ROUTE_POLICY,
  RouteComputeResponseSchema,
  decodePolyline,
  encodePolyline,
  geocodeCell,
  geocodeQueryPoint,
  quotaDay,
} from '@konum/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../functions/src/admin';
import type { CallCtx } from '../../functions/src/callable';
import {
  type MapsDeps,
  type MapsFetch,
  geocodeReverse,
  loadMapsBudget,
  parseBudgetEnv,
  resetMapsConfigCache,
  routeCompute,
} from '../../functions/src/handlers/maps';
import { type TestUser, callError, cleanupRulesEnv, newUser, opId } from '../helpers/emulator';

afterAll(async () => {
  await cleanupRulesEnv();
});

const KEY = 'AIzaTEST-not-a-real-key-0123456789abcd';
const IST = { lat: 41.0082, lng: 28.9784 }; // Sultanahmet
const KDK = { lat: 40.9903, lng: 29.0275 }; // Kadıköy
const LINE = encodePolyline([IST, { lat: 41.0, lng: 29.0 }, KDK]);

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(respond: (c: Call) => { status?: number; json?: unknown } | Error) {
  const calls: Call[] = [];
  const fetch: MapsFetch = async (url, init) => {
    const c: Call = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
    calls.push(c);
    const r = respond(c);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.json ?? {} };
  };
  return { fetch, calls };
}

const routesOk = () => ({ json: { routes: [{ distanceMeters: 7_421, duration: '1260s', polyline: { encodedPolyline: LINE } }] } });

function deps(fetch: MapsFetch, over: Partial<MapsDeps> = {}): MapsDeps {
  return {
    fetch,
    apiKey: () => KEY,
    budget: async () => ({ disabled: false, route: 100_000, geocode: 100_000 }),
    random: () => 0.5,
    drivePreference: 'TRAFFIC_UNAWARE',
    timeoutMs: 2_000,
    ...over,
  };
}

const ctxOf = (uid: string, now = Date.now()): CallCtx => ({ uid, phone_e164: null, now });
const newUid = () => `u${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const routeReq = (mode: 'DRIVE' | 'WALK' | 'BICYCLE' = 'DRIVE', origin = IST, destination = KDK) => ({
  op_id: opId(),
  origin,
  destination,
  travel_mode: mode,
});
const quotaOf = async (uid: string, now = Date.now()) => (await db().doc(`maps_quota/${uid}_${quotaDay(now)}`).get()).data();

beforeEach(() => {
  resetMapsConfigCache();
});

describe('route_compute', () => {
  it('Routes API: doğru uç nokta, anahtar ve FieldMask başlıkları, Essentials (TRAFFIC_UNAWARE); önbellek isabeti kota yemez', async () => {
    const uid = newUid();
    const f = fakeFetch(routesOk);
    const r1 = await routeCompute(ctxOf(uid), routeReq('DRIVE'), deps(f.fetch));
    expect(RouteComputeResponseSchema.safeParse(r1).success).toBe(true);
    expect(r1).toMatchObject({ distance_m: 7_421, duration_s: 1_260, cached: false });
    expect(decodePolyline(r1.polyline)).toHaveLength(3);
    expect(f.calls).toHaveLength(1);
    const c = f.calls[0] as Call;
    expect(c.url).toBe(ROUTES_API_URL);
    expect(c.method).toBe('POST');
    expect(c.headers['X-Goog-Api-Key']).toBe(KEY);
    expect(c.headers['X-Goog-FieldMask']).toBe(ROUTE_POLICY.fieldMask);
    expect(c.body).toMatchObject({ travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', computeAlternativeRoutes: false });
    expect((await quotaOf(uid))?.route).toBe(1);

    const r2 = await routeCompute(ctxOf(uid), routeReq('DRIVE'), deps(f.fetch));
    expect(r2).toMatchObject({ cached: true, distance_m: 7_421, duration_s: 1_260, computed_at: r1.computed_at });
    expect(f.calls).toHaveLength(1);
    expect((await quotaOf(uid))?.route).toBe(1);

    // Önbellek kullanıcıya özel: başka kullanıcı aynı hücreler için kendi hesabını yapar.
    const other = newUid();
    expect((await routeCompute(ctxOf(other), routeReq('DRIVE'), deps(f.fetch))).cached).toBe(false);
    expect(f.calls).toHaveLength(2);
  });

  it('WALK / BICYCLE isteğinde routingPreference yok; TRAFFIC_AWARE yapılandırılabilir', async () => {
    const f = fakeFetch(routesOk);
    await routeCompute(ctxOf(newUid()), routeReq('WALK'), deps(f.fetch));
    await routeCompute(ctxOf(newUid()), routeReq('BICYCLE'), deps(f.fetch));
    await routeCompute(ctxOf(newUid()), routeReq('DRIVE'), deps(f.fetch, { drivePreference: 'TRAFFIC_AWARE' }));
    expect(f.calls[0]?.body).not.toHaveProperty('routingPreference');
    expect(f.calls[1]?.body).not.toHaveProperty('routingPreference');
    expect(f.calls[2]?.body).toMatchObject({ routingPreference: 'TRAFFIC_AWARE' });
  });

  it('rota yoksa route_not_found; Google hatası, zaman aşımı ve anahtar yoksa maps_unavailable', async () => {
    const uid = newUid();
    await expect(routeCompute(ctxOf(uid), routeReq(), deps(fakeFetch(() => ({ json: {} })).fetch))).rejects.toMatchObject({
      details: { code: 'route_not_found', retryable: false },
    });
    await expect(routeCompute(ctxOf(uid), routeReq(), deps(fakeFetch(() => ({ status: 400, json: { error: {} } })).fetch))).rejects.toMatchObject({
      details: { code: 'route_not_found' },
    });
    for (const status of [403, 429, 503]) {
      await expect(routeCompute(ctxOf(uid), routeReq(), deps(fakeFetch(() => ({ status })).fetch))).rejects.toMatchObject({
        details: { code: 'maps_unavailable', retryable: true },
      });
    }
    await expect(routeCompute(ctxOf(uid), routeReq(), deps(fakeFetch(() => new Error('timeout')).fetch))).rejects.toMatchObject({
      details: { code: 'maps_unavailable' },
    });
    // Anahtar yok: Google'a gidilmez, kota yenmez.
    const noKey = newUid();
    const f = fakeFetch(routesOk);
    await expect(routeCompute(ctxOf(noKey), routeReq(), deps(f.fetch, { apiKey: () => null }))).rejects.toMatchObject({
      details: { code: 'maps_unavailable' },
    });
    expect(f.calls).toHaveLength(0);
    expect(await quotaOf(noKey)).toBeUndefined();
  });

  it('kullanıcı günlük sınırı (core MAPS_DAILY_LIMITS): Google çağrılmaz, önbellek isabeti yine döner', async () => {
    const uid = newUid();
    const f = fakeFetch(routesOk);
    await routeCompute(ctxOf(uid), routeReq('DRIVE'), deps(f.fetch)); // önbelleğe girer
    await db().doc(`maps_quota/${uid}_${quotaDay(Date.now())}`).set({ route: MAPS_DAILY_LIMITS.route }, { merge: true });
    await expect(routeCompute(ctxOf(uid), routeReq('WALK'), deps(f.fetch))).rejects.toMatchObject({
      details: { code: 'quota_exceeded', scope: 'user', retryable: false },
    });
    expect(f.calls).toHaveLength(1);
    expect((await routeCompute(ctxOf(uid), routeReq('DRIVE'), deps(f.fetch))).cached).toBe(true);
  });

  it('proje geneli bütçe ve kapatma anahtarı quota_exceeded döner; sayaç parçaları bütçeyi aşmaz', async () => {
    // Taze kota günü: başka testlerin sayaçlarından bağımsız.
    const day = Date.UTC(2031, 0, 15, 12);
    const f = fakeFetch(routesOk);
    const budget = { disabled: false, route: 3, geocode: 3 };
    const ok: number[] = [];
    for (let i = 0; i < 6; i++) {
      const dest = { lat: KDK.lat + i * 0.01, lng: KDK.lng };
      try {
        await routeCompute(ctxOf(newUid(), day), routeReq('DRIVE', IST, dest), deps(f.fetch, { budget: async () => budget, random: () => (i % 3) / 3 }));
        ok.push(i);
      } catch (err) {
        expect(err).toMatchObject({ details: { code: 'quota_exceeded', scope: 'global' } });
      }
    }
    expect(ok).toHaveLength(3);
    expect(f.calls).toHaveLength(3);
    await expect(
      routeCompute(ctxOf(newUid()), routeReq(), deps(f.fetch, { budget: async () => ({ disabled: true, route: 100, geocode: 100 }) })),
    ).rejects.toMatchObject({ details: { code: 'quota_exceeded', scope: 'global' } });
    expect(f.calls).toHaveLength(3);
  });

  it('bütçe yapılandırması: ortam değişkeni biçimleri ve config/maps belgesi (kill switch)', async () => {
    expect(parseBudgetEnv(undefined)).toEqual({ route: 5_000, geocode: 5_000 });
    expect(parseBudgetEnv('1200')).toEqual({ route: 1_200, geocode: 1_200 });
    expect(parseBudgetEnv('route=10, geocode=0')).toEqual({ route: 10, geocode: 0 });
    expect(parseBudgetEnv('saçma')).toEqual({ route: 5_000, geocode: 5_000 });
    await db().doc('config/maps').set({ disabled: true, route_daily_budget: 7 });
    try {
      resetMapsConfigCache();
      expect(await loadMapsBudget()).toEqual({ disabled: true, route: 7, geocode: 5_000 });
    } finally {
      await db().doc('config/maps').delete();
      resetMapsConfigCache();
    }
    expect(await loadMapsBudget()).toMatchObject({ disabled: false });
  });
});

describe('geocode_reverse', () => {
  it("Google'a hücre merkezi sorulur (tam konum değil), Türkçe; hücre önbelleği kullanıcılar arasında paylaşılır", async () => {
    const p = { lat: 40.98712, lng: 29.02634 };
    const cell = geocodeCell(p);
    await db().doc(`geocode_cache/${cell}`).delete();
    const f = fakeFetch(() => ({
      json: {
        status: 'OK',
        results: [
          {
            formatted_address: 'Moda Cd., 34710 Kadıköy/İstanbul, Türkiye',
            address_components: [
              { long_name: 'Moda Caddesi', types: ['route'] },
              { long_name: 'Kadıköy', types: ['administrative_area_level_2', 'political'] },
            ],
          },
        ],
      },
    }));
    const u1 = newUid();
    const r1 = await geocodeReverse(ctxOf(u1), p, deps(f.fetch));
    expect(GeocodeReverseResponseSchema.safeParse(r1).success).toBe(true);
    expect(r1).toEqual({ label: 'Moda Caddesi, Kadıköy', cell, cached: false });
    const url = new URL((f.calls[0] as Call).url);
    expect(`${url.origin}${url.pathname}`).toBe(GEOCODE_API_URL);
    expect(url.searchParams.get('language')).toBe('tr');
    expect(url.searchParams.get('key')).toBe(KEY);
    expect(url.searchParams.get('result_type')).toContain('route');
    const center = geocodeQueryPoint(cell);
    expect(url.searchParams.get('latlng')).toBe(`${center.lat.toFixed(6)},${center.lng.toFixed(6)}`);
    expect((await quotaOf(u1))?.geocode).toBe(1);

    const u2 = newUid();
    // Aynı hücrede başka bir nokta (hücre merkezi): önbellekten.
    expect(await geocodeReverse(ctxOf(u2), center, deps(f.fetch))).toEqual({
      label: 'Moda Caddesi, Kadıköy',
      cell,
      cached: true,
    });
    expect(f.calls).toHaveLength(1);
    expect(await quotaOf(u2)).toBeUndefined();
  });

  it('ZERO_RESULTS → label null (önbelleğe girer); REQUEST_DENIED / HTTP hatası / anahtar yok → maps_unavailable', async () => {
    const sea = { lat: 40.5, lng: 28.2 }; // Marmara Denizi
    await db().doc(`geocode_cache/${geocodeCell(sea)}`).delete();
    const zero = fakeFetch(() => ({ json: { status: 'ZERO_RESULTS', results: [] } }));
    expect(await geocodeReverse(ctxOf(newUid()), sea, deps(zero.fetch))).toMatchObject({ label: null, cached: false });
    expect(await geocodeReverse(ctxOf(newUid()), sea, deps(zero.fetch))).toMatchObject({ label: null, cached: true });

    const p = { lat: 39.9208, lng: 32.8541 }; // Ankara
    await db().doc(`geocode_cache/${geocodeCell(p)}`).delete();
    for (const f of [fakeFetch(() => ({ json: { status: 'REQUEST_DENIED' } })), fakeFetch(() => ({ status: 500 })), fakeFetch(() => new Error('x'))]) {
      await expect(geocodeReverse(ctxOf(newUid()), p, deps(f.fetch))).rejects.toMatchObject({ details: { code: 'maps_unavailable' } });
    }
    expect((await db().doc(`geocode_cache/${geocodeCell(p)}`).get()).exists).toBe(false);
    const none = fakeFetch(() => ({ json: { status: 'OK', results: [] } }));
    await expect(geocodeReverse(ctxOf(newUid()), p, deps(none.fetch, { apiKey: () => null }))).rejects.toMatchObject({
      details: { code: 'maps_unavailable' },
    });
    expect(none.calls).toHaveLength(0);
  });

  it('kullanıcı günlük sınırı geocode için ayrı sayılır', async () => {
    const uid = newUid();
    await db().doc(`maps_quota/${uid}_${quotaDay(Date.now())}`).set({ geocode: MAPS_DAILY_LIMITS.geocode, route: 0 });
    const p = { lat: 38.4237, lng: 27.1428 }; // İzmir
    await db().doc(`geocode_cache/${geocodeCell(p)}`).delete();
    const f = fakeFetch(() => ({ json: { status: 'ZERO_RESULTS' } }));
    await expect(geocodeReverse(ctxOf(uid), p, deps(f.fetch))).rejects.toMatchObject({ details: { code: 'quota_exceeded', scope: 'user' } });
    expect(f.calls).toHaveLength(0);
    await routeCompute(ctxOf(uid), routeReq('WALK', p, { lat: p.lat + 0.01, lng: p.lng }), deps(fakeFetch(routesOk).fetch));
  });
});

describe('uçtan uca (Functions emülatörü, anahtar yok)', () => {
  let U: TestUser;
  it('route_compute ve geocode_reverse anahtarsız maps_unavailable; kimliksiz ve bozuk girdi reddedilir', async () => {
    U = await newUser('Harita');
    const r = await callError('route_compute', routeReq('DRIVE', { lat: 41.1, lng: 29.1 }, { lat: 41.2, lng: 29.2 }), U);
    expect(r.status).toBe('UNAVAILABLE');
    expect(r.details).toMatchObject({ code: 'maps_unavailable', retryable: true });
    const g = await callError('geocode_reverse', { lat: 37.0, lng: 35.3 }, U);
    expect(g.details).toMatchObject({ code: 'maps_unavailable' });
    expect((await callError('route_compute', routeReq(), null)).details?.code).toBe('unauthenticated');
    expect((await callError('geocode_reverse', { lat: 95, lng: 0 }, U)).details?.code).toBe('invalid_argument');
    expect((await callError('route_compute', { ...routeReq(), travel_mode: 'TRANSIT' }, U)).details?.code).toBe('invalid_argument');
  });
});
