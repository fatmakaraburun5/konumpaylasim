/**
 * Web demo sunucusu Faz 7 sözleşmesi (backend `handlers/events.ts`, `handlers/privacy.ts` ile aynı anlam):
 * etkinliğin 3 aşaması bot üyelerle uçtan uca, eşitlikte `leaders`, hatırlatma; pil paylaşımı (varsayılan KAPALI)
 * RTDB kuralı ve düşük pil bastırması; "yola çıktı" bildirimi.
 */
import {
  addDaysToDate,
  localDateOf,
  offsetFnForTimeZone,
  SERVER_TIMESTAMP,
  uuidV4,
  type EventDoc,
  type EventResponse,
} from '@konum/core';
import { DemoServer, type DemoPushMessage } from '../src/demo/server/server';
import { DEMO_ME, PEOPLE } from '../src/demo/server/world';
import { acceptConsent, grant, shareBattery } from './demoTestUtils';

jest.setTimeout(30_000);

const TZ = 'Europe/Istanbul';
const AYSE = PEOPLE.ayse.uid;
const MEHMET = PEOPLE.mehmet.uid;
const CAN = PEOPLE.can.uid;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const servers: DemoServer[] = [];
let clock: jest.SpyInstance | null = null;
afterEach(() => {
  clock?.mockRestore();
  clock = null;
  for (const s of servers.splice(0)) s.reset();
});

async function server(): Promise<DemoServer> {
  const s = new DemoServer();
  servers.push(s);
  await acceptConsent(s);
  return s;
}

function fakeClock(start: number): { advance: (ms: number) => void; now: () => number } {
  let t = start;
  clock = jest.spyOn(Date, 'now').mockImplementation(() => t);
  return { advance: (ms) => (t += ms), now: () => t };
}

/** Süpürücüyü hemen çalıştırır (gerçek aralık 1 sn). */
const sweep = (s: DemoServer) => (s as unknown as { sweep(): void }).sweep();
const tomorrow = (now: number) => addDaysToDate(localDateOf(now, offsetFnForTimeZone(TZ)), 1);
const eventOf = (s: DemoServer, id: string): EventDoc => {
  const e = s.eventsOf(DEMO_ME).find((x) => x.event_id === id);
  if (!e) throw new Error('etkinlik yok');
  return e;
};
const call = <T,>(s: DemoServer, name: string, payload: Record<string, unknown>, uid = DEMO_ME) => s.call(name, { op_id: uuidV4(), ...payload }, uid) as Promise<T>;

