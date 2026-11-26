/**
 * Faz 9 mobil veri katmanı (ana yollar): fotoğraf önbelleği / proofStore süresi, hedef yaklaşma tetiği → tek
 * `approach_report`, Güvenli Dönüş evreleri + check-in, SMS yedeği onayı + numaralar, çevrimdışı SOS kararı + SMS.
 */
import { makeDestination, NOTIFICATION_CATEGORIES_F9, uuidV4, type EpochMs, type SafeReturnDoc, type SosAlert, type SosSendRequest } from '@konum/core';
import { KonumError } from '../src/lib/errors';
import { createF9Hooks } from '../src/services/location/f9Hooks';
import { __resetSafeReturnActionsForTests, handleSafeReturnResponse, SAFE_RETURN_ACTION_TEXT } from '../src/services/notifications/safeReturnActions';
import { createProofCache, memoryProofBlobStore } from '../src/services/proof/cache';
import type { PersistedDestination, PersistedProof, PersistedSafeReturn } from '../src/state/persist';
import { createProofStore } from '../src/state/proofStore';
import { createSafeReturnStore } from '../src/state/safeReturnStore';
import { createSmsFallbackStore } from '../src/state/smsFallbackStore';
import { createSosStore } from '../src/state/sosStore';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

describe('fotoğraf önbelleği ve proofStore', () => {
  it('önbellek: süresi dolan kopya get/sweep ile silinir', async () => {
    let t = NOW;
    const blobs = memoryProofBlobStore();
    const cache = createProofCache(blobs, () => t);
    const e = await cache.put({ owner_id: 'ayse_1', proof_id: 'p1', expires_at: NOW + 60 * MIN }, 'QUJD');
    expect(e?.uri).toBeTruthy();
    expect(cache.get('ayse_1', 'p1')).not.toBeNull();
    t = NOW + 61 * MIN;
    expect(cache.get('ayse_1', 'p1')).toBeNull();
    await cache.sweep();
    expect(blobs.size()).toBe(0);
  });

  it('addPhoto → kayıt + önbellek; süre dolunca tick fotoğrafı ve kaydı kaldırır; eski çekim reddedilir', async () => {
    let t = NOW;
    let persisted: PersistedProof | null = null;
    const blobs = memoryProofBlobStore();
    const cache = createProofCache(blobs, () => t);
    const proofCreate = jest.fn(async (req: { captured_at: number; width: number; height: number }) => ({
      proof: { proof_id: 'p1', owner_id: 'me', caption: null, width: req.width, height: req.height, position: null, captured_at: req.captured_at, expires_at: t + 60 * MIN },
      replaced_proof_id: null,
      server_now: t,
    }));
    const store = createProofStore({
      api: { proofCreate, proofGet: jest.fn(), proofDelete: jest.fn() } as never,
      now: () => t,
      offsetMs: () => 0,
      myUid: () => 'me',
      encode: async () => ({ base64: 'QUJD', width: 1280, height: 960, bytes: 3 }),
      cache: () => cache,
      loadPersisted: async () => persisted,
      savePersisted: async (v) => {
        persisted = v;
      },
      position: async () => null,
    });

    const stale = await store.getState().addPhoto({ base64: 'x', width: 10, height: 10, captured_at: NOW - 10 * MIN });
    expect(stale).toEqual({ ok: false, error: expect.objectContaining({ code: 'proof_stale_capture' }) });
    expect(proofCreate).not.toHaveBeenCalled();

    const r = await store.getState().addPhoto({ base64: 'x', width: 10, height: 10, captured_at: NOW - 1_000 });
    expect(r).toEqual({ ok: true, proof_id: 'p1' });
    expect(store.getState().mine).toMatchObject({ proof_id: 'p1', expires_at: NOW + 60 * MIN });
    expect(persisted).toMatchObject({ uid: 'me', proof_id: 'p1' });
    expect(blobs.size()).toBe(1);

    t = NOW + 60 * MIN + 1;
    await store.getState().tick();
    expect(store.getState().mine).toBeNull();
    expect(persisted).toBeNull();
    expect(blobs.size()).toBe(0);
  });
});

