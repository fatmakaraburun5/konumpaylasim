/**
 * Web demo sunucusu (yalnızca tarayıcı önizlemesi) Faz 3 sözleşmesi: kuyruk paketi (`q`, `hb`, `recorded_at`),
 * `live_trail` yazma/okuma kuralları, `battery_low_notify`, demo paneli senaryoları (Ayşe'nin pili, Mehmet'in
 * bağlantısı). Native paket bu kodu içermez; test sözleşmenin backend / RTDB kurallarıyla aynı kaldığını denetler.
 */
import {
  lastVerifiedLocation,
  MINUTE,
  outboxPointId,
  parseDelivered,
  SERVER_TIMESTAMP,
  uuidV4,
  type ReceivedFix,
} from '@konum/core';
import { AYSE_LOW_BATTERY, DemoServer, type DemoPushMessage } from '../src/demo/server/server';
import { DEMO_ME, PEOPLE } from '../src/demo/server/world';
import { acceptConsent, grant } from './demoTestUtils';

jest.setTimeout(30_000);

const servers: DemoServer[] = [];
async function server(): Promise<DemoServer> {
  const s = new DemoServer();
  servers.push(s);
  await acceptConsent(s); // Faz 8: onaysız hesap çağrı yapamaz
  return s;
}
let clock: jest.SpyInstance | null = null;
afterEach(() => {
  clock?.mockRestore();
  clock = null;
  for (const s of servers.splice(0)) s.reset();
});

const AYSE = PEOPLE.ayse.uid;
const MEHMET = PEOPLE.mehmet.uid;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Date.now'u ileri sarılabilir yapar (sunucu kuralları `Date.now()` ile çalışır). */
function fakeClock(start: number): { advance: (ms: number) => void; now: () => number } {
  let t = start;
  clock = jest.spyOn(Date, 'now').mockImplementation(() => t);
  return { advance: (ms) => (t += ms), now: () => t };
}

async function startShareToAyse(s: DemoServer): Promise<{ shareId: string; sessionId: string; expiresAt: number }> {
  await grant(s, DEMO_ME, AYSE, 'location_view'); // Faz 8: izin varsayılan kapalı
  const r = (await s.call(
    'share_start',
    { op_id: uuidV4(), receiver_ids: [AYSE], duration: { kind: 'preset', preset: 'h1' }, time_zone: 'Europe/Istanbul' },
    DEMO_ME,
  )) as { session_id: string; shares: { share_id: string; receiver_id: string; expires_at: number }[] };
  const share = r.shares.find((x) => x.receiver_id === AYSE);
  if (!share) throw new Error('Ayşe paylaşımı yok');
  return { shareId: share.share_id, sessionId: r.session_id, expiresAt: share.expires_at };
}

function packet(shareId: string, expiresAt: number, ts: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    share_id: shareId,
    sender_id: DEMO_ME,
    lat: 40.9842,
    lng: 29.0251,
    accuracy: 8,
    activity_state: 'walking',
    timestamp: ts,
    share_mode: 'timed',
    expires_at: expiresAt,
    server_ts: SERVER_TIMESTAMP,
    battery_pct: 61,
    ...extra,
  };
}

function trailPoint(ts: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, lat: 40.9843, lng: 29.0252, accuracy: 9, timestamp: ts, recorded_at: ts, q: 1, server_ts: SERVER_TIMESTAMP, battery_pct: 61, ...extra };
}

