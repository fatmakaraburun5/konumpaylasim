/**
 * Faz 4 mobil veri katmanı (odaklı): SOS gönderimi (kişi yok → ağa çıkmadan hata; `unavailable` → aynı op_id ile
 * yeniden deneme), ping soğuması, durum notu kalıcılığı ve demo sunucusunun SOS / not sözleşmesi.
 */
import { MINUTE, SERVER_TIMESTAMP, uuidV4, type SosAlert, type SosSendRequest } from '@konum/core';
import { DemoServer, type DemoPushMessage } from '../src/demo/server/server';
import { DEMO_ME, PEOPLE } from '../src/demo/server/world';
import { KonumError } from '../src/lib/errors';
import { createNotesStore, onStatusChange } from '../src/state/notesStore';
import { createPingStore } from '../src/state/pingStore';
import { createSosStore } from '../src/state/sosStore';

const NOW = 1_800_000_000_000;
const LOC = { lat: 40.9862, lng: 29.0275, accuracy: 8, timestamp: NOW - 2_000 };

const alertFrom = (req: SosSendRequest, id = 'sos1'): SosAlert => ({
  sos_id: id,
  sender_id: 'me',
  sender_name: 'Deniz',
  recipient_ids: ['ayse'],
  status: 'active',
  resolve_reason: null,
  message: 'x',
  location: req.location,
  address: req.address ?? null,
  maps_url: 'https://maps',
  battery_pct: req.battery_pct ?? null,
  is_charging: req.is_charging ?? null,
  route: null,
  created_at: NOW,
  updated_at: NOW,
  resolved_at: null,
  acks: {},
  update_count: 0,
});

function sosDeps(sosSend: jest.Mock) {
  return {
    api: { sosSend, emergencyContactsSet: jest.fn(), sosUpdate: jest.fn(), sosResolve: jest.fn(), sosAck: jest.fn() },
    now: () => NOW,
    myUid: () => 'me',
    getFix: async () => LOC,
    lastKnown: () => null,
    ensurePermission: async () => true,
    device: async () => ({ batteryLevel: 0.23, isCharging: false }),
    address: async () => 'Moda Cd., Kadıköy',
    autoShare: async () => undefined,
    sleep: async () => undefined,
  };
}

describe('sosStore.send', () => {
  it('acil kişi listesi yüklendi ve boşsa ağa çıkmadan no_emergency_contacts döner', async () => {
    const sosSend = jest.fn();
    const store = createSosStore(sosDeps(sosSend));
    store.getState().setContactsFromProfile([]);
    const r = await store.getState().send();
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'no_emergency_contacts' }) });
    expect(sosSend).not.toHaveBeenCalled();
    expect(store.getState().phase).toBe('idle');
  });

  it('liste henüz yüklenmediyse karar sunucuda (açılışta hemen SOS seçim ekranına takılmaz)', async () => {
    const sosSend = jest.fn().mockRejectedValueOnce(new KonumError('no_emergency_contacts'));
    const store = createSosStore(sosDeps(sosSend));
    expect(store.getState().contactsLoaded).toBe(false);
    const r = await store.getState().send();
    expect(sosSend).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'no_emergency_contacts' }) });
    expect(store.getState().contactsLoaded).toBe(true);
  });

  it('unavailable → aynı op_id ile yeniden dener; tam konum, pil ve adres pakette', async () => {
    const sosSend = jest
      .fn()
      .mockRejectedValueOnce(new KonumError('unavailable'))
      .mockImplementationOnce(async (req: SosSendRequest) => ({ sos: alertFrom(req), recipients: 1, server_now: NOW }));
    const store = createSosStore(sosDeps(sosSend));
    store.getState().setContactsFromProfile(['ayse']);
    const r = await store.getState().send();
    expect(r).toEqual({ ok: true, sos_id: 'sos1' });
    expect(sosSend).toHaveBeenCalledTimes(2);
    const [a, b] = sosSend.mock.calls.map((c) => c[0] as SosSendRequest);
    expect(a?.op_id).toBe(b?.op_id);
    expect(a).toMatchObject({ location: LOC, battery_pct: 23, is_charging: false, address: 'Moda Cd., Kadıköy' });
    expect(store.getState().phase).toBe('active');
    expect(store.getState().outgoing?.sos_id).toBe('sos1');
  });
});

describe('pingStore.send', () => {
  it('soğuma süresinde ikinci ping ağa çıkmaz (rate_limited)', async () => {
    let t = NOW;
    const pingSend = jest.fn(async () => ({ ping_id: 'p1', expires_at: t + 15 * MINUTE, server_now: t }));
    const store = createPingStore({ api: { pingSend }, now: () => t, myLocation: () => ({ ...LOC, timestamp: t - 1_000 }), myUid: () => 'me' });
    expect(await store.getState().send('ayse', 'here')).toEqual({ ok: true });
    expect(pingSend.mock.calls[0]).toEqual([expect.objectContaining({ to: 'ayse', kind: 'here', location: expect.objectContaining({ lat: LOC.lat }) })]);
    const second = await store.getState().send('ayse', 'here');
    expect(second).toEqual({ ok: false, error: expect.objectContaining({ code: 'rate_limited' }) });
    expect(pingSend).toHaveBeenCalledTimes(1);
    t += 21_000;
    expect(await store.getState().send('ayse', 'on_way', { eta_s: 600 })).toEqual({ ok: true });
    expect(pingSend).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'on_way', eta_s: 600 }));
  });

  it('yeni gelen ping göndereni vurgular, süresi geçen budanır', () => {
    let t = NOW;
    const store = createPingStore({ now: () => t, myUid: () => 'me', deleteRemote: async () => undefined });
    store.getState().upsertIncoming({ ping_id: 'p1', from: 'ayse', kind: 'here', sent_at: t, expires_at: t + 15 * MINUTE, location: null, eta_s: null });
    expect(store.getState().highlight).toMatchObject({ from: 'ayse', kind: 'here' });
    t += 16 * MINUTE;
    store.getState().tick();
    expect(store.getState().inbox).toEqual({});
    expect(store.getState().highlight).toBeNull();
  });
});

