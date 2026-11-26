/**
 * Web demo sunucusu Faz 9 sözleşmesi (backend `handlers/proofs.ts`, `approach.ts`, `safeReturn.ts` ile aynı anlam):
 * anlık fotoğraf (yalnızca kamera, taze çekim, erişim her istekte, 1 saatte silinme), "Neredeyse vardım" tek sefer,
 * Güvenli Dönüş (başlat → son uyarı → sunucu alarmı = SOS `origin: 'safe_return'`), onay geri çekme zinciri.
 */
import { PROOF_LIMITS, SAFE_RETURN_LIMITS, SERVER_TIMESTAMP, uuidV4, type SafeReturnDoc, type SosAlert } from '@konum/core';
import { DEMO_PROOF_FALLBACK } from '../src/demo/server/proofFallback';
import { DemoServer, type DemoPushMessage } from '../src/demo/server/server';
import { DEMO_ME, PEOPLE } from '../src/demo/server/world';
import { acceptConsent } from './demoTestUtils';

jest.setTimeout(30_000);

const servers: DemoServer[] = [];
async function server(): Promise<DemoServer> {
  const s = new DemoServer();
  servers.push(s);
  await acceptConsent(s);
  return s;
}
let clock: jest.SpyInstance | null = null;
afterEach(() => {
  clock?.mockRestore();
  clock = null;
  for (const s of servers.splice(0)) s.reset();
});

const AYSE = PEOPLE.ayse.uid;
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
const sweep = (s: DemoServer) => (s as unknown as { sweep: () => void }).sweep();
function fakeClock(start: number): { advance: (ms: number) => void } {
  let t = start;
  clock = jest.spyOn(Date, 'now').mockImplementation(() => t);
  return { advance: (ms) => (t += ms) };
}
function pushes(s: DemoServer, uid: string): DemoPushMessage[] {
  const list: DemoPushMessage[] = [];
  s.subscribePush(uid, (m) => list.push(m));
  return list;
}
const shareTo = (s: DemoServer, ids: string[]) =>
  s.call('share_start', { op_id: uuidV4(), receiver_ids: ids, duration: { kind: 'preset', preset: 'h1' }, time_zone: TZ, grant_location_view: true }, DEMO_ME) as Promise<{
    session_id: string;
  }>;
const proofCreate = (s: DemoServer, extra: Record<string, unknown> = {}, uid = DEMO_ME) =>
  s.call(
    'proof_create',
    {
      op_id: uuidV4(),
      source: 'camera',
      jpeg_b64: DEMO_PROOF_FALLBACK.base64,
      width: DEMO_PROOF_FALLBACK.width,
      height: DEMO_PROOF_FALLBACK.height,
      captured_at: Date.now() - 1_000,
      caption: 'Mekana geçtim, masamız burası',
      ...extra,
    },
    uid,
  ) as Promise<{ proof: { proof_id: string; expires_at: number; caption: string | null }; replaced_proof_id: string | null }>;
const proofGet = (s: DemoServer, viewer: string, owner: string, proof_id: string) =>
  s.call('proof_get', { owner_id: owner, proof_id }, viewer) as Promise<{ jpeg_b64: string; proof: { proof_id: string } }>;
const fix = (over: Record<string, unknown> = {}) => ({ lat: 40.9875, lng: 29.0281, accuracy: 12, timestamp: Date.now() - 500, battery_pct: 23, is_charging: false, ...over });
const srStart = (s: DemoServer, contacts: string[], extra: Record<string, unknown> = {}) =>
  s.call(
    'safe_return_start',
    { op_id: uuidV4(), duration_min: 15, destination: { kind: 'point', name: 'Ev', zone_id: null }, contact_ids: contacts, fix: fix(), time_zone: TZ, ...extra },
    DEMO_ME,
  ) as Promise<{ safe_return: SafeReturnDoc; notified_count: number }>;