describe('demo sunucusu Faz 3: kuyruk paketi ve çevrimdışı iz', () => {
  it('q:1 + hb kabul; 2 dk’dan eski nokta yalnızca q:1 ile, paylaşımdan sonra ve canlı noktadan yeniyse', async () => {
    const c = fakeClock(Date.now());
    const s = await server();
    const { shareId, expiresAt } = await startShareToAyse(s);
    const t0 = c.now();
    c.advance(10 * MINUTE);
    const path = `live_locations/${AYSE}/${shareId}`;

    // Kuyruktan, paylaşım başladıktan 3 dk sonra kaydedilmiş nokta (7 dk eski): q:1 ile kabul.
    await s.applyFanout({ [path]: packet(shareId, expiresAt, t0 + 3 * MINUTE, { q: 1, recorded_at: t0 + 3 * MINUTE, hb: 60_000 }) }, DEMO_ME);
    const got = parseDelivered(s.inboxOf(AYSE)[shareId]);
    expect(got?.timestamp).toBe(t0 + 3 * MINUTE);
    expect(got?.q).toBe(1);
    expect(got?.hb).toBe(60_000);

    // Aynı yaşta q'suz nokta: reddedilir.
    await expect(s.applyFanout({ [path]: packet(shareId, expiresAt, t0 + 4 * MINUTE) }, DEMO_ME)).rejects.toThrow(/timestamp/);
    // Canlı noktadan eski kuyruk noktası: reddedilir (alıcıdaki taze nokta ezilmez).
    await expect(s.applyFanout({ [path]: packet(shareId, expiresAt, t0 + 2 * MINUTE, { q: 1, recorded_at: t0 + 2 * MINUTE }) }, DEMO_ME)).rejects.toThrow(/eski/);
    // Paylaşımdan önce kaydedilmiş nokta: reddedilir.
    await expect(s.applyFanout({ [path]: packet(shareId, expiresAt, t0 - MINUTE, { q: 1, recorded_at: t0 - MINUTE }) }, DEMO_ME)).rejects.toThrow(/eski/);
    // Taze pencerede (2 dk içinde) bile kuyruk noktası canlıdan eski olamaz (RTDB kuralı: taze pencere yalnızca q !== 1).
    await s.applyFanout({ [path]: packet(shareId, expiresAt, c.now() - 30_000) }, DEMO_ME);
    await expect(s.applyFanout({ [path]: packet(shareId, expiresAt, c.now() - 60_000, { q: 1, recorded_at: c.now() - 60_000 }) }, DEMO_ME)).rejects.toThrow(/eski/);
    // Geçersiz hb (10 sn altı): reddedilir.
    await expect(s.applyFanout({ [path]: packet(shareId, expiresAt, c.now(), { hb: 1000 }) }, DEMO_ME)).rejects.toThrow(/hb/);
  });

  it('live_trail: yalnızca gönderen yazar, yalnızca TRAIL_FIELDS; alıcı okur; paylaşım bitince iz silinir', async () => {
    const c = fakeClock(Date.now());
    const s = await server();
    const { shareId, sessionId } = await startShareToAyse(s);
    const t0 = c.now();
    c.advance(5 * MINUTE);
    const base = `live_trail/${AYSE}/${shareId}`;
    const ids = [1, 2, 3].map((i) => outboxPointId(t0 + i * MINUTE, i));
    await s.applyFanout(Object.fromEntries(ids.map((id, i) => [`${base}/${id}`, trailPoint(t0 + (i + 1) * MINUTE)])), DEMO_ME);
    const trail = s.trailOf(AYSE)[shareId] ?? {};
    expect(Object.keys(trail).sort()).toEqual([...ids].sort());
    expect(typeof trail[ids[0] as string]?.server_ts).toBe('number');

    // Başkası (alıcının kendisi bile) yazamaz; izinsiz alan ve bozuk kimlik reddedilir.
    await expect(s.applyFanout({ [`${base}/${outboxPointId(c.now(), 9)}`]: trailPoint(c.now()) }, AYSE)).rejects.toThrow();
    await expect(s.applyFanout({ [`${base}/${outboxPointId(c.now(), 8)}`]: trailPoint(c.now(), { speed_mps: 1 }) }, DEMO_ME)).rejects.toThrow(/izinsiz/);
    await expect(s.applyFanout({ [`${base}/abc`]: trailPoint(c.now()) }, DEMO_ME)).rejects.toThrow(/point_id/);
    await expect(s.applyFanout({ [`${base}/${outboxPointId(t0 - MINUTE, 7)}`]: trailPoint(t0 - MINUTE) }, DEMO_ME)).rejects.toThrow(/paylaşımdan eski/);

    // Alıcı tarafı: iz + canlı → core son doğrulanmış konum; kuyruktan gelen nokta işaretli.
    const fixes: ReceivedFix[] = Object.values(trail).map((p) => ({
      lat: p.lat as number,
      lng: p.lng as number,
      accuracy: p.accuracy as number,
      timestamp: p.timestamp as number,
      server_ts: p.server_ts as number,
      battery_pct: (p.battery_pct as number) ?? null,
      q: 1,
    }));
    const lv = lastVerifiedLocation(fixes, c.now());
    expect(lv?.fromQueue).toBe(true);
    expect(lv?.recorded_at).toBe(t0 + 3 * MINUTE);

    // Gönderen durdurur → iz düğümü silinir.
    await s.call('share_stop', { op_id: uuidV4(), session_id: sessionId }, DEMO_ME);
    expect(s.trailOf(AYSE)[shareId]).toBeUndefined();
  });
});

