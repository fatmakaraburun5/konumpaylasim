/**
 * Faz 3 mobil bağlantıları: izin planlayıcısı (core `nextPermissionStep` girdisi), alıcı durumu (son doğrulanmış
 * konum, "Bağlantısı kopmuş olabilir", eşitlenen iz), hareket etkinliği sarmalayıcısının güvenli yedeği,
 * push yardımcıları (düşük pil, resume_tracking).
 */
import { HOUR, MINUTE, type DeliveredLocation } from '@konum/core';
import type { ShareDoc } from '../src/lib/schemas';
import {
  __setNativeActivityModuleForTests,
  getActivityPermission,
  getLastActivity,
  isActivityModuleAvailable,
  parseActivityEvent,
  startActivityUpdates,
} from '../modules/konum-activity';
import {
  activeShareContext,
  buildPermissionInput,
  planPermissionStep,
  shareContextOf,
  type PermissionSnapshot,
} from '../src/features/permissions/permissionPlanner';
import { parseTrail } from '../src/services/firebase/liveRepo';
import {
  __setActivityFlagForTests,
  activityPermission,
  fromExpoMotionActivity,
  lastActivityEvent,
} from '../src/services/location/adaptive/activitySource';
import { batteryLowContent, pushType } from '../src/services/notifications/push';
import { BATTERY_LOW_NOTIFY, BatteryLowNotifyRequestSchema } from '../src/services/firebase/callables';
import { BatteryLowNotifyRequestSchema as CoreBatteryLowNotifyRequestSchema, CALLABLES, lowBatteryPushText } from '@konum/core';
import { selectVisibleIncoming } from '../src/state/incomingStore';

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);

describe('izin planlayıcısı (mobil girdi)', () => {
  const ios = { platform: 'ios' as const, osVersion: 17 };
  const android = { platform: 'android' as const, osVersion: 34 };
  const perms = (over: Partial<PermissionSnapshot> = {}): PermissionSnapshot => ({
    foreground: 'granted',
    foregroundCanAskAgain: true,
    background: 'undetermined',
    backgroundCanAskAgain: true,
    notifications: 'granted',
    preciseLocation: true,
    batteryOptimization: 'unrestricted',
    ...over,
  });
  const mem = { hasSeenRationale: {}, lastDeniedAt: {} };

  it('paylaşım seçiminden bağlam: süreli → süre, süresiz → null süre', () => {
    expect(shareContextOf({ kind: 'preset', preset: 'h1' }, NOW)).toMatchObject({ shareMode: 'timed', durationMs: HOUR });
    expect(shareContextOf({ kind: 'indefinite' }, NOW)).toMatchObject({ shareMode: 'indefinite', durationMs: null });
    expect(shareContextOf(null, NOW)).toEqual({ shareMode: null });
  });

  it("'unknown' izin durumu core'a 'undetermined' olarak gider", () => {
    const i = buildPermissionInput(perms({ foreground: 'unknown' }), mem, { shareMode: 'timed', durationMs: HOUR }, [], NOW, ios);
    expect(i.foreground).toBe('undetermined');
    expect(i.wentBackgroundDuringShare).toBe(false);
  });

  it('kısa paylaşım: yalnızca "Kullanırken" yeter, arka plan sorulmaz', () => {
    expect(planPermissionStep(perms({ foreground: 'undetermined' }), mem, { shareMode: 'timed', durationMs: HOUR }, [], NOW, ios)).toMatchObject({
      step: 'when_in_use',
      blocking: true,
    });
    expect(planPermissionStep(perms(), mem, { shareMode: 'timed', durationMs: HOUR }, [], NOW, ios).step).toBe('done');
  });

  it('süresiz (iOS): önce uygulama içi açıklama, sonra yükseltme penceresi; ret → 7 gün sorulmaz', () => {
    const ctx = { shareMode: 'indefinite' as const, durationMs: null };
    expect(planPermissionStep(perms(), mem, ctx, [], NOW, ios).step).toBe('always_rationale');
    const seen = { hasSeenRationale: { always: true }, lastDeniedAt: {} };
    expect(planPermissionStep(perms(), seen, ctx, ['always_rationale'], NOW, ios)).toMatchObject({ step: 'always_request', action: 'system_prompt' });
    const denied = { hasSeenRationale: { always: true }, lastDeniedAt: { background: NOW - 2 * 24 * HOUR } };
    expect(planPermissionStep(perms(), denied, ctx, [], NOW, ios).step).toBe('done');
  });

  it('haftalık (Android 14): ayarlardan "Her zaman izin ver", sonra pil optimizasyonu ipucu', () => {
    const ctx = { shareMode: 'weekly' as const, durationMs: 7 * 24 * HOUR };
    const seen = { hasSeenRationale: { always: true }, lastDeniedAt: {} };
    expect(planPermissionStep(perms({ batteryOptimization: 'optimized' }), seen, ctx, [], NOW, android)).toMatchObject({
      step: 'android_background_settings',
      action: 'open_settings',
    });
    expect(
      planPermissionStep(perms({ background: 'granted', batteryOptimization: 'optimized' }), seen, ctx, [], NOW, android),
    ).toMatchObject({ step: 'battery_optimization_hint', canUseGeofence: true });
    // Süreli paylaşımda pil ipucu YOK.
    expect(planPermissionStep(perms({ background: 'granted', batteryOptimization: 'optimized' }), seen, { shareMode: 'timed', durationMs: HOUR }, [], NOW, android).step).toBe(
      'done',
    );
  });

  it('kısa paylaşım sürerken arka plana gidildi → "Her zaman" önerilir', () => {
    const ctx = { shareMode: 'timed' as const, durationMs: HOUR, wentBackgroundDuringShare: true };
    expect(planPermissionStep(perms(), mem, ctx, [], NOW, ios).step).toBe('always_rationale');
  });

  it('süren paylaşımlardan en uzun bağlam seçilir', () => {
    expect(activeShareContext([], NOW)).toMatchObject({ shareMode: null });
    expect(
      activeShareContext(
        [
          { share_mode: 'timed', expires_at: NOW + HOUR },
          { share_mode: 'timed', expires_at: NOW + 10 * HOUR },
        ],
        NOW,
      ),
    ).toMatchObject({ shareMode: 'timed', durationMs: 10 * HOUR });
    expect(
      activeShareContext(
        [
          { share_mode: 'weekly', expires_at: NOW + 3 * 24 * HOUR },
          { share_mode: 'indefinite', expires_at: null },
        ],
        NOW,
        true,
      ),
    ).toMatchObject({ shareMode: 'indefinite', durationMs: null, wentBackgroundDuringShare: true });
  });
});

