/**
 * Bağlantı (QR) deposu: oluştur → yayın hedefi (yalnızca sunucu onaylı), durdur → anında kesilir +
 * kalıcı niyet + aynı op_id ile yeniden deneme, süreç yeniden başlayınca da engel sürer, uzatma,
 * süre dolumu ve "bitmek üzere" evresi. Kasa bellek içi; AsyncStorage sahte.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  HOUR,
  linkTokenHash,
  MINUTE,
  type LinkShareCreateResponse,
  type LinkShareStopResponse,
  type LinkShareUpdateResponse,
  type LinkShareView,
} from '@konum/core';
import type { LinkApi } from '../src/services/firebase/callables';
import { createMemoryLinkTokenVault } from '../src/services/security/linkTokenVault';
import { createLinkStore, selectLinkSessions, selectLinkTargets } from '../src/state/linkStore';
import {
  __resetLinkStopsMemoryForTests,
  bindLinkStopsOwner,
  isLinkBlocked,
  listLinkStops,
  reconcileLinkStops,
} from '../src/state/linkStops';

const NOW = Date.UTC(2026, 10, 23, 11, 0, 0);
const TOKEN = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const HASH = linkTokenHash(TOKEN);
const URL = `https://konum.example.com/s/${TOKEN}`;

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const view = (over: Partial<LinkShareView> = {}): LinkShareView => ({
  link_id: 'lnk1',
  session_id: 'ls1',
  token_hash: HASH,
  status: 'active',
  share_mode: 'timed',
  started_at: NOW,
  expires_at: NOW + HOUR,
  end_reason: null,
  version: 1,
  extended_count: 0,
  ...over,
});

const created: { dispose: () => void }[] = [];

function setup(opPrefix = '0') {
  let clock = NOW;
  let op = 0;
  const create = deferred<LinkShareCreateResponse>();
  const stop = deferred<LinkShareStopResponse>();
  const extend = deferred<LinkShareUpdateResponse>();
  const api = {
    linkShareCreate: jest.fn((_req: unknown) => create.promise),
    linkShareStop: jest.fn((_req: unknown) => stop.promise),
    linkShareExtend: jest.fn((_req: unknown) => extend.promise),
  };
  const vault = createMemoryLinkTokenVault();
  const store = createLinkStore({
    api: api as unknown as LinkApi,
    vault,
    now: () => clock,
    newOpId: () => `${opPrefix.repeat(8)}-0000-4000-8000-00000000000${++op}`,
    timeZone: () => 'Europe/Istanbul',
    tickMs: 1_000,
    stopRetryBackoffMs: [60_000],
  });
  created.push(store.getState());
  const sessions = () => selectLinkSessions(store.getState());
  const targets = () => selectLinkTargets(store.getState(), 'Ayşe Yılmaz');
  const setClock = (t: number) => {
    clock = t;
    store.setState({ now: t });
  };
  return { store, api, vault, create, stop, extend, sessions, targets, setClock };
}

const unavailable = { code: 'functions/unavailable', message: 'network error' };

describe('linkStore', () => {
  beforeEach(async () => {
    __resetLinkStopsMemoryForTests();
    await AsyncStorage.clear();
  });
  afterEach(() => {
    created.splice(0).forEach((s) => s.dispose());
    jest.useRealTimers();
  });

  it('oluştur: callable (op_id + saat dilimi), URL kasaya, sunucu onaylı bağlantı yayın hedefi olur', async () => {
    const t = setup();
    const p = t.store.getState().create({ kind: 'preset', preset: 'h1' });
    expect(t.store.getState().create({ kind: 'preset', preset: 'h1' })).toBe(p); // çift dokunma
    expect(t.api.linkShareCreate).toHaveBeenCalledWith({
      op_id: '00000000-0000-4000-8000-000000000001',
      duration: { kind: 'preset', preset: 'h1' },
      time_zone: 'Europe/Istanbul',
    });
    expect(t.targets()).toEqual([]);
    t.create.resolve({ ...view(), token: TOKEN, url: URL, server_now: NOW });
    await expect(p).resolves.toEqual({ ok: true, linkId: 'lnk1', url: URL });

    expect(t.vault.dump()).toEqual({ lnk1: URL });
    expect(t.sessions()).toMatchObject([{ link_id: 'lnk1', phase: 'active', url: URL, prompt_at: NOW + HOUR - 12 * MINUTE }]);
    expect(t.targets()).toEqual([{ link_id: 'lnk1', token_hash: HASH, share_mode: 'timed', expires_at: NOW + HOUR, sender_name: 'Ayşe Yılmaz' }]);
    // Token yayın hedefine ve görünüme girmez (yalnızca özet).
    expect(JSON.stringify(t.targets())).not.toContain(TOKEN);
  });

  it('yanıtı kaybolan oluşturma aynı seçimle yeniden denenirse AYNI op_id gider (yetim bağlantı yok)', async () => {
    const t = setup('8');
    t.api.linkShareCreate.mockImplementationOnce(() => Promise.reject(unavailable));
    const first = await t.store.getState().create({ kind: 'preset', preset: 'h1' });
    expect(first.ok).toBe(false);
    t.api.linkShareCreate.mockImplementationOnce(() => Promise.resolve({ ...view({ version: 2 }), token: TOKEN, url: URL, server_now: NOW }));
    await expect(t.store.getState().create({ kind: 'preset', preset: 'h1' })).resolves.toMatchObject({ ok: true, linkId: 'lnk1' });
    const ops = t.api.linkShareCreate.mock.calls.map((c) => (c[0] as { op_id: string }).op_id);
    expect(ops[1]).toBe(ops[0]);
    // Başarıdan sonra (ya da başka süre seçilince) yeni op_id.
    t.api.linkShareCreate.mockImplementationOnce(() => Promise.reject(unavailable)).mockImplementationOnce(() => Promise.reject(unavailable));
    await t.store.getState().create({ kind: 'preset', preset: 'm15' });
    await t.store.getState().create({ kind: 'preset', preset: 'h8' });
    const after = t.api.linkShareCreate.mock.calls.map((c) => (c[0] as { op_id: string }).op_id);
    expect(new Set(after).size).toBe(3);
  });

  it('geçersiz süre ağa çıkmaz', async () => {
    const t = setup();
    const r = await t.store.getState().create({ kind: 'custom_duration', minutes: 1 } as never);
    expect(r.ok).toBe(false);
    expect(t.api.linkShareCreate).not.toHaveBeenCalled();
  });

  it('durdur: yayın sunucu yanıtı beklenmeden kesilir; niyet diske yazıldıktan sonra callable gider; başarıda URL silinir', async () => {
    const t = setup('1');
    t.store.getState().applyServerLinks([view()]);
    await t.vault.save('lnk1', URL);
    expect(t.targets()).toHaveLength(1);

    const sp = t.store.getState().stop('lnk1');
    void t.store.getState().stop('lnk1');
    expect(t.targets()).toEqual([]);
    expect(isLinkBlocked('lnk1')).toBe(true);
    expect(t.sessions()[0]!.phase).toBe('stopping');
    await flush();
    expect(t.api.linkShareStop).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await AsyncStorage.getItem('konum.bg.linkstops.v1'))!).intents).toMatchObject([{ link_id: 'lnk1', version: 1 }]);

    t.stop.resolve({ ...view({ status: 'ended', end_reason: 'stopped_by_sender', version: 2 }), server_now: NOW });
    await expect(sp).resolves.toBe(true);
    expect(t.sessions()[0]).toMatchObject({ phase: 'ended', end_reason: 'stopped_by_sender', url: null });
    expect(listLinkStops()).toEqual([]);
    expect(isLinkBlocked('lnk1')).toBe(false);
    expect(t.vault.dump()).toEqual({});
    // Geç gelen eski anlık görüntü (hâlâ aktif, v1) bağlantıyı geri getirmez.
    t.store.getState().applyServerLinks([view()]);
    expect(t.targets()).toEqual([]);
  });

  it('durdurma başarısız + süreç yeniden başlar: engel sürer, link_share_stop aynı op_id ile yeniden gider', async () => {
    const t1 = setup('2');
    t1.store.getState().applyServerLinks([view()]);
    const sp = t1.store.getState().stop('lnk1');
    await flush();
    const op = (t1.api.linkShareStop.mock.calls[0]![0] as { op_id: string }).op_id;
    t1.stop.reject(unavailable);
    await expect(sp).resolves.toBe(false);
    expect(t1.sessions()[0]).toMatchObject({ phase: 'stopping', error: { code: 'unavailable' } });
    t1.store.getState().dispose();

    __resetLinkStopsMemoryForTests();
    expect(isLinkBlocked('lnk1')).toBe(false);
    const t2 = setup('3');
    const intents = await bindLinkStopsOwner('me');
    expect(intents).toMatchObject([{ link_id: 'lnk1', op_id: op }]);
    expect(isLinkBlocked('lnk1')).toBe(true);
    t2.store.getState().restoreStops(intents);
    t2.store.getState().applyServerLinks([view()]); // sunucu hâlâ aktif gösteriyor
    expect(t2.targets()).toEqual([]);

    const rp = t2.store.getState().retryPendingStops();
    await flush();
    expect(t2.api.linkShareStop).toHaveBeenCalledWith({ op_id: op, link_id: 'lnk1' });
    t2.stop.resolve({ ...view({ status: 'ended', end_reason: 'stopped_by_sender', version: 2 }), server_now: NOW });
    await rp;
    expect(listLinkStops()).toEqual([]);
  });

  it('sunucu anlık görüntüsü bittiğini gösterirse niyet kalkar (eski sürüm kaldıramaz)', async () => {
    await bindLinkStopsOwner('me');
    const t = setup('4');
    t.store.getState().applyServerLinks([view({ version: 3 })]);
    const sp = t.store.getState().stop('lnk1');
    await flush();
    t.stop.reject(unavailable);
    await sp;
    expect(reconcileLinkStops([view({ status: 'ended', version: 2 })], NOW)).toEqual([]);
    expect(isLinkBlocked('lnk1')).toBe(true);
    expect(reconcileLinkStops([view({ status: 'ended', version: 4 })], NOW)).toEqual(['lnk1']);
    expect(isLinkBlocked('lnk1')).toBe(false);
  });

  it('link_not_found: sunucu bağlantıyı tanımıyorsa durdurulmuş sayılır', async () => {
    const t = setup('5');
    t.store.getState().applyServerLinks([view()]);
    const sp = t.store.getState().stop('lnk1');
    await flush();
    t.stop.reject({ code: 'functions/not-found', details: { code: 'link_not_found' } });
    await expect(sp).resolves.toBe(true);
    expect(t.sessions()[0]).toMatchObject({ phase: 'ended' });
    expect(listLinkStops()).toEqual([]);
  });

  it('bitmek üzere evresi, +30 dk uzatma, süre dolunca hedef kalkar', async () => {
    const t = setup('6');
    t.store.getState().applyServerLinks([view()]);
    t.setClock(NOW + 50 * MINUTE); // 1 saatlikte uyarı 12 dk önce
    expect(t.sessions()[0]!.phase).toBe('expiring_soon');

    const ep = t.store.getState().extend('lnk1', 30);
    expect(t.sessions()[0]!.phase).toBe('extending');
    expect(t.api.linkShareExtend).toHaveBeenCalledWith({ op_id: '66666666-0000-4000-8000-000000000001', link_id: 'lnk1', minutes: 30 });
    t.extend.resolve({ ...view({ expires_at: NOW + 90 * MINUTE, version: 2, extended_count: 1 }), server_now: NOW + 50 * MINUTE });
    await expect(ep).resolves.toBe(true);
    expect(t.sessions()[0]).toMatchObject({ phase: 'active', expires_at: NOW + 90 * MINUTE, extended_count: 1 });
    expect(t.targets()[0]!.expires_at).toBe(NOW + 90 * MINUTE);

    t.setClock(NOW + 91 * MINUTE);
    expect(t.sessions()[0]).toMatchObject({ phase: 'ended', end_reason: 'expired' });
    expect(t.targets()).toEqual([]);
    await expect(t.store.getState().extend('lnk1', 30)).resolves.toBe(false);
  });

  it('süresiz bağlantı: uyarı anı yok, uzatılamaz', async () => {
    const t = setup('7');
    t.store.getState().applyServerLinks([view({ share_mode: 'indefinite', expires_at: null })]);
    expect(t.sessions()[0]).toMatchObject({ phase: 'active', prompt_at: null });
    await expect(t.store.getState().extend('lnk1', 60)).resolves.toBe(false);
    expect(t.api.linkShareExtend).not.toHaveBeenCalled();
  });
});
