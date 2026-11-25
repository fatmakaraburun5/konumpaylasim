/**
 * Faz 6 uygulama JS: widget eşitleme kısıtlaması, hızlı paylaşım (derin bağlantı kararı + "1 sa" kuralı),
 * profil fotoğrafı hattı (sahte kodlayıcı / Storage ve yerel modül sahteleriyle), favoriler, push ayrıştırma ve
 * başsız widget paylaşımının kalıcı hedeflere alınması.
 */
import {
  AVATAR_LIMITS,
  buildWidgetSnapshot,
  FAVORITE_LIMIT_TEXT,
  HOUR,
  MINUTE,
  parseQuickShareDeepLink,
  QUICK_SHARE_DURATION,
  WIDGET_LIMITS,
  type OutgoingShareView,
  type WidgetBuildInput,
} from '@konum/core';

jest.mock('@react-native-firebase/storage', () => {
  const refs: string[] = [];
  return {
    __refs: refs,
    getStorage: jest.fn(() => ({})),
    ref: jest.fn((_s: unknown, path: string) => ({ fullPath: path })),
    putFile: jest.fn(async () => ({ state: 'success' })),
    getDownloadURL: jest.fn(async (r: { fullPath: string }) => `https://firebasestorage.googleapis.com/v0/b/test/o/${encodeURIComponent(r.fullPath)}?alt=media&token=t`),
  };
});
jest.mock('expo-image-manipulator', () => {
  const calls: unknown[][] = [];
  const ctx: Record<string, unknown> = {};
  Object.assign(ctx, {
    crop: jest.fn((r: unknown) => (calls.push(['crop', r]), ctx)),
    resize: jest.fn((r: unknown) => (calls.push(['resize', r]), ctx)),
    renderAsync: jest.fn(async () => ({
      saveAsync: jest.fn(async (o: unknown) => (calls.push(['save', o]), { uri: 'file:///cache/out.jpg', width: 512, height: 512 })),
      release: jest.fn(),
    })),
    release: jest.fn(),
  });
  return { __calls: calls, ImageManipulator: { manipulate: jest.fn(() => ctx) }, SaveFormat: { JPEG: 'jpeg', PNG: 'png' } };
});
jest.mock('expo-file-system', () => ({
  File: jest.fn().mockImplementation(() => ({ exists: true, size: 123_456 })),
  Directory: jest.fn(),
  Paths: { cache: { uri: 'file:///cache/' } },
}));
jest.mock('expo-image-picker', () => ({
  getCameraPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: false })),
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: false })),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///pick.jpg', width: 4032, height: 3024 }] })),
}));
jest.mock('../src/services/firebase/init', () => ({ ensureFirebase: jest.fn(async () => undefined) }));

import { planQuickShareLink, quickShareFailureView, runQuickShare } from '../src/features/quickShare/quickShareModel';
import { handleQuickShareResponse } from '../src/services/f6Services';
import { parseF6Data } from '../src/services/notifications/f6Push';
import { AvatarError, centerSquareCrop, prepareAvatar, uploadPreparedAvatar, type AvatarPipelineDeps, type EncodedImage } from '../src/services/profile/avatarPipeline';
import { avatarPlatform, pickAvatarImage } from '../src/services/profile/avatarUpload';
import { selectAdoptableShares, wantedFromPush } from '../src/services/widgets/widgetBackground';
import { createWidgetSync, selectWidgetInput, type WidgetSyncState } from '../src/services/widgets/widgetSync';
import type { ShareDoc } from '../src/lib/schemas';
import { createFavoritesStore } from '../src/state/favoritesStore';
import { createProfileStore } from '../src/state/profileStore';
import { PENDING_TTL_MS, quickShareStore } from '../src/state/quickShareStore';

const T0 = 1_760_000_000_000;

// ---------------------------------------------------------------------------
// Widget eşitleme: yazma ≥ 60 sn, yenileme ≥ 5 dk, büyük değişim hemen
// ---------------------------------------------------------------------------

