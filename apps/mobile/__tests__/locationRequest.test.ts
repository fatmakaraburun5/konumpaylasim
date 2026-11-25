/**
 * Konum İste: demo sunucusu (backend `handlers/requests.ts` ile aynı anlam), istemci deposu ve push ayrıştırma.
 */
import { LOCATION_REQUEST_NOTIFICATION, requestId, uuidV4 } from '@konum/core';
import { DemoServer, type DemoPushMessage } from '../src/demo/server/server';
import { DEMO_ME, PEOPLE } from '../src/demo/server/world';
import { actionOf, locationRequestLocalContent, parseLocationRequestData } from '../src/services/notifications/locationRequestPush';
import { createLocationRequestStore, selectIncomingRequests, selectOutgoingState } from '../src/state/locationRequestStore';
import { acceptConsent } from './demoTestUtils';

jest.setTimeout(30_000);

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
const sweep = (s: DemoServer) => (s as unknown as { sweep: () => void }).sweep();
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { details?: { code?: string }; code?: string }).details?.code ?? (e as { code?: string }).code ?? String(e);
  }
};
const CAN = PEOPLE.can.uid;
const MEHMET = PEOPLE.mehmet.uid;
const ZEYNEP = PEOPLE.zeynep.uid;
const send = (s: DemoServer, target: string, uid = DEMO_ME) => s.call('location_request_send', { op_id: uuidV4(), target_id: target }, uid) as Promise<{ request_id: string; status: string; expires_at: number | null }>;

describe('demo: Konum İste', () => {
  it('istek → bekleyen, tekrar aynı istek; geri çekince 10 dk bekleme; bot Can 1 saat onaylar ve izin hedef → isteyen yazılır', async () => {
    const s = await server();
    const r1 = await send(s, CAN);
    expect(r1.status).toBe('pending');
    expect((await send(s, CAN)).expires_at).toBe(r1.expires_at);
    await s.call('location_request_cancel', { op_id: uuidV4(), request_id: r1.request_id }, DEMO_ME);
    expect(s.locationRequestsOf(DEMO_ME).find((r) => r.request_id === r1.request_id)?.status).toBe('cancelled');
    expect(await codeOf(send(s, CAN))).toBe('rate_limited');

    // Yeni istek (bekleme atlanır) → bot 6 sn sonra onaylar.
    let t = Date.now() + 11 * 60_000;
    clock = jest.spyOn(Date, 'now').mockImplementation(() => t);
    const r2 = await send(s, CAN);
    expect(r2.status).toBe('pending');
    t += 7_000;
    sweep(s);
    const doc = s.locationRequestsOf(DEMO_ME).find((r) => r.request_id === r2.request_id);
    expect(doc).toMatchObject({ status: 'approved', share_id: expect.any(String) });
    expect(s.isSharingWithMe(CAN)).toBe(true);
    const g = s.grantsOf(DEMO_ME).find((d) => d.granter_id === CAN && d.grantee_id === DEMO_ME);
    expect(g?.scopes.location_view).toBeTruthy();
    // Ters yön yok: benim Can'a iznim açılmaz.
    expect(s.grantsOf(DEMO_ME).find((d) => d.granter_id === DEMO_ME && d.grantee_id === CAN)?.scopes.location_view ?? null).toBeFalsy();
    // Paylaşırken yeni istek oluşmaz.
    expect((await send(s, CAN)).status).toBe('already_sharing');
  });

  it('Zeynep reddeder: isteyene sade "şu an paylaşamıyor" push\'u', async () => {
    const s = await server();
    const pushes: DemoPushMessage[] = [];
    s.subscribePush(DEMO_ME, (m) => pushes.push(m));
    // Zeynep bana paylaşıyorsa önce bitir.
    const zs = s.sharesWhere('sender_id', ZEYNEP).find((x) => x.receiver_id === DEMO_ME && x.status === 'active');
    if (zs) await s.call('share_revoke', { op_id: uuidV4(), sender_id: ZEYNEP }, DEMO_ME);
    let t = Date.now();
    clock = jest.spyOn(Date, 'now').mockImplementation(() => t);
    const r = await send(s, ZEYNEP);
    t += 7_000;
    sweep(s);
    expect(s.locationRequestsOf(DEMO_ME).find((x) => x.request_id === r.request_id)?.status).toBe('rejected');
    clock.mockRestore();
    clock = null;
    await new Promise((res) => setTimeout(res, 800));
    const ans = pushes.find((p) => p.data?.type === 'location_request_answered');
    expect(ans?.notification?.body).toMatch(/şu an konumunu paylaşamıyor/);
    expect(JSON.stringify(ans)).not.toMatch(/lat|lng/);
  });

  it('Mehmet benden ister: görünmezken onay invisible_mode, ret çalışır; görünürken onay süre seçimiyle paylaşım başlatır', async () => {
    const s = await server();
    expect(s.friendRequestsMyLocation('mehmet')).toBe(true);
    const id = requestId(MEHMET, DEMO_ME);
    await s.call('invisible_set', { op_id: uuidV4(), invisible: true }, DEMO_ME);
    const approve = (preset: string) =>
      s.call('location_request_respond', { op_id: uuidV4(), request_id: id, accept: true, duration: { kind: 'preset', preset }, time_zone: 'Europe/Istanbul' }, DEMO_ME) as Promise<{
        status: string;
        share: { receiver_id: string; expires_at: number; started_at: number } | null;
      }>;
    expect(await codeOf(approve('m15'))).toBe('invisible_mode');
    await s.call('invisible_set', { op_id: uuidV4(), invisible: false, restore_receiver_ids: [] }, DEMO_ME);
    const ok = await approve('m15');
    expect(ok.status).toBe('approved');
    expect(ok.share).toMatchObject({ receiver_id: MEHMET });
    expect((ok.share?.expires_at ?? 0) - (ok.share?.started_at ?? 0)).toBe(15 * 60_000);
    // İkinci yanıt reddedilir (artık bekleyen değil).
    expect(await codeOf(approve('h1'))).toBe('invalid_argument');

    // Yeni istek → ret.
    expect(s.friendRequestsMyLocation('can')).toBe(true);
    const no = (await s.call('location_request_respond', { op_id: uuidV4(), request_id: requestId(CAN, DEMO_ME), accept: false }, DEMO_ME)) as { status: string };
    expect(no.status).toBe('rejected');
  });
});