describe('demo Faz 9: anlık fotoğraf ispatı', () => {
  it('yalnızca taze kamera karesi; erişim etkin paylaşıma bağlı; yenisi eskisinin yerine geçer', async () => {
    const s = await server();
    // Galeri yolu yok: kaynak yalnızca `camera`; eski kare reddedilir; JPEG olmayan reddedilir.
    expect(await codeOf(proofCreate(s, { source: 'gallery' }))).toBe('invalid_argument');
    expect(await codeOf(proofCreate(s, { captured_at: Date.now() - PROOF_LIMITS.captureMaxAgeMs - 5_000 }))).toBe('proof_stale_capture');
    expect(await codeOf(proofCreate(s, { jpeg_b64: 'QUJDREVGR0hJSktMTU5PUA==' }))).toBe('proof_invalid');
    expect(await codeOf(proofCreate(s, { width: 999 }))).toBe('proof_invalid');

    const p1 = await proofCreate(s);
    expect(p1.proof.expires_at - Date.now()).toBeGreaterThan(PROOF_LIMITS.ttlMs - 5_000);
    // Paylaşım almayan görmez (varlık sızmaz); sahibi görür.
    expect(await codeOf(proofGet(s, AYSE, DEMO_ME, p1.proof.proof_id))).toBe('proof_not_found');
    expect((await proofGet(s, DEMO_ME, DEMO_ME, p1.proof.proof_id)).jpeg_b64.length).toBeGreaterThan(100);
    await shareTo(s, [AYSE]);
    const got = await proofGet(s, AYSE, DEMO_ME, p1.proof.proof_id);
    expect(got.jpeg_b64.startsWith('/9j/')).toBe(true);
    expect(await codeOf(proofGet(s, CAN, DEMO_ME, p1.proof.proof_id))).toBe('proof_not_found');

    const p2 = await proofCreate(s);
    expect(p2.replaced_proof_id).toBe(p1.proof.proof_id);
    expect(await codeOf(proofGet(s, AYSE, DEMO_ME, p1.proof.proof_id))).toBe('proof_expired');
    expect(s.snapshot().f9.proofObjects).toBe(1);
    // Görünmez olunca fotoğraf biter.
    await s.call('invisible_set', { op_id: uuidV4(), invisible: true }, DEMO_ME);
    expect(await codeOf(proofGet(s, DEMO_ME, DEMO_ME, p2.proof.proof_id))).toBe('proof_expired');
    expect(s.snapshot().f9.proofObjects).toBe(0);
    expect(await codeOf(proofCreate(s))).toBe('invisible_mode');
  });

  it('1 saat sonra sunucu siler; bot fotoğrafı pakete photo_id + photo_exp olarak gider, süre dolunca düşer', async () => {
    const s = await server();
    const r = s.botProof(AYSE, 'Mekana geçtim, masamız burası', null);
    expect(r.ok).toBe(true);
    const id = r.ok ? r.proof_id : '';
    const live = s.inboxOf(DEMO_ME)[`${AYSE}_${DEMO_ME}`] as Record<string, unknown>;
    expect(live).toMatchObject({ photo_id: id, note: expect.stringContaining('Mekana geçtim, masamız burası') });
    expect(typeof live.photo_exp).toBe('number');
    expect((await proofGet(s, DEMO_ME, AYSE, id)).proof.proof_id).toBe(id);
    expect(s.snapshot().f9.ayseProof?.caption).toBe('Mekana geçtim, masamız burası');

    expect(s.fastForwardProofs()).toBe(1);
    expect(await codeOf(proofGet(s, DEMO_ME, AYSE, id))).toBe('proof_expired');
    expect(s.snapshot().f9).toMatchObject({ ayseProof: null, proofObjects: 0 });
    expect(s.inboxOf(DEMO_ME)[`${AYSE}_${DEMO_ME}`]).not.toHaveProperty('photo_id');
  });

  it('RTDB kuralı: photo_id ile photo_exp birlikte; dest_eta yalnızca near', async () => {
    const s = await server();
    const { session_id } = await shareTo(s, [AYSE]);
    const id = `${DEMO_ME}_${AYSE}`;
    const sh = s.sharesWhere('sender_id', DEMO_ME).find((x) => x.share_id === id);
    const base = {
      v: 1,
      share_id: id,
      sender_id: DEMO_ME,
      lat: 40.98,
      lng: 29.02,
      accuracy: 10,
      activity_state: 'walking',
      timestamp: Date.now(),
      share_mode: sh?.share_mode,
      expires_at: sh?.expires_at,
      server_ts: SERVER_TIMESTAMP,
    };
    const write = (extra: Record<string, unknown>) => codeOf(s.applyFanout({ [`live_locations/${AYSE}/${id}`]: { ...base, ...extra } }, DEMO_ME));
    expect(session_id).toBeTruthy();
    expect(await write({ photo_id: 'abcdefghijklmnopqrst' })).toBe('database/permission-denied');
    expect(await write({ photo_id: 'abcdefghijklmnopqrst', photo_exp: Date.now() + 2 * 60 * 60_000 })).toBe('database/permission-denied');
    expect(await write({ photo_id: 'abcdefghijklmnopqrst', photo_exp: Date.now() + 30 * 60_000 })).toBe('ok');
    expect(await write({ dest_name: 'Ev', dest_state: 'en_route', dest_eta: 3 })).toBe('database/permission-denied');
    expect(await write({ dest_name: 'Ev', dest_state: 'near', dest_eta: 1 })).toBe('ok');
  });
});