describe('createWidgetSync kısıtlaması', () => {
  beforeEach(() => jest.useFakeTimers({ now: T0 }));
  afterEach(() => jest.useRealTimers());

  function harness() {
    let input: WidgetBuildInput = {
      now: T0,
      signed_in: true,
      me: { display_name: 'Can Demir' },
      favorite_ids: ['ayse'],
      friends: [{ uid: 'ayse', display_name: 'Ayşe Yılmaz', gender: 'female', incoming: { active: true, last_seen_at: T0, battery_pct: 80 } }],
      outgoing: [],
      quick: { token_expires_at: T0 + 30 * 24 * HOUR, bg_location_ok: true },
    };
    const listeners = new Set<() => void>();
    const bridge = { setSnapshot: jest.fn(async (_json: string) => undefined), reload: jest.fn() };
    const sync = createWidgetSync({
      bridge,
      build: () => buildWidgetSnapshot({ ...input, now: Date.now() }),
      subscribe: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      now: () => Date.now(),
      debounceMs: 800,
    });
    const change = (fn: (i: WidgetBuildInput) => WidgetBuildInput) => {
      input = fn(input);
      listeners.forEach((l) => l());
    };
    const battery = (pct: number) =>
      change((i) => ({ ...i, friends: i.friends.map((f) => ({ ...f, incoming: f.incoming ? { ...f.incoming, battery_pct: pct } : null })) }));
    return { sync, bridge, change, battery };
  }

  it('ilk yazım hemen; küçük değişim 60 sn bekler, yenileme 5 dk dolunca bir kez', async () => {
    const h = harness();
    h.sync.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.bridge.setSnapshot).toHaveBeenCalledTimes(1);
    expect(h.bridge.reload).toHaveBeenCalledTimes(1);

    // +10 sn: pil değişti (minor) → yazma aralığı dolmadı.
    await jest.advanceTimersByTimeAsync(10_000);
    h.battery(70);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(h.bridge.setSnapshot).toHaveBeenCalledTimes(1);

    // İlk yazımdan 60 sn sonra yazılır ama yenilenmez (5 dk dolmadı).
    await jest.advanceTimersByTimeAsync(WIDGET_LIMITS.writeMinIntervalMs);
    expect(h.bridge.setSnapshot).toHaveBeenCalledTimes(2);
    expect(JSON.parse(h.bridge.setSnapshot.mock.calls[1]![0]).favorites[0].battery_pct).toBe(70);
    expect(h.bridge.reload).toHaveBeenCalledTimes(1);

    // Yenileme aralığı dolunca bekleyen yenileme yapılır (yeni değişim olmadan).
    await jest.advanceTimersByTimeAsync(WIDGET_LIMITS.reloadMinIntervalMs);
    expect(h.bridge.reload).toHaveBeenCalledTimes(2);
    expect(h.bridge.setSnapshot).toHaveBeenCalledTimes(2);
    h.sync.stop();
  });

  it('büyük değişim (paylaşım bitti) kısıtlamayı aşar; değişmeyen durum yazılmaz; force push için yazar', async () => {
    const h = harness();
    h.sync.start();
    await jest.advanceTimersByTimeAsync(5_000);
    h.change((i) => ({ ...i, friends: i.friends.map((f) => ({ ...f, incoming: null })) }));
    await jest.advanceTimersByTimeAsync(1_000);
    expect(h.bridge.setSnapshot).toHaveBeenCalledTimes(2);
    expect(h.bridge.reload).toHaveBeenCalledTimes(2);
    expect(JSON.parse(h.bridge.setSnapshot.mock.calls[1]![0]).favorites[0].status).toBe('not_sharing');

    // Görünür fark yok → hiçbir şey.
    h.change((i) => ({ ...i }));
    await jest.advanceTimersByTimeAsync(1_000);
    expect(h.bridge.setSnapshot).toHaveBeenCalledTimes(2);

    expect(h.sync.syncNow({ force: true })).toBe('none');
    await jest.advanceTimersByTimeAsync(0);
    expect(h.bridge.setSnapshot).toHaveBeenCalledTimes(3);
    expect(h.bridge.reload).toHaveBeenCalledTimes(3);

    h.sync.stop();
    h.battery(10);
    await jest.advanceTimersByTimeAsync(10 * MINUTE);
    expect(h.bridge.setSnapshot).toHaveBeenCalledTimes(3);
  });

  it('girdi hazır değilken (arkadaş listesi yüklenmedi) yazmaz; hazır olunca ilk değişimde yazar', async () => {
    let ready = false;
    const bridge = { setSnapshot: jest.fn(async (_json: string) => undefined), reload: jest.fn() };
    let notify: () => void = () => undefined;
    const input: WidgetBuildInput = { now: T0, signed_in: true, me: { display_name: 'Can' }, favorite_ids: [], friends: [], outgoing: [], quick: { token_expires_at: null, bg_location_ok: false } };
    const sync = createWidgetSync({
      bridge,
      build: () => buildWidgetSnapshot({ ...input, now: Date.now() }),
      subscribe: (cb) => ((notify = cb), () => undefined),
      now: () => Date.now(),
      debounceMs: 800,
      ready: () => ready,
    });
    sync.start();
    expect(sync.syncNow({ force: true })).toBe('none');
    await jest.advanceTimersByTimeAsync(0);
    expect(bridge.setSnapshot).not.toHaveBeenCalled();
    ready = true;
    notify();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(bridge.setSnapshot).toHaveBeenCalledTimes(1);
    sync.stop();
  });
});

