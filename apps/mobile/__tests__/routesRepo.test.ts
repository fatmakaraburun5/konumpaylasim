/**
 * Rota ve adres depoları: core maliyet politikası (shouldRecomputeRoute / shouldReverseGeocode) gerçek callable
 * sarmalayıcısı üzerinden (sahte taşıma) uygulanıyor mu? Görünmezken çağrı yok, 60 sn kuralı, mod önbelleği,
 * hata/kota davranışı, hücre önbelleği.
 */
import { encodePolyline, geocodeCell, MINUTE, SECOND, type CallableName } from '@konum/core';
import { setCallTransport } from '../src/services/firebase/callables';
import { createGeocodeRepo } from '../src/services/maps/geocodeRepo';
import { createRoutesRepo, ROUTE_ERROR_TEXT } from '../src/services/maps/routesRepo';

const NOW = Date.UTC(2026, 10, 23, 11, 0, 0);
const ME = { lat: 41.0082, lng: 28.9784 };
const FRIEND = { lat: 41.0422, lng: 29.0083 };
const POLY = encodePolyline([ME, FRIEND]);

/** `dLat` metre kuzeye. */
const north = (p: { lat: number; lng: number }, m: number) => ({ lat: p.lat + m / 111_320, lng: p.lng });

type Handler = (payload: Record<string, unknown>) => unknown;

function transport(handlers: Partial<Record<CallableName, Handler>>) {
  const calls: { name: CallableName; payload: Record<string, unknown> }[] = [];
  setCallTransport(async (name, payload) => {
    calls.push({ name, payload: payload as Record<string, unknown> });
    const h = handlers[name];
    if (!h) throw Object.assign(new Error('unknown'), { code: 'functions/not-found' });
    return h(payload as Record<string, unknown>);
  });
  return calls;
}

const httpsError = (code: string, transportCode = 'functions/unavailable') => Object.assign(new Error(code), { code: transportCode, details: { code } });

afterEach(() => setCallTransport(null));