describe('demo Faz 9: Neredeyse vardım (200 m)', () => {
  it('oturum + hedef başına tek bildirim; alıcılar etkin paylaşım alıcıları', async () => {
    const s = await server();
    const ayse = pushes(s, AYSE);
    const { session_id } = await shareTo(s, [AYSE]);
    const report = () =>
      s.call(
        'approach_report',
        { op_id: uuidV4(), session_ids: [session_id], dest_key: '0123456789abcdef', dest_name: 'Ev', dest_kind: 'zone', distance_m: 180, eta_min: 1, at: Date.now() },
        DEMO_ME,
      ) as Promise<{ status: string; notified_count: number }>;
    expect(await report()).toMatchObject({ status: 'sent', notified_count: 1 });
    expect(await report()).toMatchObject({ status: 'already_sent', notified_count: 0 });
    await wait(800);
    expect(ayse.filter((m) => m.data.type === 'approach')).toHaveLength(1);
    expect(ayse[0]?.data).toMatchObject({ type: 'approach', from: DEMO_ME, dest_name: 'Ev', eta_min: '1' });
    expect(ayse[0]?.notification?.title).toContain('Neredeyse vardım (1 dk)');
    expect(s.snapshot().f9.lastApproach).toMatchObject({ status: 'already_sent', dest_name: 'Ev' });
    // Eski rapor `stale`.
    const stale = (await s.call(
      'approach_report',
      { op_id: uuidV4(), session_ids: [session_id], dest_key: 'fedcba9876543210', dest_name: 'İş', dest_kind: 'zone', distance_m: 150, eta_min: 2, at: Date.now() - 5 * 60_000 },
      DEMO_ME,
    )) as { status: string };
    expect(stale.status).toBe('stale');
  });

  it('bot: Ayşe hedefe yaklaşınca bana push + paket dest_state near; ikinci basışta vardı, bildirim tekrar gitmez', async () => {
    const s = await server();
    const me = pushes(s, DEMO_ME);
    expect(s.botApproach(AYSE)).toMatchObject({ status: 'sent', notified: 1, dest_state: 'near' });
    expect(s.inboxOf(DEMO_ME)[`${AYSE}_${DEMO_ME}`]).toMatchObject({ dest_name: 'Kitap Kafe', dest_state: 'near', dest_eta: 1 });
    expect(s.botApproach(AYSE)).toMatchObject({ status: 'already_sent', dest_state: 'arrived' });
    const live = s.inboxOf(DEMO_ME)[`${AYSE}_${DEMO_ME}`] as Record<string, unknown>;
    expect(live.dest_state).toBe('arrived');
    expect(live).not.toHaveProperty('dest_eta');
    await wait(800);
    expect(me.filter((m) => m.data.type === 'approach')).toHaveLength(1);
  });
});

