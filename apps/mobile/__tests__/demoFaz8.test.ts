/**
 * Web demo sunucusu Faz 8 sözleşmesi: yönlü izinler (varsayılan kapalı), izin isteği / yanıtı, geri alma zinciri,
 * görünmez mod (yayın yok, yalnızca seçilenler geri gelir), sözleşme onayı kapısı. Backend `handlers/access.ts` ile
 * aynı kuralları denetler; arkadaşa görünmezlik / geri alma hiçbir yoldan söylenmez.
 */
import { SERVER_TIMESTAMP, uuidV4, type PermissionGrantDoc } from '@konum/core';
import { DemoServer, type DemoPushMessage } from '../src/demo/server/server';
import { DEMO_ME, PEOPLE } from '../src/demo/server/world';
import { acceptConsent, consentPayload, grant } from './demoTestUtils';

jest.setTimeout(30_000);

const servers: DemoServer[] = [];
async function server(consent = true): Promise<DemoServer> {
  const s = new DemoServer();
  servers.push(s);
  if (consent) await acceptConsent(s);
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
const CAN = PEOPLE.can.uid;
const TZ = 'Europe/Istanbul';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { details?: { code?: string }; code?: string }).details?.code ?? (e as { code?: string }).code ?? String(e);
  }
};
const scopesOf = (docs: PermissionGrantDoc[], granter: string, grantee: string) =>
  Object.entries(docs.find((d) => d.granter_id === granter && d.grantee_id === grantee)?.scopes ?? {})
    .filter(([, v]) => !!v)
    .map(([k]) => k)
    .sort();
const shareStart = (s: DemoServer, ids: string[], extra: Record<string, unknown> = {}) =>
  s.call('share_start', { op_id: uuidV4(), receiver_ids: ids, duration: { kind: 'preset', preset: 'h1' }, time_zone: TZ, ...extra }, DEMO_ME) as Promise<{
    session_id: string;
    shares: { share_id: string; receiver_id: string; expires_at: number }[];
    needs_grant_receiver_ids: string[];
  }>;
const sweep = (s: DemoServer) => (s as unknown as { sweep: () => void }).sweep();
function fakeClock(start: number): { advance: (ms: number) => void } {
  let t = start;
  clock = jest.spyOn(Date, 'now').mockImplementation(() => t);
  return { advance: (ms) => (t += ms) };
}

describe('demo Faz 8: yönlü izinler varsayılan kapalı', () => {
  it('tohum: Ayşe/Mehmet/Zeynep bana konum izni vermiş, Can vermemiş; benim kimseye iznim yok', async () => {
    const s = await server();
    const docs = s.grantsOf(DEMO_ME);
    for (const id of [AYSE, MEHMET, PEOPLE.zeynep.uid]) expect(scopesOf(docs, id, DEMO_ME)).toContain('location_view');
    expect(scopesOf(docs, CAN, DEMO_ME)).toEqual([]);
    expect(docs.filter((d) => d.granter_id === DEMO_ME).flatMap((d) => scopesOf(docs, DEMO_ME, d.grantee_id))).toEqual([]);
    // Ret anları istemciye gitmez.
    expect(docs.every((d) => Object.keys(d.declined_at ?? {}).length === 0)).toBe(true);
    // Can izinsiz paylaşamaz (bot da kurala uyar).
    expect(s.isSharingWithMe(CAN)).toBe(false);
    expect(s.botStartSharing(CAN)).toBe(false);
    expect(s.snapshot().f8).toMatchObject({ myInvisible: false, myDeliveriesCount: 0, givenLocation: [], ayseGrantsMe: true });
  });

  it('share_start izinsiz alıcıyı needs_grant_receiver_ids ile döner; bayrakla izin aynı işlemde yazılır (via share)', async () => {
    const s = await server();
    const r1 = await shareStart(s, [AYSE, 'yabanci']);
    expect(r1.shares).toEqual([]);
    expect(r1.needs_grant_receiver_ids).toEqual([AYSE]);
    expect(s.sharesWhere('sender_id', DEMO_ME)).toEqual([]);
    const r2 = await shareStart(s, [AYSE], { grant_location_view: true });
    expect(r2.shares.map((x) => x.receiver_id)).toEqual([AYSE]);
    expect(r2.needs_grant_receiver_ids).toEqual([]);
    const doc = s.grantsOf(DEMO_ME).find((d) => d.granter_id === DEMO_ME && d.grantee_id === AYSE);
    expect(doc?.scopes.location_view).toBeTruthy();
    expect(JSON.stringify(doc)).toContain('share');
  });

  it('ping yönü: alıcının izni gerekir; Mehmet ping izni verince ping gider, konum yalnızca benim konum iznimle', async () => {
    const s = await server();
    const at = { lat: 40.98, lng: 29.02, accuracy: 8, timestamp: Date.now() };
    const ping = () => s.call('ping_send', { op_id: uuidV4(), to: MEHMET, kind: 'here', location: at }, DEMO_ME);
    expect(await codeOf(ping())).toBe('not_permitted');
    const pushes: DemoPushMessage[] = [];
    s.subscribePush(DEMO_ME, (m) => pushes.push(m));
    expect(s.mehmetGrantsPing()).toBe(true);
    await wait(800);
    expect(pushes.find((m) => m.data.type === 'permission_granted')?.data).toEqual({ type: 'permission_granted', by: MEHMET, scopes: 'ping' });
    expect(await codeOf(ping())).toBe('ok');
    // Ben Mehmet'e konum izni vermedim → ping'deki konum sessizce çıkarıldı.
    expect(Object.values(s.pingInboxOf(MEHMET)).every((p) => p.location === undefined)).toBe(true);
  });
});