describe('selectWidgetInput', () => {
  const base: WidgetSyncState = {
    now: T0,
    signedIn: true,
    me: { display_name: 'Can' },
    favoriteIds: ['ayse', 'mehmet'],
    friends: [
      { uid: 'ayse', displayName: 'Ayşe', gender: 'female', photoKey: 'ayse:1760000000000' },
      { uid: 'mehmet', displayName: 'Mehmet', gender: 'male', photoKey: 'mehmet:1760000000001' },
      { uid: 'zeynep', displayName: 'Zeynep', gender: 'female', photoKey: null },
    ],
    incoming: [],
    incomingShares: [{ sender_id: 'mehmet', status: 'active', expires_at: T0 + HOUR, share_mode: 'timed', started_at: T0 - MINUTE }],
    outgoing: [{ receiver_id: 'ayse', expires_at: T0 + 30 * MINUTE }],
    places: {},
    avatarFiles: { ayse: { key: 'ayse:1760000000000', file: 'ayse.jpg' }, mehmet: { key: 'mehmet:OLD', file: 'mehmet.jpg' } },
    tokenExpiresAt: T0 + 20 * 24 * HOUR,
    bgLocationOk: true,
    lockScreenDetails: false,
  };

  it('yalnızca favoriler; eski sürüm avatar dosyası kullanılmaz; konumu gelmemiş paylaşım aktif sayılır', () => {
    const snap = buildWidgetSnapshot(selectWidgetInput(base));
    expect(snap.favorites.map((f) => f.uid)).toEqual(['ayse', 'mehmet']);
    const [ayse, mehmet] = snap.favorites;
    expect(ayse!.avatar_file).toBe('ayse.jpg');
    expect(ayse!.my_share_expires_at).toBe(T0 + 30 * MINUTE);
    expect(mehmet!.avatar_file).toBeNull();
    expect(mehmet!.status).not.toBe('not_sharing');
    expect(snap.quick).toEqual({ token_ok: true, bg_location_ok: true });
    expect(JSON.stringify(snap)).not.toMatch(/"lat"|"lng"|https?:/);
  });
});

// ---------------------------------------------------------------------------
// Hızlı paylaşım: derin bağlantı kararı ve "1 sa" kuralı
// ---------------------------------------------------------------------------

