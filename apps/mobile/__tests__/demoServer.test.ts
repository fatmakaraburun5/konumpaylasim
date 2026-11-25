/**
 * Web demo sunucusu (yalnızca tarayıcı önizlemesi) Faz 2 sözleşmesi: bağlantı yaşam döngüsü, link_live kuralları,
 * sahte Routes / Geocoding yanıtları. Native paket bu kodu içermez; test sözleşmenin backend ile aynı kaldığını denetler.
 */
import {
  decodePolyline,
  GeocodeReverseResponseSchema,
  haversineM,
  isLinkToken,
  LinkShareCreateResponseSchema,
  LinkShareUpdateResponseSchema,
  linkTokenHash,
  parseLinkLive,
  parseLinkToken,
  RouteComputeResponseSchema,
  SERVER_TIMESTAMP,
  uuidV4,
  type LatLng,
} from '@konum/core';
import { demoRoute, fakeReverseGeocode } from '../src/demo/server/fakeGoogle';
import { DemoServer } from '../src/demo/server/server';
import { AYSE_PATH, DEMO_ME, MY_LOOP } from '../src/demo/server/world';
import { acceptConsent } from './demoTestUtils';

jest.setTimeout(30_000);

const servers: DemoServer[] = [];
/** Faz 8: demo hesabım onaysız başlar; sözleşme gerçek callable ile onaylanır. */
async function server(): Promise<DemoServer> {
  const s = new DemoServer();
  servers.push(s);
  await acceptConsent(s);
  return s;
}
afterEach(() => {
  for (const s of servers.splice(0)) s.reset();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function livePacket(name = 'Deniz Kaya', expiresAt?: number) {
  const now = Date.now();
  const p: Record<string, unknown> = {
    v: 1,
    lat: 40.9842,
    lng: 29.0251,
    accuracy: 8,
    timestamp: now,
    server_ts: SERVER_TIMESTAMP,
    sender_name: name,
    share_mode: 'timed',
  };
  if (expiresAt !== undefined) p.expires_at = expiresAt;
  return p;
}

describe('demo sunucusu: bağlantı (QR) yaşam döngüsü', () => {
  it('create → token yalnızca yanıtta, link_live yazılır, izleyici canlıyı ve durdurmada bitişi görür', async () => {
    const s = await server();
    const created = LinkShareCreateResponseSchema.parse(
      await s.call('link_share_create', { op_id: uuidV4(), duration: { kind: 'preset', preset: 'h1' } }, DEMO_ME),
    );
    expect(isLinkToken(created.token)).toBe(true);
    expect(created.token_hash).toBe(linkTokenHash(created.token));
    expect(parseLinkToken(created.url)).toBe(created.token);
    expect(created.url.startsWith('https://konum.example.com/s/')).toBe(true);
    // Sunucu düz token'ı saklamaz.
    expect(JSON.stringify(s.linksWhere(DEMO_ME))).not.toContain(created.token);

    const events: string[] = [];
    const stopListen = s.listenLinkLive(
      created.token_hash,
      (v) => events.push(v ? `live:${parseLinkLive(v)?.sender_name}` : 'null'),
      () => events.push('denied'),
    );
    await s.applyFanout({ [`link_live/${created.token_hash}`]: livePacket('Deniz Kaya', created.expires_at ?? undefined) }, DEMO_ME);
    await wait(250);
    expect(events).toContain('live:Deniz Kaya');

    const stopped = LinkShareUpdateResponseSchema.parse(await s.call('link_share_stop', { op_id: uuidV4(), link_id: created.link_id }, DEMO_ME));
    expect(stopped.status).toBe('ended');
    expect(stopped.end_reason).toBe('stopped_by_sender');
    await wait(120);
    expect(events[events.length - 1]).toBe('denied');
    stopListen();

    // Biten bağlantıya yazma kural reddi alır; yeni dinleyici de reddedilir.
    await expect(s.applyFanout({ [`link_live/${created.token_hash}`]: livePacket() }, DEMO_ME)).rejects.toThrow(/PERMISSION_DENIED/);
    const late: string[] = [];
    s.listenLinkLive(created.token_hash, () => late.push('value'), () => late.push('denied'));
    await wait(250);
    expect(late).toEqual(['denied']);
  });

  it('yanıtı kaybolan create aynı op_id ile tekrarlanınca aynı bağlantı için token yenilenir', async () => {
    const s = await server();
    const op = uuidV4();
    const a = LinkShareCreateResponseSchema.parse(await s.call('link_share_create', { op_id: op, duration: { kind: 'preset', preset: 'm15' } }, DEMO_ME));
    const b = LinkShareCreateResponseSchema.parse(await s.call('link_share_create', { op_id: op, duration: { kind: 'preset', preset: 'm15' } }, DEMO_ME));
    expect(b.link_id).toBe(a.link_id);
    expect(b.token).not.toBe(a.token);
    expect(b.version).toBe(a.version + 1);
    expect(s.linksWhere(DEMO_ME)).toHaveLength(1);
    // Eski özete artık yazılamaz.
    await expect(s.applyFanout({ [`link_live/${a.token_hash}`]: livePacket('Deniz', a.expires_at ?? undefined) }, DEMO_ME)).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('uzatma Faz 1 kuralıyla, kural ACL ile aynı expires_at ister; başkasının bağlantısı link_not_found', async () => {
    const s = await server();
    const a = LinkShareCreateResponseSchema.parse(await s.call('link_share_create', { op_id: uuidV4(), duration: { kind: 'preset', preset: 'h1' } }, DEMO_ME));
    const ext = LinkShareUpdateResponseSchema.parse(await s.call('link_share_extend', { op_id: uuidV4(), link_id: a.link_id, minutes: 30 }, DEMO_ME));
    expect(ext.expires_at).toBe((a.expires_at as number) + 30 * 60_000);
    expect(ext.extended_count).toBe(1);
    await expect(s.applyFanout({ [`link_live/${a.token_hash}`]: livePacket('Deniz', a.expires_at ?? undefined) }, DEMO_ME)).rejects.toThrow(/expires_at/);
    await s.applyFanout({ [`link_live/${a.token_hash}`]: livePacket('Deniz', ext.expires_at ?? undefined) }, DEMO_ME);
    await expect(s.call('link_share_stop', { op_id: uuidV4(), link_id: a.link_id }, 'ayse')).rejects.toMatchObject({ details: { code: 'link_not_found' } });
    // İzinsiz alan (sender_id) reddedilir.
    await expect(
      s.applyFanout({ [`link_live/${a.token_hash}`]: { ...livePacket('Deniz', ext.expires_at ?? undefined), sender_id: DEMO_ME } }, DEMO_ME),
    ).rejects.toThrow(/izinsiz alan/);
  });

  it('sunucudan iptal (demo paneli) izleyiciyi hemen kapatır', async () => {
    const s = await server();
    const a = LinkShareCreateResponseSchema.parse(await s.call('link_share_create', { op_id: uuidV4(), duration: { kind: 'indefinite' } }, DEMO_ME));
    expect(a.expires_at).toBeNull();
    await s.applyFanout({ [`link_live/${a.token_hash}`]: { ...livePacket(), share_mode: 'indefinite' } }, DEMO_ME);
    const events: string[] = [];
    s.listenLinkLive(a.token_hash, (v) => events.push(v ? 'live' : 'null'), () => events.push('denied'));
    await wait(250);
    expect(events).toEqual(['live']);
    const t0 = Date.now();
    expect(s.revokeLatestLink()).toBe(true);
    while (events[events.length - 1] !== 'denied' && Date.now() - t0 < 2_000) await wait(20);
    expect(events[events.length - 1]).toBe('denied');
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe('demo sunucusu: sahte Routes / Geocoding', () => {
  const me = MY_LOOP[0] as LatLng;
  const ayse = AYSE_PATH[3] as LatLng;

  it('rota haritadaki caddeleri izler; mod hızları farklı süre verir', () => {
    const drive = demoRoute(me, ayse, 'DRIVE');
    const walk = demoRoute(me, ayse, 'WALK');
    const bike = demoRoute(me, ayse, 'BICYCLE');
    expect(drive && walk && bike).toBeTruthy();
    const crow = haversineM(me, ayse);
    for (const r of [drive, walk, bike]) {
      expect(r!.distance_m).toBeGreaterThanOrEqual(crow * 0.95);
      expect(r!.distance_m).toBeLessThan(crow * 3);
      expect(r!.points.length).toBeGreaterThan(2);
    }
    expect(walk!.duration_s).toBeGreaterThan(bike!.duration_s);
    expect(walk!.duration_s).toBeGreaterThan(drive!.duration_s);
    // Denizdeki nokta: rota yok.
    expect(demoRoute(me, { lat: 40.985, lng: 29.015 }, 'WALK')).toBeNull();
  });

  it('route_compute: önbellek (5 dk dilimi) isabeti cached:true, kota sayılmaz; Google kapalıyken maps_unavailable', async () => {
    const s = await server();
    const req = { origin: me, destination: ayse, travel_mode: 'DRIVE' as const };
    const first = RouteComputeResponseSchema.parse(await s.call('route_compute', { op_id: uuidV4(), ...req }, DEMO_ME));
    expect(first.cached).toBe(false);
    expect(decodePolyline(first.polyline).length).toBeGreaterThan(2);
    const second = RouteComputeResponseSchema.parse(await s.call('route_compute', { op_id: uuidV4(), ...req }, DEMO_ME));
    expect(second.cached).toBe(true);
    expect(second.duration_s).toBe(first.duration_s);
    expect(s.snapshot().maps).toMatchObject({ route: 1, routeHits: 1 });
    s.setMapsDown(true);
    await expect(s.call('route_compute', { op_id: uuidV4(), ...req, travel_mode: 'WALK' }, DEMO_ME)).rejects.toMatchObject({ details: { code: 'maps_unavailable' } });
  });

  it('geocode_reverse: hücre merkezine en yakın cadde, denizde etiket yok, ikinci istek önbellekten', async () => {
    const s = await server();
    const r1 = GeocodeReverseResponseSchema.parse(await s.call('geocode_reverse', ayse, DEMO_ME));
    expect(r1.label).toMatch(/Kadıköy$/);
    expect(r1.cached).toBe(false);
    const r2 = GeocodeReverseResponseSchema.parse(await s.call('geocode_reverse', ayse, DEMO_ME));
    expect(r2.cached).toBe(true);
    expect(fakeReverseGeocode({ lat: 40.985, lng: 29.015 })).toMatchObject({ status: 'ZERO_RESULTS' });
  });
});