describe('routesRepo', () => {
  function setup(handler?: Handler) {
    let clock = NOW;
    const calls = transport({
      route_compute:
        handler ?? ((p) => ({ distance_m: 4_200, duration_s: 780, polyline: POLY, cached: false, computed_at: clock, _echo: p.travel_mode })),
    });
    const repo = createRoutesRepo({ now: () => clock });
    const q = (over: Partial<Parameters<typeof repo.refresh>[0]> = {}) => ({
      targetKey: 'friend:me_a',
      origin: ME,
      destination: FRIEND,
      mode: 'DRIVE' as const,
      visible: true,
      ...over,
    });
    return { repo, calls, q, advance: (ms: number) => (clock += ms) };
  }

  it('kart görünmüyorsa hiç çağırmaz', async () => {
    const t = setup();
    await expect(t.repo.refresh(t.q({ visible: false }))).resolves.toBeNull();
    expect(t.calls).toHaveLength(0);
  });

  it('ilk açılışta çağırır (doğrulanmış istek + op_id), sonucu çözer; 60 sn içinde küçük hareket yeni çağrı yapmaz', async () => {
    const t = setup();
    const e = await t.repo.refresh(t.q());
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ name: 'route_compute', payload: { origin: ME, destination: FRIEND, travel_mode: 'DRIVE' } });
    expect(t.calls[0]!.payload.op_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e).toMatchObject({ error: null, result: { distance_m: 4_200, duration_s: 780 } });
    expect(e!.result!.points).toHaveLength(2);

    t.advance(20 * SECOND);
    const again = await t.repo.refresh(t.q({ origin: north(ME, 500) }));
    expect(t.calls).toHaveLength(1); // 60 sn kuralı: hareket büyük olsa da bekler
    expect(again?.result?.duration_s).toBe(780);

    t.advance(45 * SECOND); // toplam 65 sn
    await t.repo.refresh(t.q({ origin: north(ME, 50) }));
    expect(t.calls).toHaveLength(1); // 150 m altı hareket: çağrı yok

    await t.repo.refresh(t.q({ origin: north(ME, 200) }));
    expect(t.calls).toHaveLength(2); // 150 m üstü: yeniden hesap
  });

  it('hiç hareket yoksa 5 dk sonra bayatlık nedeniyle tazeler', async () => {
    const t = setup();
    await t.repo.refresh(t.q());
    t.advance(4 * MINUTE);
    await t.repo.refresh(t.q());
    expect(t.calls).toHaveLength(1);
    t.advance(MINUTE + SECOND);
    await t.repo.refresh(t.q());
    expect(t.calls).toHaveLength(2);
  });

  it('mod değişimi hemen hesaplar; aynı moda dönüş önbellekten (ücretsiz)', async () => {
    const t = setup();
    await t.repo.refresh(t.q());
    await t.repo.refresh(t.q({ mode: 'WALK' }));
    expect(t.calls.map((c) => c.payload.travel_mode)).toEqual(['DRIVE', 'WALK']);
    await t.repo.refresh(t.q({ mode: 'DRIVE' }));
    expect(t.calls).toHaveLength(2);
    expect(t.repo.peek('friend:me_a', 'DRIVE')?.result?.duration_s).toBe(780);
  });

  it('hedef değişince (başka arkadaş) beklemeden hesaplar', async () => {
    const t = setup();
    await t.repo.refresh(t.q());
    await t.repo.refresh(t.q({ targetKey: 'pin:41.10000,29.00000', destination: { lat: 41.1, lng: 29 } }));
    expect(t.calls).toHaveLength(2);
  });

  it('aynı istek sürerken ikincisi gönderilmez (tek uçuş)', async () => {
    let resolve!: (v: unknown) => void;
    const t = setup(() => new Promise((r) => (resolve = r)));
    const p1 = t.repo.refresh(t.q());
    const p2 = t.repo.refresh(t.q());
    expect(p2).toBe(p1);
    await Promise.resolve();
    resolve({ distance_m: 1, duration_s: 60, polyline: '', cached: true, computed_at: NOW });
    await expect(p1).resolves.toMatchObject({ result: { points: [] } });
    expect(t.calls).toHaveLength(1);
  });

  it('maps_unavailable: sakin metin, 60 sn boyunca yeniden denemez, sonra dener', async () => {
    let fail = true;
    const t = setup(() => {
      if (fail) throw httpsError('maps_unavailable');
      return { distance_m: 900, duration_s: 240, polyline: POLY, cached: false, computed_at: NOW };
    });
    const e = await t.repo.refresh(t.q());
    expect(e?.error).toEqual({ code: 'maps_unavailable', message: ROUTE_ERROR_TEXT.maps_unavailable });
    expect(e?.result).toBeNull();
    t.advance(30 * SECOND);
    await t.repo.refresh(t.q());
    expect(t.calls).toHaveLength(1);
    fail = false;
    t.advance(31 * SECOND + 5 * MINUTE);
    const ok = await t.repo.refresh(t.q());
    expect(t.calls).toHaveLength(2);
    expect(ok).toMatchObject({ error: null, result: { duration_s: 240 } });
  });

  it('quota_exceeded: o UTC günü boyunca hiç çağrı yapmaz, ertesi gün yeniden açılır', async () => {
    const t = setup(() => {
      throw httpsError('quota_exceeded', 'functions/resource-exhausted');
    });
    const e = await t.repo.refresh(t.q());
    expect(e?.error?.code).toBe('quota_exceeded');
    expect(e?.error?.message).toBe(ROUTE_ERROR_TEXT.quota_exceeded);
    t.advance(10 * MINUTE);
    const blocked = await t.repo.refresh(t.q({ targetKey: 'friend:other', destination: north(FRIEND, 3_000) }));
    expect(blocked?.error?.code).toBe('quota_exceeded');
    expect(t.calls).toHaveLength(1);
    t.advance(13 * 60 * MINUTE); // UTC gece yarısını geçti
    await t.repo.refresh(t.q({ targetKey: 'friend:other', destination: north(FRIEND, 3_000) }));
    expect(t.calls).toHaveLength(2);
  });
});