describe('demo Faz 8: izin isteği ve yanıtı', () => {
  it('Can benden konum izni ister → push (koordinatsız); izin verip 1 saat paylaşırım; Can\'a "izin verdi" push\'u', async () => {
    const s = await server();
    const mine: DemoPushMessage[] = [];
    const cans: DemoPushMessage[] = [];
    s.subscribePush(DEMO_ME, (m) => mine.push(m));
    s.subscribePush(CAN, (m) => cans.push(m));
    expect(s.canRequestsMyLocation()).toBe(true);
    await wait(800);
    const req = mine.find((m) => m.data.type === 'permission_request');
    expect(req?.data).toEqual({ type: 'permission_request', from: CAN, scopes: 'location_view' });
    expect(req?.notification?.body).toMatch(/Can.*konumunu görmek istiyor/);
    expect(JSON.stringify(req)).not.toMatch(/"lat"|"lng"/);
    expect(s.snapshot().f8.pendingIncoming).toBe(1);

    const res = (await s.call(
      'permission_request_respond',
      { op_id: uuidV4(), requester_id: CAN, grant_scopes: ['location_view'], share: { duration: { kind: 'preset', preset: 'h1' }, time_zone: TZ } },
      DEMO_ME,
    )) as { granted_scopes: string[]; share: { shares: { receiver_id: string }[] } | null; share_skipped: string | null };
    expect(res.granted_scopes).toEqual(['location_view']);
    expect(res.share?.shares.map((x) => x.receiver_id)).toEqual([CAN]);
    expect(res.share_skipped).toBeNull();
    expect(s.snapshot().f8.pendingIncoming).toBe(0);
    await wait(800);
    expect(cans.some((m) => m.data.type === 'permission_granted' && m.data.by === DEMO_ME)).toBe(true);
  });

  it('ret: istek düşer, isteyene push yok; yanıt "sent" dışında bir şey sızdırmaz', async () => {
    const s = await server();
    const cans: DemoPushMessage[] = [];
    s.subscribePush(CAN, (m) => cans.push(m));
    s.canRequestsMyLocation();
    const res = (await s.call('permission_request_respond', { op_id: uuidV4(), requester_id: CAN, grant_scopes: [] }, DEMO_ME)) as {
      granted_scopes: string[];
      declined_scopes: string[];
    };
    expect(res).toMatchObject({ granted_scopes: [], declined_scopes: ['location_view'] });
    await wait(800);
    expect(cans.filter((m) => String(m.data.type).startsWith('permission'))).toEqual([]);
    expect(scopesOf(s.grantsOf(CAN), DEMO_ME, CAN)).toEqual([]);
    // Ret anı isteyenin okuduğu belgede yok (soğuma sunucuya özel).
    expect(s.grantsOf(CAN).every((d) => Object.keys(d.declined_at ?? {}).length === 0)).toBe(true);
  });

  it('benim Can\'a isteğim: 6 sn sonra Can izin verir ve 1 saat paylaşır; tekrar istek already_granted', async () => {
    const c = fakeClock(Date.now());
    const s = await server();
    const mine: DemoPushMessage[] = [];
    s.subscribePush(DEMO_ME, (m) => mine.push(m));
    const send = () => s.call('permission_request_send', { op_id: uuidV4(), target_id: CAN, scopes: ['location_view'] }, DEMO_ME) as Promise<{ status: string }>;
    expect((await send()).status).toBe('sent');
    expect(s.snapshot().f8.pendingOutgoing).toBe(1);
    c.advance(3_000);
    sweep(s);
    expect(s.isSharingWithMe(CAN)).toBe(false);
    c.advance(3_500);
    sweep(s);
    expect(scopesOf(s.grantsOf(DEMO_ME), CAN, DEMO_ME)).toEqual(['location_view']);
    expect(s.isSharingWithMe(CAN)).toBe(true);
    await wait(800);
    expect(mine.some((m) => m.data.type === 'permission_granted' && m.data.by === CAN)).toBe(true);
    expect((await send()).status).toBe('already_granted');
  });

  it('Ayşe iznini geri alır → paylaşımı sıradan durdurma gibi biter, bana izinle ilgili push yok; yeniden verir', async () => {
    const s = await server();
    expect(s.isSharingWithMe(AYSE)).toBe(true);
    const mine: DemoPushMessage[] = [];
    s.subscribePush(DEMO_ME, (m) => mine.push(m));
    expect(s.ayseRevokes()).toBe('revoked');
    expect(s.isSharingWithMe(AYSE)).toBe(false);
    expect(Object.values(s.inboxOf(DEMO_ME)).some((v) => v.sender_id === AYSE)).toBe(false);
    const ended = s.sharesWhere('receiver_id', DEMO_ME).filter((x) => x.sender_id === AYSE);
    expect(ended.every((x) => x.status !== 'active' && x.end_reason === 'stopped_by_sender')).toBe(true);
    await wait(800);
    expect(mine.filter((m) => /permission|revok|invisible/.test(String(m.data.type)))).toEqual([]);
    expect(s.ayseRevokes()).toBe('granted');
    expect(s.isSharingWithMe(AYSE)).toBe(true);
  });
});