describe('alıcı durumu: son doğrulanmış konum + eşitlenen iz', () => {
  const share: ShareDoc = {
    share_id: 'ece_me',
    sender_id: 'ece',
    receiver_id: 'me',
    status: 'active',
    share_mode: 'indefinite',
    started_at: NOW - 3 * HOUR,
    expires_at: null,
  } as unknown as ShareDoc;
  const loc = (over: Partial<DeliveredLocation> = {}): DeliveredLocation =>
    ({
      v: 1,
      share_id: 'ece_me',
      sender_id: 'ece',
      lat: 41,
      lng: 29,
      accuracy: 10,
      speed_mps: null,
      heading: null,
      activity_state: 'still',
      battery_pct: 42,
      is_charging: false,
      timestamp: NOW - 30_000,
      server_ts: NOW - 29_000,
      expires_at: null,
      share_mode: 'indefinite',
      hb: 60_000,
      ...over,
    }) as DeliveredLocation;

  it('taze paket: canlı, iz yok', () => {
    const [f] = selectVisibleIncoming({ shares: { ece_me: share }, locations: { ece_me: loc() }, hiddenSenders: {} }, NOW);
    expect(f!.verified).toMatchObject({ status: 'live', battery_pct: 42, fromQueue: false });
    expect(f!.trail).toEqual([]);
  });

  it('beklenen aralığın çok üstünde sessizlik → "Bağlantısı kopmuş olabilir" + son doğrulanmış koordinat/zaman/pil', () => {
    const [f] = selectVisibleIncoming(
      { shares: { ece_me: share }, locations: { ece_me: loc({ timestamp: NOW - 20 * MINUTE, server_ts: NOW - 20 * MINUTE }) }, hiddenSenders: {} },
      NOW,
    );
    expect(f!.verified!.status).toBe('offline_suspected');
    expect(f!.verified!.statusText).toBe('Bağlantısı kopmuş olabilir');
    expect(f!.verified!.label).toContain('%42');
  });

  it('kuyruktan gelen paket + eşitlenen iz: paylaşım öncesi noktalar atılır', () => {
    const trail = parseTrail({
      [`${NOW - 10 * MINUTE}-000`]: { lat: 41.01, lng: 29, accuracy: 15, timestamp: NOW - 10 * MINUTE, server_ts: NOW - MINUTE, battery_pct: 40, q: 1 },
      [`${NOW - 5 * MINUTE}-001`]: { lat: 41.02, lng: 29, accuracy: 15, timestamp: NOW - 5 * MINUTE, server_ts: NOW - MINUTE, battery_pct: 39, q: 1 },
      [`${NOW - 5 * HOUR}-002`]: { lat: 40, lng: 29, accuracy: 15, timestamp: NOW - 5 * HOUR, server_ts: NOW - 5 * HOUR, battery_pct: 80, q: 1 },
      bozuk: { lat: 'x' },
    });
    expect(trail).toHaveLength(3);
    const [f] = selectVisibleIncoming(
      {
        shares: { ece_me: share },
        locations: { ece_me: loc({ q: 1, timestamp: NOW - 2 * MINUTE, server_ts: NOW - 30_000 } as Partial<DeliveredLocation>) },
        hiddenSenders: {},
        trails: { ece_me: trail },
      },
      NOW,
    );
    expect(f!.trail!.map((p) => p.lat)).toEqual([41.01, 41.02]);
    expect(f!.verified!.fromQueue).toBe(true);
  });
});