describe('demo sunucusu Faz 7: etkinlik', () => {
  it('3 aşama: izinsiz davetli düşer → botlar yanıtlar ve mekan önerir → eşit oyda leaders → saat oyu → son onay → hatırlatma', async () => {
    const s = await server();
    const c = fakeClock(Date.now());
    const pushes: DemoPushMessage[] = [];
    s.subscribePush(DEMO_ME, (m) => pushes.push(m));

    // Aşama 1: Ayşe ve Mehmet bana etkinlik daveti izni vermiş (tohum), Can vermemiş → sessizce düşer, sayısı döner.
    const created = await call<EventResponse>(s, 'event_create', {
      title: 'Kahvaltı',
      date: tomorrow(c.now()),
      time_zone: TZ,
      invitee_ids: [AYSE, MEHMET, CAN],
      venue_options: [{ name: 'Moda Kahve' }],
      time_minutes: [10 * 60, 11 * 60],
    });
    const id = created.event.event_id;
    expect(created.skipped_count).toBe(1);
    expect(created.event.invitee_ids).toEqual([AYSE, MEHMET]);
    expect(created.event.stage).toBe('rsvp');
    expect(s.noticesOf(AYSE)[0]).toMatchObject({ type: 'event_invite', event_id: id });
    expect(s.eventsOf(CAN)).toHaveLength(0);

    c.advance(15_000);
    sweep(s);
    let e = eventOf(s, id);
    expect(e.rsvp[AYSE]?.status).toBe('going');
    expect(e.rsvp[MEHMET]?.status).toBe('going');
    expect(s.noticesOf(DEMO_ME).filter((n) => n.type === 'event_rsvp')).toHaveLength(2);
    c.advance(15_000);
    sweep(s);
    e = eventOf(s, id);
    expect(e.venue_options.map((o) => o.proposed_by)).toEqual([DEMO_ME, AYSE, MEHMET]);

    // Aşama 2: mekan oylaması. Botlar farklı mekanlara oy verir; ben üçüncüsüne → eşitlik, kendiliğinden kapanmaz.
    await call(s, 'event_advance', { event_id: id, action: 'open_venue_vote' });
    expect(eventOf(s, id).stage).toBe('venue_vote');
    expect(s.noticesOf(AYSE)[0]).toMatchObject({ type: 'event_stage' });
    await call(s, 'event_vote', { event_id: id, kind: 'venue', option_id: 'v1' });
    c.advance(15_000);
    sweep(s);
    e = eventOf(s, id);
    expect(Object.keys(e.venue_votes).sort()).toEqual([AYSE, DEMO_ME, MEHMET].sort());
    expect(new Set(Object.values(e.venue_votes)).size).toBe(3);
    await expect(call(s, 'event_advance', { event_id: id, action: 'close_venue_vote' })).rejects.toMatchObject({
      details: { code: 'event_vote_tie', leaders: ['v1', 'v4', 'v5'] },
    });
    // Davetli kapatamaz.
    await expect(call(s, 'event_advance', { event_id: id, action: 'close_venue_vote', tie_break_option_id: 'v4' }, AYSE)).rejects.toMatchObject({
      details: { code: 'event_not_owner' },
    });
    await call(s, 'event_advance', { event_id: id, action: 'close_venue_vote', tie_break_option_id: 'v4' });
    e = eventOf(s, id);
    expect(e.stage).toBe('time_vote');
    expect(e.venue_option_id).toBe('v4');

    // Aşama 3: saat oyu. Botlar t2'ye; herkes oy verince kendiliğinden kesinleşir → son onay + hatırlatıcılar.
    await call(s, 'event_vote', { event_id: id, kind: 'time', option_id: 't3' });
    c.advance(15_000);
    sweep(s);
    e = eventOf(s, id);
    expect(e.stage).toBe('final');
    expect(e.time_option_id).toBe('t2');
    expect(s.noticesOf(DEMO_ME)[0]).toMatchObject({ type: 'event_stage' });
    c.advance(15_000);
    sweep(s);
    e = eventOf(s, id);
    expect(e.final_rsvp[AYSE]?.status).toBe('going');
    expect(e.final_rsvp[MEHMET]?.status).toBe('going');

    // Hatırlatma (demo paneli: sıradaki hemen gider) → bildirim kutusu + push.
    pushes.length = 0;
    expect(s.fireMyEventRemindersNow()).toBe(1);
    expect(s.noticesOf(DEMO_ME)[0]).toMatchObject({ type: 'event_reminder', event_id: id });
    expect(s.noticesOf(AYSE)[0]).toMatchObject({ type: 'event_reminder' });
    expect(s.fireMyEventRemindersNow()).toBeLessThanOrEqual(1); // diğer tür (varsa) bir kez daha
    await wait(800);
    expect(pushes.some((p) => p.data.type === 'event_reminder' && p.data.event_id === id)).toBe(true);
    expect(JSON.stringify(pushes)).not.toMatch(/"lat"|"lng"/);
  });

  it('Can "Katılamayacağım" + not bırakır (onaysız da), not kartta görünür; iptal davetlilere bildirilir', async () => {
    const s = await server();
    const c = fakeClock(Date.now());
    await grant(s, CAN, DEMO_ME, 'meetup_invite');
    const { event } = await call<EventResponse>(s, 'event_create', { title: 'Sinema', date: tomorrow(c.now()), time_zone: TZ, invitee_ids: [CAN, AYSE] });
    c.advance(15_000);
    sweep(s);
    const e = eventOf(s, event.event_id);
    expect(e.rsvp[CAN]?.status).toBe('not_going');
    expect(e.rsvp[CAN]?.note).toMatch(/ailemin yanındayım/);
    expect(s.noticesOf(DEMO_ME).find((n) => n.body.includes('Can'))?.body).toMatch(/katılamayacak/);

    await call(s, 'event_cancel', { event_id: event.event_id });
    expect(eventOf(s, event.event_id).stage).toBe('cancelled');
    expect(s.noticesOf(CAN)[0]).toMatchObject({ type: 'event_cancelled' });
  });

  it('üye olmayan için etkinlik yok gibi davranılır; arkadaşlık bitince davetli çıkarılır', async () => {
    const s = await server();
    const { event } = await call<EventResponse>(s, 'event_create', { title: 'Yürüyüş', date: tomorrow(Date.now()), time_zone: TZ, invitee_ids: [AYSE, MEHMET] });
    await expect(call(s, 'event_rsvp', { event_id: event.event_id, round: 'initial', status: 'going' }, CAN)).rejects.toMatchObject({ details: { code: 'event_not_found' } });
    const f = s.friendshipsOf(DEMO_ME).find((x) => x.member_ids.includes(MEHMET));
    await call(s, 'friendship_remove', { friendship_id: f?.id });
    expect(eventOf(s, event.event_id).invitee_ids).toEqual([AYSE]);
    expect(s.eventsOf(MEHMET)).toHaveLength(0);
  });
});