describe('demo Faz 8: görünmez mod', () => {
  it('görünmez olunca paylaşımlar biter, yayın reddedilir, yeni paylaşım invisible_mode; görünürken yalnızca seçilen geri gelir', async () => {
    const s = await server();
    await grant(s, DEMO_ME, AYSE, 'location_view');
    await grant(s, DEMO_ME, MEHMET, 'location_view');
    const started = await shareStart(s, [AYSE, MEHMET]);
    expect(started.shares).toHaveLength(2);
    const ayseShare = started.shares.find((x) => x.receiver_id === AYSE)!;
    const theirs: DemoPushMessage[] = [];
    s.subscribePush(AYSE, (m) => theirs.push(m));
    s.subscribePush(MEHMET, (m) => theirs.push(m));

    await s.call('invisible_set', { op_id: uuidV4(), invisible: true }, DEMO_ME);
    expect(s.profileOf(DEMO_ME)?.invisible).toMatchObject({ on: true });
    expect(s.profileOf(DEMO_ME)?.invisible?.snapshot.map((e) => e.receiver_id).sort()).toEqual([AYSE, MEHMET].sort());
    expect(s.sharesWhere('sender_id', DEMO_ME).every((x) => x.status !== 'active')).toBe(true);
    expect(s.snapshot().f8).toMatchObject({ myInvisible: true, myDeliveriesCount: 0 });
    expect(await codeOf(shareStart(s, [AYSE]))).toBe('invisible_mode');
    // Bayat bir paket bile yazılamaz.
    const path = `live_locations/${AYSE}/${ayseShare.share_id}`;
    const packet = {
      v: 1,
      share_id: ayseShare.share_id,
      sender_id: DEMO_ME,
      lat: 40.98,
      lng: 29.02,
      accuracy: 9,
      activity_state: 'still',
      timestamp: Date.now(),
      share_mode: 'timed',
      expires_at: ayseShare.expires_at,
      server_ts: SERVER_TIMESTAMP,
    };
    await expect(s.applyFanout({ [path]: packet }, DEMO_ME)).rejects.toBeTruthy();
    expect(s.inboxOf(AYSE)[ayseShare.share_id]).toBeUndefined();

    const off = (await s.call('invisible_set', { op_id: uuidV4(), invisible: false, restore_receiver_ids: [AYSE] }, DEMO_ME)) as {
      restored_receiver_ids: string[];
    };
    expect(off.restored_receiver_ids).toEqual([AYSE]);
    const active = s.sharesWhere('sender_id', DEMO_ME).filter((x) => x.status === 'active');
    expect(active.map((x) => x.receiver_id)).toEqual([AYSE]);
    expect(s.profileOf(DEMO_ME)?.invisible ?? null).toBeNull();
    await wait(800);
    // Arkadaşa görünmezlik söylenmez; push'ta koordinat yok.
    expect(JSON.stringify(theirs)).not.toMatch(/invisible|görünmez|"lat"|"lng"/i);
  });
});