describe('hedef yaklaşma (f9Hooks)', () => {
  it('200 m halkasına girince bir kez tetiklenir → approach_report tek çağrı', async () => {
    const center = { lat: 41.0, lng: 29.0 };
    let dest: PersistedDestination | null = {
      uid: 'me',
      destination: makeDestination({ kind: 'point', name: 'Ev', center, now: NOW }),
      approach: {},
      pending_report: null,
      last_report: null,
    };
    const approachReport = jest.fn(async () => ({ status: 'sent' as const, notified_count: 1, server_now: NOW }));
    const hooks = createF9Hooks({
      loadProof: async () => null,
      loadDestination: async () => dest,
      saveDestination: async (v) => {
        dest = v;
      },
      loadSafeReturn: async () => null,
      saveSafeReturn: async () => undefined,
      loadLastFix: async () => null,
      approach: { approachReport },
      safeReturn: { safeReturnUpdate: jest.fn(), safeReturnCheckIn: jest.fn() },
      isOnline: () => true,
      isHeld: () => false,
      newOpId: uuidV4,
      cancelLocal: async () => undefined,
      scheduleLocal: async () => undefined,
      callTimeoutMs: 1_000,
    });
    const sample = (dLat: number, at: EpochMs) =>
      hooks.onSample({
        uid: 'me',
        sample: { lat: center.lat + dLat, lng: center.lng, accuracy: 8, speed_mps: 1.4, timestamp: at },
        activity: 'walking',
        now: at,
        sessionIds: ['s1'],
        battery_pct: 50,
        is_charging: false,
      });

    const far = await sample(0.005, NOW); // ~550 m: kurulur
    expect(far.dest_state).toBe('en_route');
    const near = await sample(0.0009, NOW + 10_000); // ~100 m
    await sample(0.0008, NOW + 20_000);
    await sample(0.0007, NOW + 30_000);
    expect(near).toMatchObject({ dest_name: 'Ev', dest_state: 'near' });
    expect(approachReport).toHaveBeenCalledTimes(1);
    expect(approachReport.mock.calls[0]).toEqual([expect.objectContaining({ session_ids: ['s1'], dest_name: 'Ev', dest_kind: 'point' })]);
    expect(dest?.pending_report).toBeNull();
    expect(dest?.last_report).toMatchObject({ status: 'sent', notified_count: 1 });
  });
});

