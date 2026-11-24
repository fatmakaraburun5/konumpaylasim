/**
 * sharingStore yapıştırıcı testleri: core reducer'ı saran zustand deposu + sahte callable'lar.
 * Durdurma niyetleri gerçek modülle (AsyncStorage sahte) test edilir: "süreç yeniden başladı" =
 * bellek sıfırlanır, disk korunur.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ERROR_CODES,
  HOUR,
  MINUTE,
  selectPublishTargets,
  selectSessions,
  type OutgoingShareView,
  type ShareExtendResponse,
  type ShareStartResponse,
  type ShareStopResponse,
} from '@konum/core';
import type { SharingApi } from '../src/services/firebase/callables';
import { createSharingStore, localSessionId } from '../src/state/sharingStore';
import {
  __resetStopIntentsMemoryForTests,
  addStopIntent,
  bindStopIntentsOwner,
  isShareBlocked,
  listStopIntents,
  reconcileStopIntents,
} from '../src/state/stopIntents';

/** Bekleyen söz zincirlerini (AsyncStorage sahte uygulaması dahil) boşalt. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

const NOW = Date.UTC(2026, 10, 23, 11, 0, 0);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const share = (receiver: string, over: Partial<OutgoingShareView> = {}): OutgoingShareView => ({
  share_id: `me_${receiver}`,
  session_id: 'srv1',
  receiver_id: receiver,
  status: 'active',
  share_mode: 'timed',
  started_at: NOW,
  expires_at: NOW + HOUR,
  end_reason: null,
  version: 1,
  ...over,
});

const created: { dispose: () => void }[] = [];

function setup(opPrefix = '0') {
  let clock = NOW;
  let op = 0;
  const start = deferred<ShareStartResponse>();
  const stop = deferred<ShareStopResponse>();
  const extend = deferred<ShareExtendResponse>();
  const api = {
    shareStart: jest.fn((_req: unknown) => start.promise),
    shareStop: jest.fn((_req: unknown) => stop.promise),
    shareExtend: jest.fn((_req: unknown) => extend.promise),
  };
  const store = createSharingStore({
    api: api as unknown as SharingApi,
    now: () => clock,
    newOpId: () => `${opPrefix.repeat(8)}-0000-4000-8000-00000000000${++op}`,
    timeZone: () => 'Europe/Istanbul',
    tickMs: 1_000,
  });
  created.push(store.getState());
  const sessions = () => selectSessions(store.getState().state);
  const targets = () => selectPublishTargets(store.getState().state);
  return { store, api, start, stop, extend, sessions, targets, setClock: (t: number) => (clock = t) };
}

const unavailable = { code: 'functions/unavailable', message: 'network error' };

describe('sharingStore', () => {
  beforeEach(async () => {
    __resetStopIntentsMemoryForTests();
    await AsyncStorage.clear();
  });
  afterEach(() => {
    // Testi başarısız olsa bile zamanlayıcılar (TICK, yeniden deneme) jest'i asılı bırakmasın.
    created.splice(0).forEach((s) => s.dispose());
    jest.useRealTimers();
  });

  it('başlat → sunucu onayı → durdur; yayın yalnızca onaylıyken, durdurunca anında kesilir', async () => {
    const t = setup();
    const p = t.store.getState().startShare(['a', 'b'], { kind: 'preset', preset: 'h1' });

    // Çift dokunma: ikinci çağrı aynı sözü döndürür, callable bir kez çağrılır.
    const p2 = t.store.getState().startShare(['a', 'b'], { kind: 'preset', preset: 'h1' });
    expect(p2).toBe(p);
    expect(t.api.shareStart).toHaveBeenCalledTimes(1);
    expect(t.api.shareStart).toHaveBeenCalledWith({
      op_id: '00000000-0000-4000-8000-000000000001',
      receiver_ids: ['a', 'b'],
      duration: { kind: 'preset', preset: 'h1' },
      time_zone: 'Europe/Istanbul',
    });

    // Sunucu onayından önce: "başlatılıyor", yayın hedefi YOK.
    expect(t.sessions()).toMatchObject([{ session_id: localSessionId('00000000-0000-4000-8000-000000000001'), phase: 'starting', confirmed: false }]);
    expect(t.targets()).toEqual([]);

    t.start.resolve({ session_id: 'srv1', shares: [share('a'), share('b')], skipped_receiver_ids: [], server_now: NOW });
    await expect(p).resolves.toEqual({ ok: true, sessionId: 'srv1', skippedReceiverIds: [] });

    // Yerel taslak kalktı, sunucu oturumu aktif.
    expect(t.sessions()).toHaveLength(1);
    expect(t.sessions()[0]).toMatchObject({ session_id: 'srv1', phase: 'active', active_receiver_ids: ['a', 'b'], expires_at: NOW + HOUR });
    expect(t.targets().map((x) => x.receiver_id)).toEqual(['a', 'b']);

    // Durdur: sunucu yanıtı gelmeden yayın kesilir (reducer + kesme anahtarı, senkron); çift dokunma tek çağrı.
    const sp = t.store.getState().stop('srv1');
    void t.store.getState().stop('srv1');
    expect(t.targets()).toEqual([]);
    expect(isShareBlocked('me_a')).toBe(true);
    expect(t.sessions()[0]!.phase).toBe('stopping');
    // Callable, niyet diske yazıldıktan SONRA gider.
    await flush();
    expect(t.api.shareStop).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await AsyncStorage.getItem('konum.bg.stops.v1'))!).intents).toHaveLength(1);

    t.stop.resolve({
      session_id: 'srv1',
      shares: [
        share('a', { status: 'ended', end_reason: 'stopped_by_sender', version: 2 }),
        share('b', { status: 'ended', end_reason: 'stopped_by_sender', version: 2 }),
      ],
      server_now: NOW + MINUTE,
    });
    await expect(sp).resolves.toBe(true);
    expect(t.sessions()[0]).toMatchObject({ phase: 'ended', end_reason: 'stopped_by_sender' });
    expect(t.targets()).toEqual([]);
    // Sunucu onayladı: niyet ve engel kalktı.
    expect(listStopIntents()).toEqual([]);
    expect(isShareBlocked('me_a')).toBe(false);
    t.store.getState().dispose();
  });

  it('durdurma başarısız + süreç yeniden başlar: sunucu hâlâ aktif gösterse de yayın geri gelmez, share_stop aynı op_id ile yeniden gider', async () => {
    const t1 = setup('1');
    const p = t1.store.getState().startShare(['a', 'b'], { kind: 'preset', preset: 'h1' });
    t1.start.resolve({ session_id: 'srv1', shares: [share('a'), share('b')], skipped_receiver_ids: [], server_now: NOW });
    await p;
    const sp = t1.store.getState().stop('srv1');
    await flush();
    const stopOp = (t1.api.shareStop.mock.calls[0]![0] as { op_id: string }).op_id;
    t1.stop.reject(unavailable);
    await expect(sp).resolves.toBe(false);
    expect(t1.sessions()[0]).toMatchObject({ phase: 'stopping', error: { code: 'unavailable' } });
    expect(t1.targets()).toEqual([]);
    t1.store.getState().dispose();

    // --- süreç yeniden başladı: bellek boş, disk duruyor ---
    __resetStopIntentsMemoryForTests();
    expect(isShareBlocked('me_a')).toBe(false);
    const t2 = setup('2');
    const intents = await bindStopIntentsOwner('me');
    expect(intents).toMatchObject([{ session_id: 'srv1', op_id: stopOp }]);
    expect(isShareBlocked('me_a')).toBe(true);
    t2.store.getState().restoreStopIntents(intents);
    // Firestore paylaşımı hâlâ aktif gösteriyor (durdurma sunucuya ulaşmadı).
    t2.store.getState().applyServerShares([share('a'), share('b')]);
    expect(t2.targets()).toEqual([]);
    expect(t2.sessions()[0]).toMatchObject({ session_id: 'srv1', phase: 'stopping' });

    // Yeniden deneme AYNI op_id ile (sunucu tekilleştirir).
    const rp = t2.store.getState().retryPendingStops();
    await flush();
    expect(t2.api.shareStop).toHaveBeenCalledWith({ op_id: stopOp, session_id: 'srv1' });
    t2.stop.resolve({
      session_id: 'srv1',
      shares: [share('a', { status: 'ended', end_reason: 'stopped_by_sender', version: 2 }), share('b', { status: 'ended', end_reason: 'stopped_by_sender', version: 2 })],
      server_now: NOW,
    });
    await rp;
    expect(listStopIntents()).toEqual([]);
    expect(t2.sessions()[0]).toMatchObject({ phase: 'ended' });
    // Geç gelen eski anlık görüntü (hâlâ aktif) de yayını geri getirmez.
    t2.store.getState().applyServerShares([share('a'), share('b')]);
    expect(t2.targets()).toEqual([]);
  });

  it('başarısız durdurma geri çekilmeli olarak kendiliğinden yeniden denenir', async () => {
    jest.useFakeTimers();
    let calls = 0;
    const api = {
      shareStart: jest.fn(),
      shareExtend: jest.fn(),
      shareStop: jest.fn(async () => {
        calls++;
        if (calls === 1) throw unavailable;
        return { session_id: 'srv1', shares: [share('a', { status: 'ended', end_reason: 'stopped_by_sender', version: 2 })], server_now: NOW };
      }),
    };
    const store = createSharingStore({
      api: api as unknown as SharingApi,
      now: () => NOW,
      newOpId: () => '33333333-0000-4000-8000-000000000001',
      timeZone: () => 'Europe/Istanbul',
      tickMs: 1_000,
      stopRetryBackoffMs: [5_000],
    });
    created.push(store.getState());
    store.getState().applyServerShares([share('a')]);
    await expect(store.getState().stop('srv1')).resolves.toBe(false);
    expect(api.shareStop).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(api.shareStop).toHaveBeenCalledTimes(2);
    expect(listStopIntents()).toEqual([]);
  });

  it('aynı kişiyle yeni paylaşım, eski oturumun durdurma engelini kaldırır', async () => {
    const t = setup('4');
    t.store.getState().applyServerShares([share('a')]);
    const sp = t.store.getState().stop('srv1');
    await flush();
    t.stop.reject(unavailable);
    await sp;
    expect(isShareBlocked('me_a')).toBe(true);

    // Kullanıcı aynı kişiyle yeniden başlatır: sunucu belgeyi yeni oturumla (srv2) değiştirir.
    const p = t.store.getState().startShare(['a'], { kind: 'preset', preset: 'm15' });
    t.start.resolve({ session_id: 'srv2', shares: [share('a', { session_id: 'srv2', version: 3, expires_at: NOW + 15 * MINUTE })], skipped_receiver_ids: [], server_now: NOW });
    await p;
    await flush();
    expect(isShareBlocked('me_a')).toBe(false);
    expect(listStopIntents()).toEqual([]);
    expect(t.targets().map((x) => x.share_id)).toEqual(['me_a']);
  });

  it('geç gelen (eski) anlık görüntü callable ile onaylanan yeni oturumu silmez', async () => {
    const t = setup('5');
    const p = t.store.getState().startShare(['a'], { kind: 'preset', preset: 'h1' });
    t.start.resolve({ session_id: 'srv1', shares: [share('a')], skipped_receiver_ids: [], server_now: NOW });
    await p;
    // Dinleyici henüz yeni yazmayı görmemiş: boş liste.
    t.store.getState().applyServerShares([]);
    expect(t.sessions()).toMatchObject([{ session_id: 'srv1', phase: 'active' }]);
    expect(t.targets()).toHaveLength(1);
    // Dinleyici yetişti (aynı sürüm): tutma kalkar; sonraki boş liste artık gerçektir.
    t.store.getState().applyServerShares([share('a')]);
    t.store.getState().applyServerShares([]);
    expect(t.sessions()).toEqual([]);
  });

  it('başlatma hatası HttpsError.details.code → core ERROR_CODES', async () => {
    const t = setup();
    const p = t.store.getState().startShare(['a'], { kind: 'preset', preset: 'm15' });
    t.start.reject({ code: 'functions/failed-precondition', message: 'raw server text', details: { code: 'not_friends' } });
    await expect(p).resolves.toEqual({ ok: false, error: { code: 'not_friends', message: ERROR_CODES.not_friends.message } });
    expect(t.sessions()[0]).toMatchObject({ phase: 'failed', error: { code: 'not_friends' } });
    expect(t.targets()).toEqual([]);
    t.store.getState().dispose();
  });

  it('geçersiz özel süre callable çağırmadan DurationError mesajıyla döner', async () => {
    const t = setup();
    const r = await t.store.getState().startShare(['a'], { kind: 'custom_minutes', minutes: 2 });
    expect(r).toEqual({ ok: false, error: { code: 'invalid_duration', message: 'Süre en az 5 dakika olmalı' } });
    expect(t.api.shareStart).not.toHaveBeenCalled();
    t.store.getState().dispose();
  });

  it('uzatma sürerken ikinci uzatma gönderilmez; onay sonrası yeni bitiş', async () => {
    const t = setup();
    const p = t.store.getState().startShare(['a'], { kind: 'preset', preset: 'h1' });
    t.start.resolve({ session_id: 'srv1', shares: [share('a')], skipped_receiver_ids: [], server_now: NOW });
    await p;
    const e1 = t.store.getState().extend('srv1', 30);
    const e2 = t.store.getState().extend('srv1', 60);
    expect(e2).toBe(e1);
    expect(t.api.shareExtend).toHaveBeenCalledTimes(1);
    expect(t.sessions()[0]!.phase).toBe('extending');
    expect(t.targets()).toHaveLength(1); // uzatma sırasında yayın sürer
    t.extend.resolve({
      session_id: 'srv1',
      shares: [share('a', { expires_at: NOW + 90 * MINUTE, version: 2 })],
      expires_at: NOW + 90 * MINUTE,
      share_mode: 'timed',
      server_now: NOW,
    });
    await expect(e1).resolves.toBe(true);
    expect(t.sessions()[0]).toMatchObject({ phase: 'active', expires_at: NOW + 90 * MINUTE });
    t.store.getState().dispose();
  });

  it('saniyelik TICK: süre sunucu saatine göre dolunca yayın kendiliğinden kesilir', async () => {
    jest.useFakeTimers();
    const t = setup();
    const p = t.store.getState().startShare(['a'], { kind: 'preset', preset: 'm15' });
    t.start.resolve({ session_id: 'srv1', shares: [share('a', { expires_at: NOW + 15 * MINUTE })], skipped_receiver_ids: [], server_now: NOW });
    await p;
    expect(t.targets()).toHaveLength(1);
    t.setClock(NOW + 15 * MINUTE);
    jest.advanceTimersByTime(1_000);
    expect(t.targets()).toEqual([]);
    expect(t.sessions()[0]).toMatchObject({ phase: 'ended', end_reason: 'expired' });
    t.store.getState().dispose();
  });

  it('kapatılan (DISMISS) biten oturum sunucu anlık görüntüsüyle geri gelmez', async () => {
    const t = setup();
    const ended = [share('a', { status: 'ended', end_reason: 'revoked_by_receiver', version: 3 })];
    t.store.getState().applyServerShares(ended);
    expect(t.sessions()[0]).toMatchObject({ phase: 'ended', end_reason: 'revoked_by_receiver' });
    t.store.getState().dismiss('srv1');
    t.store.getState().applyServerShares(ended);
    expect(t.sessions()).toEqual([]);
    t.store.getState().dispose();
  });
});

describe('reconcileStopIntents', () => {
  beforeEach(async () => {
    __resetStopIntentsMemoryForTests();
    await AsyncStorage.clear();
  });

  const intent = () => ({ session_id: 'srv1', op_id: '44444444-0000-4000-8000-000000000001', shares: [{ share_id: 'me_a', version: 2 }], requested_at: NOW });
  const doc = (over: Partial<OutgoingShareView>) => ({ ...share('a', { version: 2 }), ...over });

  it('eski önbellek ya da hâlâ aktif belge niyeti KALDIRMAZ', async () => {
    await addStopIntent(intent());
    expect(reconcileStopIntents([doc({ status: 'ended', version: 1 })], NOW)).toEqual([]); // eski sürüm
    expect(reconcileStopIntents([doc({})], NOW)).toEqual([]); // aynı oturum, aktif
    expect(reconcileStopIntents([], NOW)).toEqual([]); // belge yok
    expect(isShareBlocked('me_a')).toBe(true);
  });

  it('bitti, süresi doldu ya da yeni oturuma geçti → niyet kalkar', async () => {
    await addStopIntent(intent());
    expect(reconcileStopIntents([doc({ status: 'ended', version: 3 })], NOW)).toEqual(['srv1']);
    await addStopIntent(intent());
    expect(reconcileStopIntents([doc({ expires_at: NOW - 1 })], NOW)).toEqual(['srv1']);
    await addStopIntent(intent());
    expect(reconcileStopIntents([doc({ session_id: 'srv2', version: 2 })], NOW)).toEqual([]); // aynı sürüm: belirsiz
    expect(reconcileStopIntents([doc({ session_id: 'srv2', version: 3 })], NOW)).toEqual(['srv1']);
    expect(isShareBlocked('me_a')).toBe(false);
  });
});