describe('hareket etkinliği: yerel modül yoksa güvenli yedek', () => {
  afterEach(() => {
    __setNativeActivityModuleForTests(undefined);
    __setActivityFlagForTests(null);
  });

  it('olay doğrulama: bozuk olay yok sayılır', () => {
    expect(parseActivityEvent({ type: 'automotive', confidence: 'high', at: 1_700_000_000_000 })).toEqual({ type: 'automotive', confidence: 'high', at: 1_700_000_000_000 });
    expect(parseActivityEvent({ type: 'flying', confidence: 'high', at: 1 })).toBeNull();
    expect(parseActivityEvent(null)).toBeNull();
  });

  it('modül yok: kullanılamaz, olay yok, izin "restricted" (jest = iOS dışı yedek yok)', async () => {
    __setNativeActivityModuleForTests(null);
    __setActivityFlagForTests(true);
    expect(isActivityModuleAvailable()).toBe(false);
    expect(getLastActivity()).toBeNull();
    expect(await getActivityPermission()).toBe('restricted');
    expect(await startActivityUpdates(() => undefined)).toBeNull();
    expect(lastActivityEvent(0)).toBeNull();
  });

  it('bayrak kapalıysa modül olsa da kullanılmaz; açıksa son olay sunucu saatine çevrilir', async () => {
    const fake = {
      isAvailable: () => true,
      getPermissionStatusAsync: async () => ({ status: 'granted' }),
      requestPermissionAsync: async () => 'granted',
      startAsync: async () => true,
      stopAsync: async () => undefined,
      getLastActivity: () => ({ type: 'walking', confidence: 'medium', at: 1_000 }),
      addListener: () => ({ remove: () => undefined }),
    };
    __setNativeActivityModuleForTests(fake);
    __setActivityFlagForTests(false);
    expect(lastActivityEvent(500)).toBeNull();
    expect(await activityPermission()).toBe('restricted');
    __setActivityFlagForTests(true);
    expect(lastActivityEvent(500)).toEqual({ type: 'activity', activity: 'walking', confidence: 'medium', at: 1_500 });
    expect(await activityPermission()).toBe('granted');
  });

  it('expo-location (iOS ön plan) nesnesi → en hızlı algılanan etkinlik', () => {
    expect(fromExpoMotionActivity({ activities: { walking: { detected: true, confidence: 1 }, automotive: { detected: true, confidence: 2 } }, timestamp: 5 })).toEqual({
      type: 'automotive',
      confidence: 'high',
      at: 5,
    });
    expect(fromExpoMotionActivity({ activities: { stationary: { detected: true, confidence: 0 } }, timestamp: 5 })).toMatchObject({ type: 'still', confidence: 'low' });
    expect(fromExpoMotionActivity({ activities: {} })).toBeNull();
  });
});

describe('push yardımcıları', () => {
  it('düşük pil: sunucu metni varsa o, yoksa rozet; koordinat yok', () => {
    expect(pushType({ data: { type: 'resume_tracking', session_ids: 's1' } })).toBe('resume_tracking');
    expect(pushType({})).toBeNull();
    expect(batteryLowContent({ data: { type: 'battery_low', share_id: 'x', battery_pct: '14' } })).toEqual({
      title: 'Arkadaşının pili azaldı',
      body: 'Pil %14. Konum daha seyrek güncellenecek.',
    });
    expect(batteryLowContent({ data: { type: 'battery_low', battery_pct: '14' }, notification: { title: 'Ece pili azaldı (%14)', body: 'b' } })).toEqual({
      title: 'Ece pili azaldı (%14)',
      body: 'b',
    });
    expect(batteryLowContent({ data: { type: 'expiry' } })).toBeNull();
    // Yedek metin core `lowBatteryPushText` ile aynı (backend FCM ve web görüntüleyici de bunu kullanır).
    expect(batteryLowContent({ data: { type: 'battery_low', battery_pct: '9' } })).toEqual(lowBatteryPushText('', 9));
  });

  it('battery_low_notify adı ve şeması core sözleşmesinden', () => {
    expect(BATTERY_LOW_NOTIFY).toBe(CALLABLES.batteryLowNotify);
    expect(BatteryLowNotifyRequestSchema).toBe(CoreBatteryLowNotifyRequestSchema);
  });
});