describe('safeReturnStore', () => {
  const docOf = (over: Partial<SafeReturnDoc> = {}): SafeReturnDoc => ({
    safe_return_id: 'sr1',
    owner_id: 'me',
    owner_name: 'Deniz',
    contact_ids: ['ayse'],
    destination: { kind: 'point', name: 'Ev', zone_id: null },
    duration_min: 30,
    started_at: NOW,
    due_at: NOW + 30 * MIN,
    grace_until: NOW + 32 * MIN,
    extend_count: 0,
    status: 'active',
    due_notified_at: null,
    last_fix: { lat: 41, lng: 29, accuracy: 10, timestamp: NOW, battery_pct: 40, is_charging: false },
    sos_id: null,
    time_zone: 'Europe/Istanbul',
    ended_at: null,
    created_at: NOW,
    updated_at: NOW,
    version: 1,
    ...over,
  });

  it('başlat → evreler (running → ending_soon → final_warning) → Güvendeyim: bitti, kayıt ve yerel bildirimler silinir', async () => {
    let t = NOW;
    let rec: PersistedSafeReturn | null = null;
    const schedule = jest.fn(async () => undefined);
    const cancelLocal = jest.fn(async () => undefined);
    const safeReturnCheckIn = jest.fn(async () => ({ safe_return: docOf({ status: 'checked_in', ended_at: t, version: 2 }), server_now: t }));
    const autoShare = jest.fn(async () => ({ needsGrant: [] as string[] }));
    const store = createSafeReturnStore({
      api: { safeReturnStart: jest.fn(async () => ({ safe_return: docOf(), notified_count: 1, server_now: NOW })), safeReturnUpdate: jest.fn(), safeReturnCheckIn, safeReturnExtend: jest.fn(), safeReturnCancel: jest.fn() } as never,
      now: () => t,
      offsetMs: () => 0,
      myUid: () => 'me',
      getFix: async () => ({ lat: 41, lng: 29, accuracy: 10, timestamp: NOW, battery_pct: 40, is_charging: false }),
      quickFix: async () => null,
      timeZone: () => 'Europe/Istanbul',
      load: async () => rec,
      save: async (v) => {
        rec = v;
      },
      schedule,
      cancelLocal,
      contactNames: () => 'Ayşe',
      zoneGeometry: () => null,
      autoShare,
      extendShare: async () => undefined,
      stopShare: async () => undefined,
      loadShare: async () => null,
      saveShare: async () => undefined,
      fetchDoc: async () => null,
      resolveSos: jest.fn(async () => true),
    });

    const r = await store.getState().start({ duration_min: 30, destination: { kind: 'point', name: 'Ev', center: { lat: 41.01, lng: 29.01 } }, contact_ids: ['ayse', 'me'] });
    expect(r).toEqual({ ok: true, safe_return_id: 'sr1' });
    await flush();
    expect(store.getState().phase).toBe('running');
    expect(rec).toMatchObject({ safe_return_id: 'sr1', status: 'active', destination: { center: { lat: 41.01, lng: 29.01 }, radius_m: 75 }, contact_label: 'Ayşe' });
    expect(schedule).toHaveBeenCalled();
    // Paylaşım alarm penceresini de kapsar (grace_until + 1 sa), alarm anında kesilmez.
    expect(autoShare).toHaveBeenCalledWith(['ayse'], NOW + 32 * MIN + 60 * MIN);

    t = NOW + 26 * MIN;
    store.getState().tick();
    expect(store.getState().phase).toBe('ending_soon');
    t = NOW + 30 * MIN + 30_000;
    store.getState().tick();
    expect(store.getState().phase).toBe('final_warning');
    expect(store.getState().leftMs).toBe(90_000);

    expect(await store.getState().checkIn()).toEqual({ ok: true });
    expect(safeReturnCheckIn).toHaveBeenCalledWith(expect.objectContaining({ safe_return_id: 'sr1', reason: 'safe' }));
    await flush();
    expect(store.getState().phase).toBe('ended');
    expect(store.getState().ended).toMatchObject({ safe_return_id: 'sr1', reason: 'checked_in' });
    expect(rec).toBeNull();
    expect(cancelLocal).toHaveBeenCalledWith('sr1');
  });

  function srDeps(over: Record<string, unknown> = {}) {
    let rec: PersistedSafeReturn | null = null;
    let share: { uid: string; safe_return_id: string; session_id: string } | null = null;
    const d = {
      api: { safeReturnStart: jest.fn(async () => ({ safe_return: docOf(), notified_count: 1, server_now: NOW })), safeReturnUpdate: jest.fn(), safeReturnCheckIn: jest.fn(), safeReturnExtend: jest.fn(), safeReturnCancel: jest.fn() },
      now: () => NOW + MIN,
      offsetMs: () => 0,
      myUid: () => 'me',
      getFix: async () => ({ lat: 41, lng: 29, accuracy: 10, timestamp: NOW, battery_pct: 40, is_charging: false }),
      quickFix: async () => null,
      timeZone: () => 'Europe/Istanbul',
      load: async () => rec,
      save: async (v: PersistedSafeReturn | null) => {
        rec = v;
      },
      schedule: async () => undefined,
      cancelLocal: async () => undefined,
      contactNames: () => 'Ayşe',
      zoneGeometry: () => null,
      autoShare: jest.fn(async () => ({ needsGrant: [] as string[], sessionId: 'sess1' })),
      extendShare: jest.fn(async () => undefined),
      stopShare: jest.fn(async () => undefined),
      loadShare: async () => share,
      saveShare: jest.fn(async (v: typeof share) => {
        share = v;
      }),
      fetchDoc: jest.fn(async () => null as SafeReturnDoc | null),
      resolveSos: jest.fn(async () => true),
      ...over,
    };
    return d;
  }
  const START = { duration_min: 30 as const, destination: { kind: 'point' as const, name: 'Ev', center: { lat: 41.01, lng: 29.01 } }, contact_ids: ['ayse'] };

  it('otomatik canlı paylaşım: "+15 dk" ile uzar, alarmda sürer, Güvendeyim ile durur', async () => {
    const d = srDeps();
    d.api.safeReturnExtend.mockResolvedValue({ safe_return: docOf({ due_at: NOW + 45 * MIN, grace_until: NOW + 47 * MIN, extend_count: 1, version: 2 }), server_now: NOW });
    const store = createSafeReturnStore(d as never);
    await store.getState().start(START);
    await flush();
    expect(d.saveShare).toHaveBeenCalledWith({ uid: 'me', safe_return_id: 'sr1', session_id: 'sess1' });

    expect(await store.getState().extend()).toEqual({ ok: true });
    await flush();
    expect(d.extendShare).toHaveBeenLastCalledWith('sess1', NOW + 47 * MIN + 60 * MIN);

    store.getState().applyDoc(docOf({ status: 'alarm', sos_id: 'sos9', ended_at: NOW + 47 * MIN, grace_until: NOW + 47 * MIN, version: 3 }));
    await flush();
    expect(d.stopShare).not.toHaveBeenCalled();

    expect(await store.getState().checkIn()).toEqual({ ok: true });
    await flush();
    expect(d.resolveSos).toHaveBeenCalledWith('sos9');
    expect(d.stopShare).toHaveBeenCalledWith('sess1');
    expect(store.getState().ended).toMatchObject({ reason: 'checked_in' });
  });

  it('Güvendeyim alarmla yarışırsa (safe_return_not_active): kayıt okunur, alarm SOS\'u kapatılır', async () => {
    const d = srDeps();
    d.api.safeReturnCheckIn.mockRejectedValue(new KonumError('safe_return_not_active'));
    d.fetchDoc.mockResolvedValue(docOf({ status: 'alarm', sos_id: 'sos9', ended_at: NOW + 32 * MIN, version: 3 }));
    const store = createSafeReturnStore(d as never);
    await store.getState().start(START);
    await flush();
    expect(await store.getState().checkIn()).toEqual({ ok: true });
    expect(d.fetchDoc).toHaveBeenCalledWith('sr1');
    expect(d.resolveSos).toHaveBeenCalledWith('sos9');
    expect(store.getState().error).toBeNull();
    expect(store.getState().ended).toMatchObject({ reason: 'checked_in' });
    expect(store.getState().current?.status).toBe('alarm');
  });
});