describe('hızlı paylaşım derin bağlantısı', () => {
  it('bağlantı ayrıştırma ve ilk karar', () => {
    expect(parseQuickShareDeepLink('konum://quick-share?to=ayse&src=ios_widget')).toEqual({ to: 'ayse', src: 'ios_widget' });
    expect(parseQuickShareDeepLink('konum://quick-share?to=../x')).toBeNull();
    expect(planQuickShareLink({ authStatus: 'signedOut', friendsLoaded: false, isFriend: false }).kind).toBe('signed_out');
    expect(planQuickShareLink({ authStatus: 'bootstrapping', friendsLoaded: true, isFriend: true }).kind).toBe('wait');
    expect(planQuickShareLink({ authStatus: 'ready', friendsLoaded: false, isFriend: false }).kind).toBe('wait');
    expect(planQuickShareLink({ authStatus: 'ready', friendsLoaded: true, isFriend: false }).kind).toBe('not_friend');
    expect(planQuickShareLink({ authStatus: 'ready', friendsLoaded: true, isFriend: true }).kind).toBe('ready');
    expect(quickShareFailureView('unavailable').retry).toBe(true);
    expect(quickShareFailureView('not_friends').retry).toBe(false);
  });

  it('bekleyen istek bir kez alınır; süresi geçmişse atılır', () => {
    const s = quickShareStore.getState();
    s.setPending({ to: 'ayse', src: 'ios_widget', at: T0 });
    expect(quickShareStore.getState().takePending(T0 + 1_000)).toEqual({ to: 'ayse', src: 'ios_widget', at: T0 });
    expect(quickShareStore.getState().takePending(T0 + 2_000)).toBeNull();
    s.setPending({ to: 'ayse', src: 'ios_widget', at: T0 });
    expect(quickShareStore.getState().takePending(T0 + PENDING_TTL_MS + 1)).toBeNull();
    quickShareStore.getState().reset();
  });

  const share = (expires_at: number | null): OutgoingShareView => ({
    share_id: 'sh1',
    session_id: 'se1',
    receiver_id: 'ayse',
    status: 'active',
    share_mode: expires_at === null ? 'indefinite' : 'timed',
    started_at: T0 - HOUR,
    expires_at,
    end_reason: null,
    version: 1,
  });

  it('yoksa başlatır, kısa kaldıysa 60 dk’ya uzatır, uzunsa dokunmaz', async () => {
    const startShare = jest.fn(async () => ({ ok: true as const, sessionId: 'se2', skippedReceiverIds: [] as string[] }));
    const deps = (shares: OutgoingShareView[]) => ({
      state: () => ({ shares: Object.fromEntries(shares.map((s) => [s.share_id, s])) }),
      startShare,
      sessionExpiry: () => T0 + HOUR,
      now: () => T0,
    });

    await expect(runQuickShare('ayse', deps([]))).resolves.toEqual({ ok: true, status: 'started', expires_at: T0 + HOUR, session_id: 'se2' });
    expect(startShare).toHaveBeenLastCalledWith(['ayse'], QUICK_SHARE_DURATION);

    await expect(runQuickShare('ayse', deps([share(T0 + 20 * MINUTE)]))).resolves.toMatchObject({ ok: true, status: 'extended' });
    expect(startShare).toHaveBeenCalledTimes(2);

    // 8 saatlik paylaşım 1 saate KISALMAZ; süresiz de.
    await expect(runQuickShare('ayse', deps([share(T0 + 8 * HOUR)]))).resolves.toMatchObject({ ok: true, status: 'already_active', session_id: 'se1' });
    await expect(runQuickShare('ayse', deps([share(null)]))).resolves.toMatchObject({ ok: true, status: 'already_active', expires_at: null });
    expect(startShare).toHaveBeenCalledTimes(2);

    startShare.mockResolvedValueOnce({ ok: true, sessionId: 'se3', skippedReceiverIds: ['ayse'] });
    await expect(runQuickShare('ayse', deps([]))).resolves.toMatchObject({ ok: false, error: { code: 'not_friends' } });
  });
});