describe('demo sunucusu Faz 3: düşük pil', () => {
  it('battery_low_notify: %14 → notified + alıcıya push; tekrar noop; %20 → yeniden kurulur', async () => {
    const s = await server();
    const { sessionId, shareId } = await startShareToAyse(s);
    const pushes: DemoPushMessage[] = [];
    s.subscribePush(AYSE, (m) => pushes.push(m));

    const r1 = (await s.call('battery_low_notify', { op_id: uuidV4(), session_id: sessionId, battery_pct: 14 }, DEMO_ME)) as { status: string; receivers: number };
    expect(r1.status).toBe('notified');
    expect(r1.receivers).toBe(1);
    await wait(800);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.data).toMatchObject({ type: 'battery_low', share_id: shareId, battery_pct: '14' });
    expect(pushes[0]?.notification?.title).toMatch(/pili azaldı/);
    expect(JSON.stringify(pushes[0])).not.toMatch(/lat|lng/); // push koordinat taşımaz

    const r2 = (await s.call('battery_low_notify', { op_id: uuidV4(), session_id: sessionId, battery_pct: 12 }, DEMO_ME)) as { status: string };
    expect(r2.status).toBe('suppressed'); // bu düşüş için zaten bildirildi
    const r3 = (await s.call('battery_low_notify', { op_id: uuidV4(), session_id: sessionId, battery_pct: 21 }, DEMO_ME)) as { status: string; armed: boolean };
    expect(r3.status).toBe('rearmed');
    expect(r3.armed).toBe(true);
    await expect(s.call('battery_low_notify', { op_id: uuidV4(), session_id: 'yok', battery_pct: 10 }, DEMO_ME)).rejects.toMatchObject({ code: expect.any(String) });
  });

  it('demo paneli: Ayşe’nin pili %14 → bana push ve canlı pakette pil %14', async () => {
    const s = await server();
    const pushes: DemoPushMessage[] = [];
    s.subscribePush(DEMO_ME, (m) => pushes.push(m));
    expect(s.setAyseBattery(AYSE_LOW_BATTERY)).toBe('notified');
    await wait(800);
    expect(pushes.some((m) => m.data.type === 'battery_low' && /Ayşe/.test(m.notification?.title ?? ''))).toBe(true);
    const fromAyse = Object.values(s.inboxOf(DEMO_ME)).find((v) => v.sender_id === AYSE);
    expect(fromAyse?.battery_pct).toBe(AYSE_LOW_BATTERY);
    expect(s.snapshot().ayseBattery).toBe(AYSE_LOW_BATTERY);
  });
});

describe('demo sunucusu Faz 3: arkadaşın bağlantısı koptu', () => {
  it('Mehmet: son paket 63 dk önce, hb ile → core "Bağlantısı kopmuş olabilir"; geri gelince canlı', async () => {
    const s = await server();
    expect(s.mehmetDisconnect()).toBe(true);
    const node = Object.values(s.inboxOf(DEMO_ME)).find((v) => v.sender_id === MEHMET);
    const loc = parseDelivered(node);
    expect(loc).not.toBeNull();
    const now = Date.now();
    expect(now - (loc?.server_ts ?? now)).toBeGreaterThan(60 * MINUTE);
    const lv = lastVerifiedLocation([{ ...(loc as ReceivedFix), battery_pct: loc?.battery_pct ?? null }], now);
    expect(lv?.status).toBe('offline_suspected');
    expect(lv?.label).toMatch(/^Son doğrulanmış konum · \d{2}:\d{2} · %\d+$/);
    expect(s.snapshot().mehmetOffline).toBe(true);

    expect(s.mehmetReconnect()).toBe(true);
    const fresh = parseDelivered(Object.values(s.inboxOf(DEMO_ME)).find((v) => v.sender_id === MEHMET));
    expect(Date.now() - (fresh?.server_ts ?? 0)).toBeLessThan(MINUTE);
    expect(s.snapshot().mehmetOffline).toBe(false);
  });
});
