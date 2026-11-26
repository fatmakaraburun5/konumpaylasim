/**
 * Faz 8 istemci depoları: izin yönü (`grantsStore`), varsayılan kapalı, görünmez mod niyeti ve "hiçbir şey
 * yayınlama" anahtarı (`publishHold` + konum hattı), onay kapısı (`selectNeedsConsent`, `consentStore`), kaydırma
 * kapısı (core `isScrolledToBottom`), push verisi (`f8Push`). Callable'lar sahte; AsyncStorage sahte.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CONSENT_TEXT_SHA256,
  CONSENT_UI_TEXT,
  CONSENT_VERSION,
  HOUR,
  isScrolledToBottom,
  MINUTE,
  type CallableName,
  type InvisibleState,
  type PermissionGrantDoc,
  type ShareStartResponse,
  type UserProfile,
} from '@konum/core';
import type { PublisherDeps } from '../src/services/firebase/publisher';
import { setCallTransport, type AccessApi, type InvisibleApi, type SharingApi } from '../src/services/firebase/callables';
import { createSamplePipeline, type AuthProbe } from '../src/services/location/pipeline';
import { f8ForegroundContent, parseF8Data, routeF8Open, setF8Handlers, type F8PushEvent } from '../src/services/notifications/f8Push';
import { selectNeedsConsent } from '../src/state/authStore';
import { createConsentStore } from '../src/state/consentStore';
import { createGrantsStore, isLocationRevoked, selectAccessSummary, selectCan, selectIncomingRequests } from '../src/state/grantsStore';
import { createInvisibleStore, selectIsInvisible } from '../src/state/invisibleStore';
import { loadPublishHold, loadTargets, saveTargets, type PersistedTarget } from '../src/state/persist';
import {
  __resetPublishHoldMemoryForTests,
  clearPublishHold,
  hydratePublishHold,
  invisibleIntent,
  isPublishHeld,
  setConsentHold,
  setInvisibleIntent,
  takePendingInvisible,
} from '../src/state/publishHold';
import { createSharingStore } from '../src/state/sharingStore';
import { isShareBlocked, hydrateStopIntents, __resetStopIntentsMemoryForTests } from '../src/state/stopIntents';

const NOW = Date.UTC(2026, 10, 25, 11, 0, 0);
const ME = 'me';
const OP = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

const doc = (granter: string, grantee: string, scopes: string[], over: Partial<PermissionGrantDoc> = {}): PermissionGrantDoc => ({
  granter_id: granter,
  grantee_id: grantee,
  scopes: Object.fromEntries(scopes.map((s) => [s, { granted_at: NOW - HOUR, via: 'manual' }])),
  pending: null,
  declined_at: {},
  updated_at: NOW - HOUR,
  version: 1,
  ...over,
});

beforeEach(async () => {
  __resetPublishHoldMemoryForTests();
  __resetStopIntentsMemoryForTests();
  await AsyncStorage.clear();
  await loadTargets(); // son okunan hedef listesi boş (eski liste bayrağı sıfırlanır)
});
afterEach(() => setCallTransport(null));

describe('grantsStore: yön ve varsayılan kapalı', () => {
  function setup(api: Partial<AccessApi> = {}) {
    let op = 0;
    return createGrantsStore({
      api: api as AccessApi,
      now: () => NOW,
      newOpId: () => OP(++op),
      timeZone: () => 'Europe/Istanbul',
      onShareStarted: jest.fn(),
    });
  }

  it('given = benim verdiğim, received = bana verilen; özet ve can() yönü karıştırmaz; belge yoksa her şey kapalı', () => {
    const store = setup();
    store.getState().setSnapshot(ME, [
      doc(ME, 'ayse', ['ping']), // ben → Ayşe: ping (Ayşe bana ping atabilir), konum YOK
      doc('ayse', ME, ['location_view']), // Ayşe → ben: ben Ayşe'yi görebilirim
      doc('x', 'y', ['location_view']), // başkalarının belgesi süzülür
    ]);
    const s = store.getState();
    expect(Object.keys(s.given)).toEqual(['ayse']);
    expect(Object.keys(s.received)).toEqual(['ayse']);
    expect(s.can('location_view', 'ayse', 'received')).toBe(true); // ben onu görebilirim
    expect(s.can('location_view', 'ayse', 'given')).toBe(false); // o beni göremez
    expect(s.can('ping', 'ayse', 'given')).toBe(true);
    expect(selectCan(s, 'ping', 'ayse', 'received')).toBe(false);
    expect(s.accessSummary('ayse')).toBe('i_see_them');
    // Hiç belge yok → karşılıklı kapalı (arkadaşlık konumu açmaz).
    expect(selectAccessSummary(s, 'can')).toBe('none');
    for (const scope of ['location_view', 'ping', 'zone_notify', 'meetup_invite', 'sos_alert'] as const) {
      expect(s.can(scope, 'can', 'given')).toBe(false);
      expect(s.can(scope, 'can', 'received')).toBe(false);
    }
  });

  it('gelen istek yalnızca benim granter olduğum belgelerden; yanıtlanınca kart hemen kalkar', async () => {
    const api = {
      permissionRequestRespond: jest.fn(async () => ({
        granted_scopes: ['location_view' as const],
        declined_scopes: [],
        share: null,
        share_skipped: null,
        server_now: NOW,
      })),
    };
    const store = setup(api);
    const pending = { scopes: ['location_view' as const], requested_at: NOW - MINUTE, expires_at: NOW + HOUR };
    store.getState().setSnapshot(ME, [doc(ME, 'can', [], { pending }), doc('ayse', ME, [], { pending })]);
    expect(selectIncomingRequests(store.getState(), NOW).map((r) => r.requester_id)).toEqual(['can']);
    const r = await store.getState().respond('can', ['location_view']);
    expect(r).toMatchObject({ ok: true, grantedScopes: ['location_view'], shareStarted: false });
    expect(api.permissionRequestRespond).toHaveBeenCalledWith(expect.objectContaining({ requester_id: 'can', grant_scopes: ['location_view'], share: null }));
    expect(store.getState().incomingRequests(NOW)).toEqual([]);
    expect(store.getState().can('location_view', 'can', 'given')).toBe(true);
  });

  it('konum iznini kapatmak yayını çağrı bitmeden keser (locationRevoked); hata olursa geri döner', async () => {
    let fail = false;
    const api = {
      permissionSet: jest.fn(async () => {
        if (fail) throw Object.assign(new Error('x'), { code: 'functions/permission-denied', details: { code: 'not_friends' } });
        return { grantee_id: 'ayse', scopes: [], server_now: NOW };
      }),
    };
    const store = setup(api);
    store.getState().setSnapshot(ME, [doc(ME, 'ayse', ['location_view'])]);
    const p = store.getState().setScope('ayse', 'location_view', false);
    expect(isLocationRevoked(store.getState(), 'ayse')).toBe(true);
    expect(store.getState().can('location_view', 'ayse', 'given')).toBe(false); // iyimser
    expect((await p).ok).toBe(true);

    const other = setup(api);
    other.getState().setSnapshot(ME, [doc(ME, 'mehmet', ['location_view'])]);
    fail = true;
    const r = await other.getState().setScope('mehmet', 'location_view', false);
    expect(r.ok).toBe(false);
    expect(isLocationRevoked(other.getState(), 'mehmet')).toBe(false);
    expect(other.getState().can('location_view', 'mehmet', 'given')).toBe(true);
  });

  it('konum izni geri alma ağ hatasında kesim kalır (eski anlık görüntü de kaldırmaz); bağlantı gelince aynı op_id', async () => {
    let online = false;
    const permissionSet = jest.fn(async (_req: { op_id: string }) => {
      if (!online) throw Object.assign(new Error('offline'), { code: 'functions/unavailable' });
      return { grantee_id: 'ayse', scopes: [], server_now: NOW };
    });
    const store = setup({ permissionSet } as unknown as Partial<AccessApi>);
    store.getState().setSnapshot(ME, [doc(ME, 'ayse', ['location_view'])]);
    expect((await store.getState().setScope('ayse', 'location_view', false)).ok).toBe(false);
    expect(isLocationRevoked(store.getState(), 'ayse')).toBe(true);
    store.getState().setSnapshot(ME, [doc(ME, 'ayse', ['location_view'])]);
    expect(isLocationRevoked(store.getState(), 'ayse')).toBe(true);
    expect(store.getState().can('location_view', 'ayse', 'given')).toBe(false);
    online = true;
    await store.getState().retryPendingRevokes();
    expect(permissionSet.mock.calls.map((c) => c[0].op_id)).toEqual([OP(1), OP(1)]);
    expect(isLocationRevoked(store.getState(), 'ayse')).toBe(true);
    await store.getState().retryPendingRevokes();
    expect(permissionSet).toHaveBeenCalledTimes(2);
  });
});

describe('görünmez mod: niyet önce, onay yalnızca sunucu profilinden', () => {
  function setup(invisibleSet: InvisibleApi['invisibleSet']) {
    const patchProfile = jest.fn();
    let op = 0;
    const store = createInvisibleStore({ api: { invisibleSet }, now: () => NOW, newOpId: () => OP(++op), uid: () => ME, patchProfile });
    return { store, patchProfile };
  }
  const on: InvisibleState = { on: true, since: NOW, snapshot: [], links_ended: 0 };

  it('setInvisible: callable çağrılırken yayın zaten kesik; başarı niyeti onaylamaz, applyServer(on) onaylar', async () => {
    const seen: boolean[] = [];
    const invisibleSet = jest.fn(async (_req: { op_id?: string; invisible: boolean }) => {
      seen.push(isPublishHeld());
      return { invisible: true, restored_receiver_ids: [], skipped_receiver_ids: [], server_now: NOW };
    });
    const { store } = setup(invisibleSet as unknown as InvisibleApi['invisibleSet']);
    expect(isPublishHeld()).toBe(false);
    const r = await store.getState().setInvisible();
    expect(r.ok).toBe(true);
    expect(seen).toEqual([true]);
    expect(invisibleSet).toHaveBeenCalledWith({ op_id: OP(1), invisible: true });
    expect(invisibleIntent(ME)).toMatchObject({ op_id: OP(1), confirmed: false });
    expect(selectIsInvisible(store.getState())).toBe(true);
    // Diskte de (başsız görev görsün); konum içermez.
    const disk = await loadPublishHold();
    expect(disk?.invisible?.op_id).toBe(OP(1));
    expect(JSON.stringify(disk)).not.toMatch(/lat|lng/);

    // Eski "görünür" anlık görüntü onaylanmamış niyeti silmez.
    store.getState().applyServer(ME, null);
    await flush();
    expect(isPublishHeld()).toBe(true);
    store.getState().applyServer(ME, on);
    await flush();
    expect(invisibleIntent(ME)?.confirmed).toBe(true);
    // Sunucu görünür derse (ör. SOS kapattı) onaylanmış niyet silinir.
    store.getState().applyServer(ME, null);
    await flush();
    expect(isPublishHeld()).toBe(false);
  });

  it('ağ yokken niyet kalır, yayın kapalı; retryPending aynı op_id ile yeniden gönderir', async () => {
    let calls = 0;
    const invisibleSet = jest.fn(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('offline'), { code: 'functions/unavailable' });
      return { invisible: true, restored_receiver_ids: [], skipped_receiver_ids: [], server_now: NOW };
    });
    const { store } = setup(invisibleSet as unknown as InvisibleApi['invisibleSet']);
    expect((await store.getState().setInvisible()).ok).toBe(false);
    expect(isPublishHeld()).toBe(true);
    await store.getState().retryPending();
    expect(invisibleSet.mock.calls.map((c) => (c as unknown as [{ op_id: string }])[0].op_id)).toEqual([OP(1), OP(1)]);
  });

  it('setVisible: yalnızca seçilen alıcılar gönderilir (varsayılan hiçbiri); başarıda niyet ve profil temizlenir', async () => {
    const invisibleSet = jest.fn(async (req: { invisible: boolean; restore_receiver_ids?: string[] }) => ({
      invisible: req.invisible,
      restored_receiver_ids: req.restore_receiver_ids ?? [],
      skipped_receiver_ids: [],
      server_now: NOW,
    }));
    const { store, patchProfile } = setup(invisibleSet as unknown as InvisibleApi['invisibleSet']);
    await store.getState().setInvisible();
    store.getState().applyServer(ME, on);
    await flush();
    const r = await store.getState().setVisible();
    expect(r).toEqual({ ok: true, restoredReceiverIds: [], skippedReceiverIds: [] });
    expect(invisibleSet).toHaveBeenLastCalledWith(expect.objectContaining({ invisible: false, restore_receiver_ids: [] }));
    expect(isPublishHeld()).toBe(false);
    expect(patchProfile).toHaveBeenCalledWith(null);
    await store.getState().setInvisible();
    await store.getState().setVisible(['ayse', 'ayse']);
    expect(invisibleSet).toHaveBeenLastCalledWith(expect.objectContaining({ restore_receiver_ids: ['ayse'] }));
  });

  it('sunucuya ulaşmamış niyet: görünür olma hatası niyeti silmez; sonra önce aynı op_id ile görünmez, sonra görünür', async () => {
    let online = false;
    const invisibleSet = jest.fn(async (req: { op_id: string; invisible: boolean; restore_receiver_ids?: string[] }) => {
      if (!online) throw Object.assign(new Error('offline'), { code: 'functions/unavailable' });
      return { invisible: req.invisible, restored_receiver_ids: [], skipped_receiver_ids: [], server_now: NOW };
    });
    const { store, patchProfile } = setup(invisibleSet as unknown as InvisibleApi['invisibleSet']);
    expect((await store.getState().setInvisible()).ok).toBe(false);
    expect((await store.getState().setVisible([])).ok).toBe(false);
    expect(invisibleIntent(ME)).toMatchObject({ op_id: OP(1), confirmed: false });
    expect(isPublishHeld()).toBe(true);
    online = true;
    expect((await store.getState().setVisible([])).ok).toBe(true);
    expect(invisibleSet.mock.calls.slice(-2).map((c) => c[0])).toEqual([
      { op_id: OP(1), invisible: true },
      expect.objectContaining({ invisible: false, restore_receiver_ids: [] }),
    ]);
    expect(isPublishHeld()).toBe(false);
    expect(patchProfile).toHaveBeenCalledWith(null);
  });

  it('çıkış: onaylanmamış niyet hesaba göre saklanır; aynı hesapla girişte aynı op_id ile geri gelir', async () => {
    const invisibleSet = jest.fn(async () => {
      throw Object.assign(new Error('offline'), { code: 'functions/unavailable' });
    });
    const { store } = setup(invisibleSet as unknown as InvisibleApi['invisibleSet']);
    await store.getState().setInvisible();
    await clearPublishHold();
    expect(isPublishHeld()).toBe(false);
    expect(await loadPublishHold()).toBeNull();
    __resetPublishHoldMemoryForTests(); // süreç yeniden başladı
    await hydratePublishHold();
    expect(takePendingInvisible('baska')).toBe(false);
    expect(takePendingInvisible(ME)).toBe(true);
    expect(isPublishHeld()).toBe(true);
    expect(invisibleIntent(ME)).toMatchObject({ op_id: OP(1), confirmed: false });
    expect(takePendingInvisible(ME)).toBe(false);
    // Onaylanmış niyet saklanmaz (sunucu profili yeniden girişte zaten görünmez der).
    await setInvisibleIntent(ME, { op_id: OP(1), at: NOW, confirmed: true });
    await clearPublishHold();
    __resetPublishHoldMemoryForTests();
    await hydratePublishHold();
    expect(takePendingInvisible(ME)).toBe(false);
  });

  it('görünmezken paylaşım başlatılmaz (invisible_mode); izinsiz alıcı needsGrantReceiverIds ile döner', async () => {
    const shareStart = jest.fn(
      async (_req: unknown): Promise<ShareStartResponse> => ({ session_id: 's1', shares: [], skipped_receiver_ids: [], needs_grant_receiver_ids: ['ayse'], server_now: NOW }),
    );
    let invisible = true;
    let op = 0;
    const store = createSharingStore({
      api: { shareStart, shareStop: jest.fn(), shareExtend: jest.fn() } as unknown as SharingApi,
      now: () => NOW,
      newOpId: () => OP(++op),
      timeZone: () => 'Europe/Istanbul',
      tickMs: 60_000,
      isInvisible: () => invisible,
    });
    try {
      const r1 = await store.getState().startShare(['ayse'], { kind: 'preset', preset: 'h1' });
      expect(r1).toEqual({ ok: false, error: expect.objectContaining({ code: 'invisible_mode' }) });
      expect(shareStart).not.toHaveBeenCalled();
      invisible = false;
      const r2 = await store.getState().startShare(['ayse'], { kind: 'preset', preset: 'h1' });
      expect(r2).toMatchObject({ ok: false, error: { code: 'not_permitted' }, needsGrantReceiverIds: ['ayse'] });
      expect(shareStart).toHaveBeenLastCalledWith(expect.objectContaining({ grant_location_view: false }));
      await store.getState().startShare(['ayse'], { kind: 'preset', preset: 'h1' }, { grantLocationView: true });
      expect(shareStart).toHaveBeenLastCalledWith(expect.objectContaining({ grant_location_view: true }));
    } finally {
      store.getState().dispose();
    }
  });
});

describe('yayın anahtarı: konum hattı hiçbir şey yazmaz', () => {
  const target: PersistedTarget = {
    share_id: 'me_ayse',
    receiver_id: 'ayse',
    share_mode: 'timed',
    expires_at: NOW + HOUR,
    session_id: 'srv1',
    started_at: NOW - MINUTE,
    version: 1,
  };

  const saveCurrent = () => saveTargets({ uid: ME, targets: [target], serverOffsetMs: 0, notificationBody: '1 kişiyle' });
  async function run(hold: () => Promise<void>, seed: () => Promise<void> = saveCurrent) {
    await seed();
    await hold();
    const write = jest.fn(async () => undefined);
    const publisher: PublisherDeps = { write, refreshTargets: jest.fn(async () => []) };
    const engine = { stopBackground: jest.fn(async () => undefined), startBackground: jest.fn(async () => undefined), canReconfigureNow: () => false };
    const pipeline = createSamplePipeline({
    batteryShare: async () => true,
    reportDeparture: async () => undefined,
      probeAuth: jest.fn(async (): Promise<AuthProbe> => ({ kind: 'signed_in', uid: ME })),
      publisherDeps: () => publisher,
      waitOnline: async () => true,
      readDevice: async () => ({ batteryLevel: 0.5, isCharging: false }),
      engine: engine as never,
      appPhase: () => 'background',
      deviceNow: () => NOW,
      isBlocked: isShareBlocked,
      hydrateBlocks: hydrateStopIntents,
      isHeld: isPublishHeld,
      hydrateHold: hydratePublishHold,
    });
    await pipeline.handleSamples([{ latitude: 41, longitude: 29, accuracy: 10, speed: 0, heading: 0, timestamp: NOW - 1_000 }], 'task');
    return { write, engine };
  }

  it('görünmez niyeti (diskte, başsız bağlam) → yazma yok, arka plan durur', async () => {
    await setInvisibleIntent(ME, { op_id: OP(1), at: NOW, confirmed: false });
    __resetPublishHoldMemoryForTests(); // süreç yeniden başladı: yalnızca disk
    const { write, engine } = await run(async () => undefined);
    expect(write).not.toHaveBeenCalled();
    expect(engine.stopBackground).toHaveBeenCalled();
  });

  it('onay kapısı açıkken de yayın yok', async () => {
    const { write } = await run(() => setConsentHold(ME, true));
    expect(write).not.toHaveBeenCalled();
  });

  it('başsız, kapalı başarısızlık: anahtar kaydı yokken Faz 8 öncesi liste yayınlanmaz; ön plan onayı görünce yayın', async () => {
    const legacy = () =>
      AsyncStorage.setItem('konum.bg.targets.v1', JSON.stringify({ uid: ME, targets: [target], serverOffsetMs: 0, notificationBody: '' }));
    const first = await run(async () => undefined, legacy);
    expect(first.write).not.toHaveBeenCalled();
    expect(first.engine.stopBackground).toHaveBeenCalled();
    // Ön plan güncel onayı gördü (kayıt yazıldı): aynı eski liste artık yayınlanır.
    const second = await run(() => setConsentHold(ME, false), legacy);
    expect(second.write).toHaveBeenCalled();
    expect((await loadPublishHold())?.consent_version).toBe(CONSENT_VERSION);
  });

  it('başsız: kayıttaki onay sürümü uygulamanınkinden eskiyse (sürüm yükseltildi) yayın yok; daha yeniyse yayın', async () => {
    const diskHold = (consent_version: string) => async () => {
      await AsyncStorage.setItem('konum.bg.invisible.v1', JSON.stringify({ uid: ME, invisible: null, consent_hold: false, consent_version }));
      __resetPublishHoldMemoryForTests(); // süreç yeniden başladı: yalnızca disk
    };
    expect((await run(diskHold('2000-01-01'))).write).not.toHaveBeenCalled();
    expect((await run(diskHold('2999-01-01'))).write).toHaveBeenCalled();
  });
});

describe('onay kapısı ve kaydırma kapısı', () => {
  const profile = (consent: UserProfile['consent']) => ({ consent }) as unknown as UserProfile;

  it('selectNeedsConsent: hazır profilde onay yok / eski sürüm → kapı; güncel → yok; profil yokken karar verilmez', () => {
    expect(selectNeedsConsent({ status: 'ready', profile: profile(null) })).toBe(true);
    expect(selectNeedsConsent({ status: 'ready', profile: profile({ version: '2026-06-01', accepted_at: NOW }) })).toBe(true);
    expect(selectNeedsConsent({ status: 'ready', profile: profile({ version: CONSENT_VERSION, accepted_at: NOW }) })).toBe(false);
    expect(selectNeedsConsent({ status: 'ready', profile: null })).toBe(false);
    expect(selectNeedsConsent({ status: 'bootstrapping', profile: profile(null) })).toBe(false);
    // Başka cihazda daha yeni sürüm onaylandı: eski uygulama kapıda kilitlenmez (güncelleme uyarısı Profil'de).
    expect(selectNeedsConsent({ status: 'ready', profile: profile({ version: '2999-01-01', accepted_at: NOW }) })).toBe(false);
  });

  it('consentStore.accept: sunucunun güncel sürümü daha yeniyse "uygulamayı güncelle" denir', async () => {
    setCallTransport(async () => {
      throw Object.assign(new Error('x'), { code: 'functions/failed-precondition', details: { code: 'consent_required', current_version: '2999-01-01' } });
    });
    const store = createConsentStore({ newOpId: () => OP(8), platform: () => 'ios', appVersion: () => '1.2.3', patchProfile: jest.fn() });
    expect(await store.getState().accept()).toBe(false);
    expect(store.getState().error).toBe(CONSENT_UI_TEXT.updateAppToAccept);
  });

  it('consentStore.accept: telde güncel sürüm + metin özeti + scrolled_to_bottom true; profil hemen güncellenir', async () => {
    const calls: { name: CallableName; payload: Record<string, unknown> }[] = [];
    setCallTransport(async (name, payload) => {
      calls.push({ name, payload: payload as Record<string, unknown> });
      if (name === 'consent_accept') return { consent: { version: CONSENT_VERSION, accepted_at: NOW }, server_now: NOW };
      return { consent: null, shares_ended: 2, links_ended: 1, server_now: NOW };
    });
    const patchProfile = jest.fn();
    const store = createConsentStore({ newOpId: () => OP(7), platform: () => 'ios', appVersion: () => '1.2.3', patchProfile });
    expect(await store.getState().accept()).toBe(true);
    expect(calls[0]).toEqual({
      name: 'consent_accept',
      payload: { op_id: OP(7), version: CONSENT_VERSION, text_sha256: CONSENT_TEXT_SHA256, scrolled_to_bottom: true, platform: 'ios', app_version: '1.2.3' },
    });
    expect(patchProfile).toHaveBeenCalledWith({ version: CONSENT_VERSION, accepted_at: NOW });
    expect(await store.getState().withdraw()).toEqual({ ok: true, sharesEnded: 2, linksEnded: 1 });
    expect(patchProfile).toHaveBeenLastCalledWith(null);
  });

  it('isScrolledToBottom: sona gelmeden false, tolerans içinde true, sığan metin true, ölçüm yokken false', () => {
    expect(isScrolledToBottom({ offsetY: 0, viewportH: 600, contentH: 3000 })).toBe(false);
    expect(isScrolledToBottom({ offsetY: 2300, viewportH: 600, contentH: 3000 })).toBe(false);
    expect(isScrolledToBottom({ offsetY: 2380, viewportH: 600, contentH: 3000 })).toBe(true);
    expect(isScrolledToBottom({ offsetY: 0, viewportH: 600, contentH: 500 })).toBe(true);
    expect(isScrolledToBottom({ offsetY: 0, viewportH: 0, contentH: 0 })).toBe(false);
  });
});

describe('Faz 8 push', () => {
  afterEach(() => setF8Handlers(null));

  it('permission_request / permission_granted ayrıştırılır; bilinmeyen kapsam düşer; koordinat yok', () => {
    expect(parseF8Data({ type: 'permission_request', from: 'can', scopes: 'location_view,lat,ping' })).toEqual({
      type: 'permission_request',
      from: 'can',
      scopes: ['location_view', 'ping'],
    });
    expect(parseF8Data({ type: 'permission_granted', by: 'mehmet', scopes: 'ping' })).toEqual({ type: 'permission_granted', by: 'mehmet', scopes: ['ping'] });
    expect(parseF8Data({ type: 'permission_request', from: '../x' })).toBeNull();
    expect(parseF8Data({ type: 'ping', from: 'can' })).toBeNull();
    const c = f8ForegroundContent({ data: { type: 'permission_request', from: 'can', scopes: 'location_view' } }, () => 'Can');
    expect(c?.body).toMatch(/Can/);
    expect(c?.channelId).toBe('friend_requests');
  });

  it('soğuk açılış: işleyici kurulana kadar dokunma bekletilir', () => {
    expect(routeF8Open({ type: 'permission_request', from: 'can', scopes: 'location_view' })).toBe(true);
    const opened: F8PushEvent[] = [];
    setF8Handlers({ received: () => undefined, open: (e) => opened.push(e) });
    expect(opened).toEqual([{ type: 'permission_request', from: 'can', scopes: ['location_view'] }]);
  });
});