// ---------------------------------------------------------------------------
// Profil fotoğrafı hattı
// ---------------------------------------------------------------------------

describe('profil fotoğrafı hattı', () => {
  function fakeDeps(sizeFor: (px: number, q: number) => number | null, upload?: AvatarPipelineDeps['upload']) {
    const encode = jest.fn(async (src: { uri: string }, px: number, q: number, _crop: unknown) => ({
      uri: `file:///${px}_${q}.jpg`,
      width: px,
      height: px,
      bytes: sizeFor(px, q),
      from: src.uri,
    }));
    const deps: AvatarPipelineDeps = {
      encode,
      upload: upload ?? jest.fn(async (path: string) => `https://firebasestorage.googleapis.com/v0/b/x/o/${encodeURIComponent(path)}?alt=media&token=t`),
      now: () => T0 + 0.7,
    };
    return { deps, encode };
  }

  it('kare kırpar, sınırı aşan JPEG daha düşük kaliteyle yeniden kodlanır, küçük boy ana boydan üretilir', async () => {
    expect(centerSquareCrop(4032, 3024)).toEqual({ originX: 504, originY: 0, width: 3024, height: 3024 });
    expect(centerSquareCrop(800, 800)).toBeNull();
    const { deps, encode } = fakeDeps((px, q) => (px === AVATAR_LIMITS.mainPx ? (q >= 0.8 ? 480_000 : 300_000) : 40_000));
    const r = await prepareAvatar({ uri: 'file:///pick.jpg', width: 4032, height: 3024 }, deps);
    expect(encode.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [512, 0.8],
      [512, 0.65],
      [160, 0.7],
    ]);
    expect(encode.mock.calls[0]![3]).toEqual({ originX: 504, originY: 0, width: 3024, height: 3024 });
    expect(encode.mock.calls[2]![0].uri).toBe(r.main.uri);
    expect(encode.mock.calls[2]![3]).toBeNull();

    const up = await uploadPreparedAvatar('u_can', r, deps);
    expect(up.version).toBe(T0);
    expect(up.avatar_url).toContain(encodeURIComponent(`avatars/u_can/${T0}.jpg`));
    expect(up.avatar_thumb_url).toContain(encodeURIComponent(`avatars/u_can/${T0}_160.jpg`));

    await expect(prepareAvatar({ uri: 'file:///huge.jpg', width: 0, height: 0 }, fakeDeps(() => 900_000).deps)).rejects.toMatchObject({ code: 'too_large' });
    await expect(uploadPreparedAvatar('u_can', r, fakeDeps(() => 1, jest.fn(async () => Promise.reject({ code: 'storage/retry-limit-exceeded' }))).deps)).rejects.toMatchObject({
      code: 'offline',
    });
  });

  it('native: manipulator 512 JPEG + Storage putFile (image/jpeg); kamera izni kalıcı reddi → Ayarlar', async () => {
    const manip = jest.requireMock('expo-image-manipulator') as { __calls: unknown[][] };
    const storage = jest.requireMock('@react-native-firebase/storage') as { putFile: jest.Mock };
    const enc = (await avatarPlatform.deps.encode({ uri: 'file:///pick.jpg', width: 4032, height: 3024 }, 512, 0.8, centerSquareCrop(4032, 3024))) as EncodedImage;
    expect(enc).toEqual({ uri: 'file:///cache/out.jpg', width: 512, height: 512, bytes: 123_456 });
    expect(manip.__calls).toEqual([
      ['crop', { originX: 504, originY: 0, width: 3024, height: 3024 }],
      ['resize', { width: 512, height: 512 }],
      ['save', { compress: 0.8, format: 'jpeg' }],
    ]);
    const url = await avatarPlatform.deps.upload(`avatars/u_can/${T0}.jpg`, enc);
    expect(url).toContain('alt=media');
    expect(storage.putFile).toHaveBeenCalledWith({ fullPath: `avatars/u_can/${T0}.jpg` }, 'file:///cache/out.jpg', expect.objectContaining({ contentType: 'image/jpeg' }));

    await expect(pickAvatarImage('camera')).resolves.toEqual({ kind: 'denied', source: 'camera', canAskAgain: false });
    await expect(pickAvatarImage('library')).resolves.toEqual({ kind: 'picked', image: { uri: 'file:///pick.jpg', width: 4032, height: 3024 } });
  });

  it('profileStore: iyimser önizleme, hata sonrası "Tekrar dene" yeniden kodlamadan sürer', async () => {
    const { deps, encode } = fakeDeps(() => 10_000);
    let fail = true;
    const save = jest.fn(async () => (fail ? { ok: false as const, message: 'Bağlantı yok' } : { ok: true as const }));
    const store = createProfileStore({
      uid: () => 'u_can',
      save,
      platform: {
        pick: async () => ({ kind: 'picked', image: { uri: 'file:///pick.jpg', width: 100, height: 100 } }),
        deps,
        openSettings: async () => undefined,
        cameraAvailable: true,
      },
    });
    await expect(store.getState().changePhoto('library')).resolves.toBe(false);
    expect(store.getState()).toMatchObject({ phase: 'error', previewUri: 'file:///pick.jpg', error: 'Bağlantı yok' });
    expect(encode).toHaveBeenCalledTimes(2);
    fail = false;
    await expect(store.getState().retryPhoto()).resolves.toBe(true);
    expect(encode).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ avatar_url: expect.stringContaining('alt=media'), avatar_thumb_url: expect.stringContaining('_160.jpg') });
    expect(store.getState()).toMatchObject({ phase: 'idle', previewUri: null, error: null });
    expect(new AvatarError('offline').message).toMatch(/Bağlantı yok/);
  });
});