describe('notesStore durum notu', () => {
  it('kaydedilir ve değişiklik dinleyicisi (anında yayın) tetiklenir', async () => {
    const saved: unknown[] = [];
    const store = createNotesStore({ now: () => NOW, myUid: () => 'me', saveStatus: async (v) => void saved.push(v), loadStatus: async () => null });
    const heard = new Promise((r) => {
      const un = onStatusChange((n) => {
        un();
        r(n);
      });
    });
    store.getState().setMyStatus({ emoji: '☕', text: '  Kahve   molasındayım ', duration_ms: 30 * MINUTE });
    expect(await heard).toEqual({ emoji: '☕', text: 'Kahve molasındayım', expires_at: NOW + 30 * MINUTE });
    expect(saved).toEqual([{ uid: 'me', note: { emoji: '☕', text: 'Kahve molasındayım', expires_at: NOW + 30 * MINUTE } }]);
  });
});

describe('demo sunucusu (Faz 4)', () => {
  const servers: DemoServer[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.reset()));

  it('SOS: kişi yok → no_emergency_contacts; kişi seçilince alıcıya push + ack', async () => {
    const s = new DemoServer();
    servers.push(s);
    const req = { op_id: uuidV4(), location: { lat: 40.9862, lng: 29.0275, accuracy: 7, timestamp: Date.now() }, battery_pct: 40 };
    await expect(s.call('sos_send', req, DEMO_ME)).rejects.toMatchObject({ details: { code: 'no_emergency_contacts' } });
    const set = (await s.call('emergency_contacts_set', { op_id: uuidV4(), contact_ids: [PEOPLE.ayse.uid, 'yabanci'] }, DEMO_ME)) as { contact_ids: string[] };
    expect(set.contact_ids).toEqual([PEOPLE.ayse.uid]);
    const pushes: DemoPushMessage[] = [];
    s.subscribePush(PEOPLE.ayse.uid, (m) => pushes.push(m));
    const r = (await s.call('sos_send', { ...req, op_id: uuidV4() }, DEMO_ME)) as { sos: SosAlert; recipients: number };
    expect(r.recipients).toBe(1);
    expect(r.sos.maps_url).toContain('40.986200');
    expect(r.sos.address).not.toBeUndefined();
    await new Promise((res) => setTimeout(res, 800));
    expect(pushes[0]?.data).toEqual({ type: 'sos', sos_id: r.sos.sos_id, sender_id: DEMO_ME });
    const acked = (await s.call('sos_ack', { op_id: uuidV4(), sos_id: r.sos.sos_id }, PEOPLE.ayse.uid)) as { sos: SosAlert };
    expect(acked.sos.acks[PEOPLE.ayse.uid]).toBeGreaterThan(0);
    // Aktif SOS varken yeni gönderim aynı belgeyi günceller.
    const again = (await s.call('sos_send', { ...req, op_id: uuidV4() }, DEMO_ME)) as { sos: SosAlert };
    expect(again.sos.sos_id).toBe(r.sos.sos_id);
  });

  it('canlı pakette durum notu note + note_exp birlikte kabul edilir, tek başına reddedilir', async () => {
    const s = new DemoServer();
    servers.push(s);
    const start = (await s.call(
      'share_start',
      { op_id: uuidV4(), receiver_ids: [PEOPLE.ayse.uid], duration: { kind: 'preset', preset: 'h1' }, time_zone: 'Europe/Istanbul' },
      DEMO_ME,
    )) as { shares: { share_id: string; expires_at: number }[] };
    const share = start.shares[0];
    if (!share) throw new Error('paylaşım yok');
    const base = {
      v: 1,
      share_id: share.share_id,
      sender_id: DEMO_ME,
      lat: 40.98,
      lng: 29.02,
      accuracy: 9,
      activity_state: 'still',
      timestamp: Date.now(),
      share_mode: 'timed',
      expires_at: share.expires_at,
      server_ts: SERVER_TIMESTAMP,
    };
    const path = `live_locations/${PEOPLE.ayse.uid}/${share.share_id}`;
    await expect(s.applyFanout({ [path]: { ...base, note: '☕ Kahve molasındayım' } }, DEMO_ME)).rejects.toThrow(/note/);
    await s.applyFanout({ [path]: { ...base, note: '☕ Kahve molasındayım', note_exp: Date.now() + MINUTE } }, DEMO_ME);
    expect(s.inboxOf(PEOPLE.ayse.uid)[share.share_id]?.note).toBe('☕ Kahve molasındayım');
  });
});