describe('demo sunucusu Faz 7: pil paylaşımı ve "yola çıktı"', () => {
  async function shareToAyse(s: DemoServer): Promise<{ shareId: string; sessionId: string; expiresAt: number }> {
    await grant(s, DEMO_ME, AYSE, 'location_view');
    const r = await call<{ session_id: string; shares: { share_id: string; receiver_id: string; expires_at: number }[] }>(s, 'share_start', {
      receiver_ids: [AYSE],
      duration: { kind: 'preset', preset: 'h1' },
      time_zone: TZ,
    });
    const sh = r.shares[0];
    if (!sh) throw new Error('paylaşım yok');
    return { shareId: sh.share_id, sessionId: r.session_id, expiresAt: sh.expires_at };
  }
  const packet = (shareId: string, expiresAt: number, extra: Record<string, unknown> = {}) => ({
    v: 1,
    share_id: shareId,
    sender_id: DEMO_ME,
    lat: 40.9842,
    lng: 29.0251,
    accuracy: 8,
    activity_state: 'walking',
    timestamp: Date.now(),
    share_mode: 'timed',
    expires_at: expiresAt,
    server_ts: SERVER_TIMESTAMP,
    ...extra,
  });

  it('varsayılan KAPALI: pil alanı reddedilir ve düşük pil bastırılır; açınca kabul edilir', async () => {
    const s = await server();
    expect(s.profileOf(DEMO_ME)?.privacy ?? null).toBeNull();
    const { shareId, sessionId, expiresAt } = await shareToAyse(s);
    const path = `live_locations/${AYSE}/${shareId}`;
    await expect(s.applyFanout({ [path]: packet(shareId, expiresAt, { battery_pct: 40 }) }, DEMO_ME)).rejects.toMatchObject({ code: 'database/permission-denied' });
    await expect(s.applyFanout({ [path]: packet(shareId, expiresAt, { is_charging: true }) }, DEMO_ME)).rejects.toMatchObject({ code: 'database/permission-denied' });
    await s.applyFanout({ [path]: packet(shareId, expiresAt) }, DEMO_ME); // pilsiz paket geçer
    const low = await call<{ status: string; receivers: number }>(s, 'battery_low_notify', { session_id: sessionId, battery_pct: 12 });
    expect(low).toMatchObject({ status: 'suppressed', receivers: 0 });

    await shareBattery(s);
    expect(s.profileOf(DEMO_ME)?.privacy).toMatchObject({ battery_share: true, movement_alerts: true });
    await s.applyFanout({ [path]: packet(shareId, expiresAt, { battery_pct: 40, is_charging: false }) }, DEMO_ME);
    expect(s.inboxOf(AYSE)[shareId]?.battery_pct).toBe(40);
    // Kapatmak onaysız da yapılabilir ve diğer tercihi korur.
    await call(s, 'privacy_settings_set', { battery_share: false });
    expect(s.profileOf(DEMO_ME)?.privacy).toMatchObject({ battery_share: false, movement_alerts: true });
  });

  it('"yola çıktı": etkin paylaşımın alıcısına heads-up; soğuma, alıcı tercihi ve eski rapor', async () => {
    const s = await server();
    const none = await call<{ status: string }>(s, 'movement_report', { kind: 'departed', at: Date.now() });
    expect(none.status).toBe('no_recipients');
    await shareToAyse(s);
    const pushes: DemoPushMessage[] = [];
    s.subscribePush(AYSE, (m) => pushes.push(m));
    expect(await call(s, 'movement_report', { kind: 'departed', at: Date.now() - 10 * 60_000 })).toMatchObject({ status: 'stale' });
    expect(await call(s, 'movement_report', { kind: 'departed', at: Date.now() })).toMatchObject({ status: 'sent', notified_count: 1 });
    expect(await call(s, 'movement_report', { kind: 'departed', at: Date.now() })).toMatchObject({ status: 'cooldown' });
    await wait(800);
    expect(pushes[0]?.data).toEqual({ type: 'movement', from: DEMO_ME, kind: 'departed' });
    expect(pushes[0]?.notification?.title).toMatch(/yola çıktı/);

    // Demo paneli: Mehmet bana paylaşıyor → bana bildirim; tercihimi kapatınca gitmez.
    expect(s.botDeparture(MEHMET)).toBe('sent');
    await call(s, 'privacy_settings_set', { movement_alerts: false });
    expect(s.botDeparture(MEHMET)).toBe('no_recipients');
  });
});