describe('smsFallbackStore', () => {
  it('açık onay olmadan açılmaz; numaralar E.164, tekrar / geçersiz reddedilir; cihazda saklanır', async () => {
    let stored: unknown = null;
    const store = createSmsFallbackStore({
      now: () => NOW,
      read: async () => stored,
      write: async (v) => {
        stored = v ? JSON.parse(JSON.stringify(v)) : null;
      },
      isAvailable: async () => true,
      pickContact: async () => ({ kind: 'cancelled' }) as never,
    });
    await store.getState().hydrate();
    expect(await store.getState().enable(false)).toBe(false);
    expect(store.getState().settings.enabled).toBe(false);
    expect(await store.getState().enable(true)).toBe(true);
    expect(store.getState().settings).toMatchObject({ enabled: true, decided_at: NOW });

    const a = await store.getState().addNumber({ label: 'Annem', phone: '0532 123 45 67', source: 'manual' });
    expect(a).toEqual({ ok: true, number: { label: 'Annem', e164: '+905321234567', source: 'manual' } });
    expect(await store.getState().addNumber({ label: 'Yine', phone: '+90 532 123 45 67', source: 'manual' })).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(await store.getState().addNumber({ label: 'Bozuk', phone: '12', source: 'manual' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(stored).toMatchObject({ enabled: true, numbers: [{ e164: '+905321234567' }] });

    await store.getState().removeNumber('+905321234567');
    expect(store.getState().settings.numbers).toEqual([]);
  });
});

describe('sosStore çevrimdışı (Faz 9)', () => {
  const LOC = { lat: 40.9862, lng: 29.0275, accuracy: 8, timestamp: NOW - 2_000 };
  const alertFrom = (req: SosSendRequest): SosAlert => ({
    sos_id: 'sos1',
    sender_id: 'me',
    sender_name: 'Deniz',
    recipient_ids: ['ayse'],
    status: 'active',
    resolve_reason: null,
    message: 'x',
    location: req.location,
    address: null,
    maps_url: 'https://maps',
    battery_pct: null,
    is_charging: null,
    route: null,
    created_at: NOW,
    updated_at: NOW,
    resolved_at: null,
    acks: {},
    update_count: 0,
  });
  const NUMBERS = [{ label: 'Annem', e164: '+905321234567', source: 'manual' as const }];

  function deps(sosSend: jest.Mock, over: Record<string, unknown> = {}) {
    return {
      api: { sosSend, emergencyContactsSet: jest.fn(), sosUpdate: jest.fn(), sosResolve: jest.fn(), sosAck: jest.fn() },
      now: () => NOW,
      myUid: () => 'me',
      getFix: async () => LOC,
      lastKnown: () => null,
      ensurePermission: async () => true,
      device: async () => ({ batteryLevel: 0.23, isCharging: false }),
      address: async () => null,
      autoShare: async () => undefined,
      onServerVisible: async () => undefined,
      sleep: async () => undefined,
      retryDelaysMs: [],
      offlineRetryWindowMs: 0,
      isOnline: () => false,
      waitOnline: async () => false,
      smsSettings: () => ({ enabled: true, numbers: NUMBERS }),
      smsAvailable: () => true,
      lastFix: async () => null,
      senderName: () => 'Deniz',
      safeReturnDest: () => null,
      composeSms: jest.fn(async () => 'sent' as const),
      ...over,
    };
  }

  it('bağlantı yok → unavailable ile erken döner, SMS önerilir; gövde son konum + pil; SMS uygulaması numaralarla açılır', async () => {
    const sosSend = jest.fn().mockRejectedValue(new KonumError('unavailable'));
    const d = deps(sosSend);
    const store = createSosStore(d as never);
    store.getState().setContactsFromProfile(['ayse']);
    const r = await store.getState().send();
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'unavailable' }) });
    expect(store.getState().offline).toBe('offer_sms');
    expect(store.getState().online).toBe(false);
    await flush();
    expect(store.getState().errorCode).toBe('unavailable');
    expect(store.getState().lastAttempt).toMatchObject({ location: LOC, battery_pct: 23 });

    const body = await store.getState().smsBody();
    expect(body).toContain('ACİL: Deniz tehlikede, internet yok.');
    expect(body).toContain('Pil %23');
    expect(body).toContain('https://maps.google.com/?q=40.986200,29.027500');

    expect(await store.getState().sendSms()).toBe('sent');
    expect(d.composeSms).toHaveBeenCalledWith(['+905321234567'], body);
  });

  it('SMS yedeği kapalıysa yalnızca nasıl açılacağı (sms_not_configured); çevrimiçi başarı → online', async () => {
    const offline = createSosStore(deps(jest.fn().mockRejectedValue(new KonumError('unavailable')), { smsSettings: () => ({ enabled: false, numbers: [] }) }) as never);
    offline.getState().setContactsFromProfile(['ayse']);
    await offline.getState().send();
    expect(offline.getState().offline).toBe('sms_not_configured');
    expect(await offline.getState().sendSms()).toBe('not_configured');
    await flush();

    const sosSend = jest.fn(async (req: SosSendRequest) => ({ sos: alertFrom(req), recipients: 1, server_now: NOW }));
    const online = createSosStore(deps(sosSend, { isOnline: () => true, waitOnline: async () => true }) as never);
    online.getState().setContactsFromProfile(['ayse']);
    expect(await online.getState().send()).toEqual({ ok: true, sos_id: 'sos1' });
    expect(online.getState()).toMatchObject({ offline: 'online', online: true, phase: 'active', errorCode: null });
  });

  it('resolve(sos_id): giden SOS henüz yüklenmemişse de sunucuda kapatır; hata başarı sayılmaz', async () => {
    const d = deps(jest.fn());
    const resolved = { ...alertFrom({ location: LOC } as SosSendRequest), sos_id: 'sos9', status: 'resolved' as const, resolve_reason: 'safe' as const, resolved_at: NOW };
    d.api.sosResolve.mockResolvedValueOnce({ sos: resolved, server_now: NOW }).mockRejectedValueOnce(new KonumError('unavailable'));
    const store = createSosStore(d as never);
    expect(store.getState().outgoing).toBeNull();
    expect(await store.getState().resolve('sos9')).toBe(true);
    expect(d.api.sosResolve).toHaveBeenCalledWith(expect.objectContaining({ sos_id: 'sos9' }));
    expect(store.getState().outgoing).toMatchObject({ sos_id: 'sos9', status: 'resolved' });
    expect(await store.getState().resolve('sos10')).toBe(false);
  });
});