describe('demo Faz 8: sözleşme onayı', () => {
  it('onaysız hesap: muaf olmayan çağrı consent_required; yanlış özet / sürüm reddedilir; kaydırmadan onay şemada reddedilir', async () => {
    const s = await server(false);
    expect(s.profileOf(DEMO_ME)?.consent ?? null).toBeNull();
    expect(await codeOf(shareStart(s, [AYSE], { grant_location_view: true }))).toBe('consent_required');
    expect(await codeOf(s.call('permission_set', { op_id: uuidV4(), grantee_id: AYSE, scope: 'location_view', granted: true }, DEMO_ME))).toBe('consent_required');
    // Muaf: geri alma her zaman çalışır.
    expect(await codeOf(s.call('permission_set', { op_id: uuidV4(), grantee_id: AYSE, scope: 'location_view', granted: false }, DEMO_ME))).toBe('ok');
    expect(await codeOf(s.call('consent_accept', consentPayload({ text_sha256: 'a'.repeat(64) }), DEMO_ME))).toBe('consent_required');
    expect(await codeOf(s.call('consent_accept', consentPayload({ version: '2020-01-01' }), DEMO_ME))).toBe('consent_required');
    expect(await codeOf(s.call('consent_accept', consentPayload({ scrolled_to_bottom: false }), DEMO_ME))).toBe('invalid_argument');
    expect(s.profileOf(DEMO_ME)?.consent ?? null).toBeNull();

    await acceptConsent(s);
    expect(s.snapshot().f8.consent).toMatchObject({ current: true });
    expect((await shareStart(s, [AYSE], { grant_location_view: true })).shares).toHaveLength(1);

    // Metin güncellendi → yeniden onay gerekir.
    s.bumpConsent();
    expect(s.snapshot().f8.consent).toMatchObject({ current: false });
    expect(await codeOf(shareStart(s, [MEHMET], { grant_location_view: true }))).toBe('consent_required');
    await acceptConsent(s);

    // Açık rızayı geri çekmek giden paylaşımları bitirir ve kapıyı yeniden açar.
    const w = (await s.call('consent_withdraw', { op_id: uuidV4() }, DEMO_ME)) as { shares_ended: number };
    expect(w.shares_ended).toBe(1);
    expect(s.profileOf(DEMO_ME)?.consent ?? null).toBeNull();
    expect(await codeOf(shareStart(s, [AYSE]))).toBe('consent_required');
  });
});