// ---------------------------------------------------------------------------
// Favoriler, push verisi, başsız widget paylaşımı
// ---------------------------------------------------------------------------

describe('favoriler', () => {
  it('sınır 4: beşinci yıldız listeyi değiştirmez; çağrı hatasında iyimser liste geri alınır', async () => {
    let server = ['a', 'b', 'c', 'd'];
    const api = jest.fn(async (i: { favorite_ids: string[] }) => ({ favorite_ids: i.favorite_ids }));
    const store = createFavoritesStore({ api, serverList: () => server, friendIds: () => new Set(['a', 'b', 'c', 'd', 'e']) });
    await expect(store.getState().toggle('e')).resolves.toEqual({ ok: false, limit: true });
    expect(store.getState().error).toBe(FAVORITE_LIMIT_TEXT);
    expect(api).not.toHaveBeenCalled();

    await store.getState().toggle('b');
    expect(api).toHaveBeenLastCalledWith({ favorite_ids: ['a', 'c', 'd'] });
    server = ['a', 'c', 'd'];
    store.getState().profileChanged();
    expect(store.getState().optimistic).toBeNull();

    api.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'functions/unavailable' }));
    await expect(store.getState().move('d', -2)).resolves.toBe(false);
    expect(api).toHaveBeenLastCalledWith({ favorite_ids: ['d', 'a', 'c'] });
    expect(store.getState().optimistic).toBeNull();
    expect(store.getState().error).toBeTruthy();
  });
});