describe('istemci deposu', () => {
  const api = {
    locationRequestSend: jest.fn(async () => ({ request_id: 'me_can', status: 'pending' as const, expires_at: 1_000 + 15 * 60_000, server_now: 1_000 })),
    locationRequestRespond: jest.fn(async () => ({ request_id: 'mehmet_me', status: 'approved' as const, session_id: 's1', share: { share_id: 'x' } as never, server_now: 1_000 })),
    locationRequestCancel: jest.fn(async () => ({ status: 'cancelled' as const, server_now: 1_000 })),
  };
  it('gönderim yerel bekleyen belge; onay paylaşımı kitapçığa verir; yanıtlanan istek karttan düşer', async () => {
    const started = jest.fn();
    const st = createLocationRequestStore({ api: api as never, now: () => 2_000, newOpId: () => 'op', timeZone: () => 'Europe/Istanbul', onShareStarted: started, sharingWithMe: () => false });
    st.getState().setSnapshot('me', [
      { request_id: 'mehmet_me', requester_id: 'mehmet', target_id: 'me', status: 'pending', created_at: 1_000, expires_at: 1_000 + 15 * 60_000, responded_at: null, share_id: null },
    ]);
    expect(selectIncomingRequests(st.getState(), 2_000).map((r) => r.request_id)).toEqual(['mehmet_me']);
    await st.getState().send('can');
    expect(selectOutgoingState(st.getState(), 'can', 2_000, false)).toMatchObject({ kind: 'pending' });
    expect(selectOutgoingState(st.getState(), 'can', 2_000, true)).toEqual({ kind: 'sharing' });
    st.getState().openApprove('mehmet_me');
    await st.getState().approve('mehmet_me', { kind: 'preset', preset: 'h1' });
    expect(started).toHaveBeenCalledWith('s1', [{ share_id: 'x' }]);
    expect(st.getState().approving).toBeNull();
    expect(selectIncomingRequests(st.getState(), 2_000)).toEqual([]);
  });
});

describe('push', () => {
  it('gelen istek Onayla/Reddet kategorisiyle; yanıt kategorisiz; eylem kimlikleri', () => {
    const c = locationRequestLocalContent({ data: { type: 'location_request', request_id: 'can_me', from: 'can', title: 'Konum isteği', body: 'Can konumunu paylaşmanı istiyor' } }, () => null);
    expect(c).toMatchObject({ title: 'Konum isteği', categoryIdentifier: LOCATION_REQUEST_NOTIFICATION.category, channelId: 'location_requests' });
    const a = locationRequestLocalContent({ data: { type: 'location_request_answered', request_id: 'me_can', by: 'can', status: 'rejected' } }, () => 'Can');
    expect(a).toMatchObject({ body: 'Can şu an konumunu paylaşamıyor', categoryIdentifier: null });
    expect(parseLocationRequestData({ type: 'location_request', request_id: '../x', from: 'can' })).toBeNull();
    expect(actionOf(LOCATION_REQUEST_NOTIFICATION.approveAction)).toBe('approve');
    expect(actionOf(LOCATION_REQUEST_NOTIFICATION.rejectAction)).toBe('reject');
    expect(actionOf(undefined)).toBe('open');
  });
});