describe('Güvenli Dönüş bildirim eylemi', () => {
  const response = (action: string) =>
    ({
      actionIdentifier: action,
      notification: { request: { identifier: 'n1', content: { data: { type: 'safe_return_local', kind: 'last_call', safe_return_id: 'sr1', op_ids: { safe: uuidV4(), extend: uuidV4() } } }, trigger: null } },
    }) as never;
  const alarmDoc = { safe_return_id: 'sr1', status: 'alarm', sos_id: 'sos9' } as SafeReturnDoc;
  const actionDeps = (over: Record<string, unknown> = {}) => ({
    checkIn: jest.fn().mockRejectedValue(new KonumError('safe_return_not_active')),
    extend: jest.fn(),
    fetchDoc: jest.fn(async () => alarmDoc as SafeReturnDoc | null),
    resolveSos: jest.fn(async () => ({})),
    notify: jest.fn(async () => undefined),
    apply: jest.fn(async () => undefined),
    dismiss: jest.fn(async () => undefined),
    notifyFailure: jest.fn(async () => undefined),
    clearLastResponse: () => undefined,
    newOpId: uuidV4,
    ...over,
  });
  beforeEach(() => __resetSafeReturnActionsForTests());

  it('alarmdan hemen sonra "Güvendeyim": alarm SOS\'u kapatılır ve kullanıcıya söylenir (sessiz geçilmez)', async () => {
    const d = actionDeps();
    const out = await handleSafeReturnResponse(response(NOTIFICATION_CATEGORIES_F9.actionSafe), d as never);
    expect(out).toMatchObject({ kind: 'sos_resolved' });
    expect(d.resolveSos).toHaveBeenCalledWith(expect.objectContaining({ sos_id: 'sos9' }));
    expect(d.notify).toHaveBeenCalledWith(SAFE_RETURN_ACTION_TEXT.alarmResolved);
    expect(d.dismiss).toHaveBeenCalledWith('n1');
  });

  it('SOS kapatılamaz / durum okunamazsa uyarı bildirimi', async () => {
    const d = actionDeps({ resolveSos: jest.fn().mockRejectedValue(new KonumError('unavailable')) });
    expect(await handleSafeReturnResponse(response(NOTIFICATION_CATEGORIES_F9.actionSafe), d as never)).toEqual({ kind: 'alarm_open' });
    expect(d.notify).toHaveBeenCalledWith(SAFE_RETURN_ACTION_TEXT.alarmOpen);
    __resetSafeReturnActionsForTests();
    const d2 = actionDeps({ fetchDoc: jest.fn(async () => null) });
    expect(await handleSafeReturnResponse(response(NOTIFICATION_CATEGORIES_F9.actionSafe), d2 as never)).toEqual({ kind: 'unknown' });
    expect(d2.notify).toHaveBeenCalledWith(SAFE_RETURN_ACTION_TEXT.unknown);
  });

  it('başka yoldan zaten bitmişse sessizce kaldırılır', async () => {
    const d = actionDeps({ fetchDoc: jest.fn(async () => ({ ...alarmDoc, status: 'checked_in', sos_id: null })) });
    expect(await handleSafeReturnResponse(response(NOTIFICATION_CATEGORIES_F9.actionSafe), d as never)).toEqual({ kind: 'ended' });
    expect(d.notify).not.toHaveBeenCalled();
    expect(d.resolveSos).not.toHaveBeenCalled();
  });
});