describe('Faz 6 push ve başsız benimseme', () => {
  it('push verisi: koordinatsız alanlar, bozuk veri atılır', () => {
    expect(parseF6Data({ type: 'quick_share_started', share_id: 's1', to_name: 'Ayşe', expires_at: String(T0 + HOUR) })).toEqual({
      type: 'quick_share_started',
      share_id: 's1',
      to_name: 'Ayşe',
      expires_at: T0 + HOUR,
    });
    expect(parseF6Data({ type: 'quick_share_started', share_id: 's1', to_name: 'Ayşe', expires_at: '' })).toMatchObject({ expires_at: null });
    expect(parseF6Data({ type: 'widget_refresh', from: 'ayse' })).toEqual({ type: 'widget_refresh', from: 'ayse' });
    expect(parseF6Data({ type: 'widget_refresh' })).toBeNull();
    expect(parseF6Data({ type: 'zone_event', from: 'x' })).toBeNull();
  });

  it('resume_tracking / quick_share_started → yalnızca adı geçen, aktif ve durdurulmamış paylaşım hedefe eklenir', () => {
    expect(wantedFromPush({ type: 'resume_tracking', session_ids: 'se1,se2', level: '1' })).toEqual({ sessionIds: ['se1', 'se2'], shareIds: [] });
    expect(wantedFromPush({ type: 'quick_share_started', share_id: 'sh9', to_name: 'A', expires_at: '' })).toEqual({ sessionIds: [], shareIds: ['sh9'] });
    expect(wantedFromPush({ type: 'widget_refresh', from: 'a' })).toBeNull();

    const doc = (o: Partial<ShareDoc>): ShareDoc => ({
      share_id: 'sh1',
      session_id: 'se1',
      sender_id: 'me',
      receiver_id: 'ayse',
      status: 'active',
      share_mode: 'timed',
      started_at: T0,
      expires_at: T0 + HOUR,
      ended_at: null,
      end_reason: null,
      version: 1,
      ...o,
    });
    const docs = [
      doc({}),
      doc({ share_id: 'sh2', session_id: 'other' }),
      doc({ share_id: 'sh3', status: 'ended' }),
      doc({ share_id: 'sh4', expires_at: T0 - 1 }),
      doc({ share_id: 'sh5' }),
      doc({ share_id: 'sh6' }),
    ];
    const out = selectAdoptableShares(docs, {
      uid: 'me',
      wanted: { sessionIds: ['se1'], shareIds: [] },
      have: new Set(['sh6']),
      blocked: (id) => id === 'sh5',
      now: T0 + MINUTE,
    });
    expect(out).toEqual([{ share_id: 'sh1', receiver_id: 'ayse', share_mode: 'timed', expires_at: T0 + HOUR, session_id: 'se1', started_at: T0, version: 1 }]);
  });

  it('bildirimdeki "Durdur": yalnızca o kişiye açık oturum durur; çok kişilikse dokunulmaz; liste gelince bulunur', async () => {
    const resp = (action: string, share_id = 'me_ayse') => ({
      actionIdentifier: action,
      notification: { request: { content: { data: { type: 'quick_share_started', share_id, to_name: 'Ayşe', expires_at: '' } } } },
    });
    const row = (share_id: string, session_id: string, receiver_id: string) => ({ share_id, session_id, receiver_id, status: 'active' as const });
    let list = [row('me_ayse', 'se1', 'ayse')];
    const stop = jest.fn(async () => true);
    const deps = { shares: () => list, stop, sleep: async () => undefined, waitMs: 1_000 };
    expect(await handleQuickShareResponse(resp('expo.modules.notifications.actions.DEFAULT'), deps)).toBeNull();
    expect(await handleQuickShareResponse(resp('QUICK_SHARE_STOP'), deps)).toBe('stopped');
    expect(stop).toHaveBeenCalledWith('se1');
    list = [row('me_ayse', 'se2', 'ayse'), row('me_can', 'se2', 'can')];
    expect(await handleQuickShareResponse(resp('QUICK_SHARE_STOP'), deps)).toBe('not_solo');
    expect(stop).toHaveBeenCalledTimes(1);
    let calls = 0;
    const late = { ...deps, shares: () => (++calls > 3 ? [row('me_ayse', 'se3', 'ayse')] : []) };
    expect(await handleQuickShareResponse(resp('QUICK_SHARE_STOP'), late)).toBe('stopped');
    expect(await handleQuickShareResponse(resp('QUICK_SHARE_STOP', 'yok'), { ...deps, shares: () => [] })).toBe('not_found');
  });
});