describe('geocodeRepo', () => {
  function setup(handler?: Handler) {
    let clock = NOW;
    const calls = transport({
      geocode_reverse: handler ?? ((p) => ({ label: 'Moda Caddesi, Kadıköy', cell: geocodeCell(p as { lat: number; lng: number }), cached: false })),
    });
    const repo = createGeocodeRepo({ now: () => clock });
    return { repo, calls, advance: (ms: number) => (clock += ms) };
  }

  it('görünmezken çağırmaz; ilk sorgu hemen; aynı hücre önbellekten', async () => {
    const t = setup();
    await expect(t.repo.lookup({ subjectKey: 'friend:a', position: FRIEND, visible: false })).resolves.toMatchObject({ source: 'none' });
    expect(t.calls).toHaveLength(0);
    await expect(t.repo.lookup({ subjectKey: 'friend:a', position: FRIEND, visible: true })).resolves.toMatchObject({
      label: 'Moda Caddesi, Kadıköy',
      source: 'network',
    });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.payload).toEqual({ lat: FRIEND.lat, lng: FRIEND.lng });
    // Aynı hücrede başka bir özne (bırakılan nokta) bile çağrı yapmaz.
    await expect(t.repo.lookup({ subjectKey: 'pin:x', position: north(FRIEND, 5), visible: true })).resolves.toMatchObject({ source: 'cache' });
    expect(t.calls).toHaveLength(1);
    expect(t.repo.peek(FRIEND)).toBe('Moda Caddesi, Kadıköy');
  });

  it('aynı özne 60 sn içinde başka hücreye geçse de beklenir (eski etiket), sonra ≥200 m harekette sorulur', async () => {
    const t = setup();
    await t.repo.lookup({ subjectKey: 'friend:a', position: FRIEND, visible: true });
    t.advance(20 * SECOND);
    await expect(t.repo.lookup({ subjectKey: 'friend:a', position: north(FRIEND, 400), visible: true })).resolves.toMatchObject({
      source: 'stale',
      label: 'Moda Caddesi, Kadıköy',
    });
    expect(t.calls).toHaveLength(1);
    t.advance(50 * SECOND);
    await t.repo.lookup({ subjectKey: 'friend:a', position: north(FRIEND, 400), visible: true });
    expect(t.calls).toHaveLength(2);
  });

  it('hata: 60 sn yeniden denenmez (aynı noktada sonra denenir); kota dolunca gün boyu çağrı yok', async () => {
    let mode: 'fail' | 'quota' | 'ok' = 'fail';
    const t = setup((p) => {
      if (mode === 'fail') throw httpsError('maps_unavailable');
      if (mode === 'quota') throw httpsError('quota_exceeded', 'functions/resource-exhausted');
      return { label: 'Bağdat Caddesi', cell: geocodeCell(p as { lat: number; lng: number }), cached: true };
    });
    const PIN = { lat: 40.97, lng: 29.06 };
    await expect(t.repo.lookup({ subjectKey: 'pin:p', position: PIN, visible: true })).resolves.toMatchObject({ error: 'maps_unavailable', label: null });
    t.advance(30 * SECOND);
    await t.repo.lookup({ subjectKey: 'pin:p', position: PIN, visible: true });
    expect(t.calls).toHaveLength(1);
    mode = 'quota';
    t.advance(31 * SECOND);
    await expect(t.repo.lookup({ subjectKey: 'pin:p', position: PIN, visible: true })).resolves.toMatchObject({ error: 'quota_exceeded' });
    expect(t.calls).toHaveLength(2);
    mode = 'ok';
    t.advance(5 * MINUTE);
    await expect(t.repo.lookup({ subjectKey: 'pin:q', position: { lat: 39.9, lng: 32.8 }, visible: true })).resolves.toMatchObject({ error: 'quota_exceeded' });
    expect(t.calls).toHaveLength(2);
  });
});