describe('demo Faz 9: Güvenli Dönüş', () => {
  it('başlat → son uyarı (sahibe push) → sunucu alarmı (SOS origin safe_return, son konum + pil)', async () => {
    const t = fakeClock(Date.now());
    const s = await server();
    expect(await codeOf(srStart(s, [AYSE]))).toBe('no_emergency_contacts');
    await s.call('emergency_contacts_set', { op_id: uuidV4(), contact_ids: [AYSE] }, DEMO_ME);
    const me = pushes(s, DEMO_ME);
    const ayse = pushes(s, AYSE);
    const started = await srStart(s, [AYSE, CAN]);
    // Can'a `sos_alert` iznim yok ve acil kişim değil: sessizce düşer.
    expect(started.safe_return.contact_ids).toEqual([AYSE]);
    expect(started.notified_count).toBe(1);
    expect(await codeOf(srStart(s, [AYSE]))).toBe('safe_return_active');
    const id = started.safe_return.safe_return_id;
    expect(s.safeReturnsOf(DEMO_ME).map((d) => d.status)).toEqual(['active']);
    expect(s.safeReturnsOf(AYSE)).toEqual([]);
    // Konum tazeleme: 60 sn'den sık → rate_limited.
    expect(await codeOf(s.call('safe_return_update', { op_id: uuidV4(), safe_return_id: id, fix: fix({ timestamp: Date.now() + 10_000 }) }, DEMO_ME))).toBe('rate_limited');
    t.advance(61_000);
    await s.call('safe_return_update', { op_id: uuidV4(), safe_return_id: id, fix: fix({ lat: 40.99, timestamp: Date.now(), battery_pct: 19 }) }, DEMO_ME);

    t.advance(15 * 60_000);
    sweep(s);
    expect(s.safeReturnsOf(DEMO_ME)[0]?.due_notified_at).not.toBeNull();
    t.advance(SAFE_RETURN_LIMITS.graceMs + 1_000);
    sweep(s);
    const doc = s.safeReturnsOf(DEMO_ME)[0] as SafeReturnDoc;
    expect(doc.status).toBe('alarm');
    expect(doc.sos_id).toBeTruthy();
    const sos = s.sosAlertsWhere('recipient_ids', AYSE).find((a) => a.sos_id === doc.sos_id) as SosAlert;
    expect(sos).toMatchObject({ origin: 'safe_return', status: 'active', battery_pct: 19, location: { lat: 40.99 } });
    expect(sos.safe_return).toMatchObject({ safe_return_id: id, destination_name: 'Ev', duration_min: 15 });
    expect(sos.message).toContain('Güvenli Dönüş');
    // Tik iki kez çalışsa da tek alarm.
    sweep(s);
    expect(s.sosAlertsWhere('sender_id', DEMO_ME)).toHaveLength(1);
    // Alarmdan sonra check-in yok (SOS'taki "Güvendeyim" kapatır).
    expect(await codeOf(s.call('safe_return_check_in', { op_id: uuidV4(), safe_return_id: id, reason: 'safe' }, DEMO_ME))).toBe('safe_return_not_active');

    await wait(800);
    expect(ayse.map((m) => m.data.type)).toEqual(['safe_return_started', 'sos']);
    expect(ayse[1]?.data).toMatchObject({ origin: 'safe_return', sender_id: DEMO_ME });
    expect(ayse[1]?.notification?.title).toContain("Güvenli Dönüş'te yanıt vermedi");
    expect(me.filter((m) => m.data.type === 'safe_return_due')).toHaveLength(1);
  });

  it('check-in kişilere "güvende" push\'u; onay geri çekme etkin zamanlayıcıyı iptal eder', async () => {
    const s = await server();
    await s.call('emergency_contacts_set', { op_id: uuidV4(), contact_ids: [AYSE] }, DEMO_ME);
    const ayse = pushes(s, AYSE);
    const a = await srStart(s, [AYSE]);
    const ext = (await s.call('safe_return_extend', { op_id: uuidV4(), safe_return_id: a.safe_return.safe_return_id }, DEMO_ME)) as { safe_return: SafeReturnDoc };
    expect(ext.safe_return.due_at).toBe(a.safe_return.due_at + SAFE_RETURN_LIMITS.extendMs);
    await s.call('safe_return_check_in', { op_id: uuidV4(), safe_return_id: a.safe_return.safe_return_id, reason: 'arrived' }, DEMO_ME);
    expect(s.safeReturnsOf(DEMO_ME)[0]?.status).toBe('arrived');

    const b = await srStart(s, [AYSE]);
    await s.call('consent_withdraw', { op_id: uuidV4() }, DEMO_ME);
    expect(s.safeReturnsOf(DEMO_ME).find((d) => d.safe_return_id === b.safe_return.safe_return_id)?.status).toBe('cancelled');
    await wait(800);
    expect(ayse.filter((m) => m.data.type === 'safe_return_ended').map((m) => m.data.reason)).toEqual(['arrived', 'cancelled']);
  });

  it('bot: Ayşe başlatır ve yanıt vermez → bana SOS (origin safe_return)', async () => {
    const t = fakeClock(Date.now());
    const s = await server();
    const me = pushes(s, DEMO_ME);
    expect(s.botSafeReturnStart(AYSE)).toEqual({ ok: true, alarm_in_s: 40 });
    t.advance(21_000);
    sweep(s);
    expect(s.snapshot().f9.ayseSafeReturn?.status).toBe('active');
    t.advance(20_000);
    sweep(s);
    expect(s.snapshot().f9.ayseSafeReturn?.status).toBe('alarm');
    const sos = s.sosAlertsWhere('recipient_ids', DEMO_ME).find((a) => a.sender_id === AYSE && a.status === 'active');
    expect(sos).toMatchObject({ origin: 'safe_return', battery_pct: 31 });
    await wait(800);
    expect(me.map((m) => m.data.type).sort()).toEqual(['safe_return_started', 'sos']);
  });
});
