/**
 * Faz 3: uyarlamalı takip — matris satırı değişimi (debounce / hız sınırı / uyanış), uyku çiti kur/kaldır,
 * çit çıkışında anında uyanış, düşük pil tetikleyicisinin oturum başına bir kez çalışması, OS seçenekleri.
 */
import { MINUTE, SECOND, type MotionEvent, type TrackingPlanRow } from '@konum/core';
import {
  APPLY_DEBOUNCE_MS,
  decideApply,
  initialSnapshot,
  MIN_REAPPLY_MS,
  stepAdaptive,
  stepLowBattery,
  type AdaptiveContext,
  type AdaptiveSnapshot,
} from '../src/services/location/adaptive/adaptiveCore';
import { createAdaptiveController, type AdaptiveEngineIO, type AdaptiveStorage } from '../src/services/location/adaptive/adaptiveController';
import { activityTypeFor, audienceText, modeHint, serviceTitleFor, toPlanTaskOptions } from '../src/services/location/adaptive/planOptions';

const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);
const HOME = { lat: 41.0082, lng: 28.9784 };

const fix = (at: number, speed: number | null, d = 0, accuracy = 10): MotionEvent => ({
  type: 'fix',
  lat: HOME.lat + d,
  lng: HOME.lng,
  accuracy,
  speed_mps: speed,
  at,
});
const ctx = (now: number, over: Partial<AdaptiveContext> = {}): AdaptiveContext => ({
  now,
  appPhase: 'background',
  batteryPct: 60,
  isCharging: false,
  canUseGeofence: true,
  ...over,
});

/** Sabit bekleme: aynı noktada 0 hızla 5 dk boyunca dakikada bir örnek. */
function settle(s: AdaptiveSnapshot, from: number, over: Partial<AdaptiveContext> = {}) {
  let snap = s;
  let last = stepAdaptive(snap, [], ctx(from, over));
  for (let t = from; t <= from + 5 * MINUTE; t += MINUTE) {
    last = stepAdaptive(snap, [fix(t, 0)], ctx(t, over));
    snap = last.snapshot;
  }
  return last;
}

describe('stepAdaptive: hareket → matris satırı', () => {
  it('yürüme hızındaki ilk örnek: walking; araç hızı (dwell sonrası) driving', () => {
    let s = initialSnapshot(T0);
    let r = stepAdaptive(s, [fix(T0, 1.4)], ctx(T0));
    expect(r.motion).toBe('walking');
    s = r.snapshot;
    // Yükseltme bekleme süresi (10 sn) dolmadan bant değişmez.
    r = stepAdaptive(s, [fix(T0 + 5 * SECOND, 12, 0.001)], ctx(T0 + 5 * SECOND));
    expect(r.motion).toBe('walking');
    r = stepAdaptive(r.snapshot, [fix(T0 + 20 * SECOND, 12, 0.003)], ctx(T0 + 20 * SECOND));
    expect(r.motion).toBe('driving');
    expect(r.transitions.map((x) => x.to)).toEqual(['driving']);
    expect(r.bgPlan.row.osIntervalMs).toBeGreaterThan(0);
    expect(r.bgPlan.appPhase).toBe('background');
  });

  it('aynı OS etkinliği ve geç gelen eski ölçüm makineyi geri sarmaz', () => {
    const s = stepAdaptive(initialSnapshot(T0), [fix(T0 + 10 * SECOND, 1.4)], ctx(T0 + 10 * SECOND)).snapshot;
    const r = stepAdaptive(s, [fix(T0, 0)], ctx(T0 + 11 * SECOND));
    expect(r.snapshot.machine.lastFix?.at).toBe(T0 + 10 * SECOND);
    const act: MotionEvent = { type: 'activity', activity: 'automotive', confidence: 'high', at: T0 + 12 * SECOND };
    const a = stepAdaptive(r.snapshot, [act], ctx(T0 + 12 * SECOND));
    const b = stepAdaptive(a.snapshot, [act], ctx(T0 + 13 * SECOND));
    expect(b.snapshot.lastActivityAt).toBe(T0 + 12 * SECOND);
    expect(b.transitions).toEqual([]);
  });

  it('sabit bekleme: stationary + GPS kapalı satır + uyku çiti kurulur', () => {
    const r = settle(initialSnapshot(T0), T0);
    expect(r.motion).toBe('stationary');
    expect(r.bgPlan.row.gps).toBe('off');
    expect(r.bgPlan.row.useSleepGeofence).toBe(true);
    expect(r.fenceOp).toMatchObject({ set: { lat: HOME.lat, lng: HOME.lng } });
    const fence = (r.fenceOp as { set: { radiusM: number } }).set;
    expect(fence.radiusM).toBeGreaterThanOrEqual(100);
    expect(fence.radiusM).toBeLessThanOrEqual(150);
  });

  it('çit izni yoksa çit kurulmaz, sabit satırı GPS’siz seyrek güncellemeye düşer', () => {
    const r = settle(initialSnapshot(T0), T0, { canUseGeofence: false });
    expect(r.motion).toBe('stationary');
    expect(r.fenceOp).toBeNull();
    expect(r.bgPlan.row.useSleepGeofence).toBe(false);
  });

  it('çit çıkışı: unknown → GPS açık satır, kayıtlı çit kaldırılır', () => {
    const still = settle(initialSnapshot(T0), T0);
    const withFence = { ...still.snapshot, fence: (still.fenceOp as { set: AdaptiveSnapshot['fence'] }).set };
    const at = T0 + 30 * MINUTE;
    const r = stepAdaptive(withFence, [{ type: 'geofence_exit', at }], ctx(at));
    expect(r.motion).toBe('unknown');
    expect(r.bgPlan.row.gps).not.toBe('off');
    expect(r.fenceOp).toEqual({ clear: true });
  });
});

describe('decideApply: OS isteği yeniden başlatma kuralları', () => {
  const row = (gps: TrackingPlanRow['gps']) => ({ row: { gps } as TrackingPlanRow, battery: 'normal' as const });

  it('ilk uygulama hemen; aynı anahtar tekrar uygulanmaz', () => {
    expect(decideApply({ applied: null, pending: null }, 'a', row('high'), T0, true)).toMatchObject({ apply: true, reason: 'first' });
    expect(decideApply({ applied: { key: 'a', at: T0, sleeping: false }, pending: null }, 'a', row('high'), T0 + 1, true)).toMatchObject({ apply: false, reason: 'same' });
  });

  it('bant titremesi: 20 sn debounce, sonra son uygulamadan 60 sn hız sınırı, sonra settled', () => {
    const applied = { key: 'walk', at: T0, sleeping: false };
    const d1 = decideApply({ applied, pending: null }, 'drive', row('high'), T0 + 10 * SECOND, true);
    expect(d1).toMatchObject({ apply: false, reason: 'debounce', pending: { key: 'drive', since: T0 + 10 * SECOND } });
    const d2 = decideApply({ applied, pending: d1.pending }, 'drive', row('high'), T0 + 10 * SECOND + APPLY_DEBOUNCE_MS, true);
    expect(d2).toMatchObject({ apply: false, reason: 'rate_limited' });
    const d3 = decideApply({ applied, pending: d1.pending }, 'drive', row('high'), T0 + MIN_REAPPLY_MS, true);
    expect(d3).toMatchObject({ apply: true, reason: 'settled' });
    // Aday değişirse bekleme baştan başlar.
    const d4 = decideApply({ applied, pending: d1.pending }, 'run', row('high'), T0 + MIN_REAPPLY_MS, true);
    expect(d4).toMatchObject({ apply: false, reason: 'debounce', pending: { key: 'run' } });
  });

  it('uykudan uyanış ve kritik pil beklemeden uygulanır', () => {
    const sleeping = { key: 'still', at: T0, sleeping: true };
    expect(decideApply({ applied: sleeping, pending: null }, 'walk', row('balanced'), T0 + 1, true)).toMatchObject({ apply: true, reason: 'wake' });
    const awake = { key: 'walk', at: T0, sleeping: false };
    expect(decideApply({ applied: awake, pending: null }, 'crit', { row: { gps: 'low' } as TrackingPlanRow, battery: 'critical' }, T0 + 1, true)).toMatchObject({
      apply: true,
      reason: 'critical',
    });
  });

  it('platform izin vermiyorsa (Android arka planı) bekler, aday korunur', () => {
    const d = decideApply({ applied: { key: 'a', at: T0, sleeping: false }, pending: null }, 'b', row('high'), T0, false);
    expect(d).toMatchObject({ apply: false, reason: 'cannot_reconfigure', pending: { key: 'b', since: T0 } });
  });
});

describe('stepLowBattery: %15 tetikleyicisi', () => {
  it('oturum başına bir kez; şarj/≥%20 sonrası yeniden kurulur (rearmed), biten oturum atılır', () => {
    let st = stepLowBattery({}, ['s:a', 's:b'], 16, false, T0).next;
    let r = stepLowBattery(st, ['s:a', 's:b'], 14, false, T0 + MINUTE);
    expect(r.fired.sort()).toEqual(['s:a', 's:b']);
    st = r.next;
    r = stepLowBattery(st, ['s:a', 's:b'], 12, false, T0 + 2 * MINUTE);
    expect(r.fired).toEqual([]);
    r = stepLowBattery(r.next, ['s:a'], 13, true, T0 + 3 * MINUTE);
    expect(r.rearmed).toEqual(['s:a']);
    expect(Object.keys(r.next)).toEqual(['s:a']);
    // Pil bilinmiyorsa (web / okuma hatası) hiçbir şey tetiklenmez.
    expect(stepLowBattery({}, ['s:a'], null, null, T0).fired).toEqual([]);
  });
});

describe('createAdaptiveController', () => {
  const memStorage = (): AdaptiveStorage & { value: AdaptiveSnapshot | null } => {
    const s = {
      value: null as AdaptiveSnapshot | null,
      load: async (now: number) => s.value ?? initialSnapshot(now),
      save: async (v: AdaptiveSnapshot) => {
        s.value = v;
      },
      clear: async () => {
        s.value = null;
      },
    };
    return s;
  };
  const io = (canReconfigure = true) => {
    const x = {
      canReconfigureNow: jest.fn(() => canReconfigure),
      startBackground: jest.fn(async () => undefined),
      applyPlan: jest.fn<Promise<void>, Parameters<NonNullable<AdaptiveEngineIO['applyPlan']>>>(async () => undefined),
      setSleepGeofence: jest.fn<Promise<void>, Parameters<NonNullable<AdaptiveEngineIO['setSleepGeofence']>>>(async () => undefined),
    };
    return x;
  };
  const notification = { title: 'Konumun paylaşılıyor · Süresiz', body: '1 kişiyle' };

  it('sabit bekleme → çit ÖNCE kurulur; çit çıkışı → çit kaldırılır ve GPS hemen açılır (wake)', async () => {
    const storage = memStorage();
    const engine = io();
    const c = createAdaptiveController({ io: () => engine, storage });
    const first = await c.observe({ events: [fix(T0, 1.4)], ctx: ctx(T0), sessionKeys: ['s:a'], notification });
    expect(first.apply).toMatchObject({ apply: true, reason: 'first' });
    expect(engine.applyPlan).toHaveBeenCalledTimes(1);

    for (let t = T0 + MINUTE; t <= T0 + 6 * MINUTE; t += MINUTE) {
      await c.observe({ events: [fix(t, 0)], ctx: ctx(t), sessionKeys: ['s:a'], notification });
    }
    expect(storage.value?.machine.state).toBe('stationary');
    expect(engine.setSleepGeofence).toHaveBeenCalledWith(expect.objectContaining({ lat: HOME.lat, lng: HOME.lng }));
    expect(storage.value?.fence).not.toBeNull();
    // Uykuya geçiş debounce ile uygulanır (en geç ~20 sn + 60 sn sonra).
    await c.observe({ events: [], ctx: ctx(T0 + 9 * MINUTE), sessionKeys: ['s:a'], notification });
    expect(storage.value?.applied?.sleeping).toBe(true);
    const sleepRow = engine.applyPlan.mock.calls.at(-1)![0];
    expect(sleepRow.gps).toBe('off');
    expect(engine.applyPlan.mock.calls.at(-1)![2].body).toContain('Hareketsiz');

    const n = engine.applyPlan.mock.calls.length;
    const wake = await c.observe({ events: [{ type: 'geofence_exit', at: T0 + 30 * MINUTE }], ctx: ctx(T0 + 30 * MINUTE), sessionKeys: ['s:a'], notification });
    expect(wake.motion).toBe('unknown');
    expect(wake.apply).toMatchObject({ apply: true, reason: 'wake' });
    expect(engine.applyPlan).toHaveBeenCalledTimes(n + 1);
    expect(engine.setSleepGeofence).toHaveBeenLastCalledWith(null);
    expect(storage.value?.fence).toBeNull();
  });

  it('Android arka planı: yeniden yapılandırılamıyorsa OS isteğine dokunmaz, aday bekler', async () => {
    const storage = memStorage();
    const engine = io(false);
    const c = createAdaptiveController({ io: () => engine, storage });
    const r = await c.observe({ events: [fix(T0, 1.4)], ctx: ctx(T0), sessionKeys: [], notification });
    expect(r.apply).toMatchObject({ apply: false, reason: 'cannot_reconfigure' });
    expect(engine.applyPlan).not.toHaveBeenCalled();
    expect(storage.value?.pending).not.toBeNull();
  });

  it('applyPlan yoksa (web) Faz 1 startBackground; hata → failed ve aday korunur; reset çiti kaldırır', async () => {
    const storage = memStorage();
    const engine = { canReconfigureNow: () => true, startBackground: jest.fn(async () => undefined) };
    const c = createAdaptiveController({ io: () => engine, storage });
    await c.observe({ events: [fix(T0, 1.4)], ctx: ctx(T0), sessionKeys: [], notification });
    expect(engine.startBackground).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) }), expect.any(String));

    const failing = io();
    failing.applyPlan.mockRejectedValueOnce(new Error('fgs'));
    const c2 = createAdaptiveController({ io: () => failing, storage: memStorage() });
    const r = await c2.observe({ events: [fix(T0, 1.4)], ctx: ctx(T0), sessionKeys: [], notification });
    expect(r.apply).toMatchObject({ apply: false, reason: 'failed' });

    storage.value = { ...storage.value!, fence: { ...HOME, radiusM: 120 } };
    const withFence = io();
    const c3 = createAdaptiveController({ io: () => withFence, storage });
    await c3.reset();
    expect(withFence.setSleepGeofence).toHaveBeenCalledWith(null);
    expect(storage.value).toBeNull();
  });

  it('düşük pil: gözlem başına tetiklenen oturumlar döner, ikinci okumada tekrar tetiklenmez', async () => {
    const storage = memStorage();
    const c = createAdaptiveController({ io: () => io(), storage });
    const a = await c.observe({ events: [fix(T0, 1.4)], ctx: ctx(T0, { batteryPct: 14 }), sessionKeys: ['s:a', 'l:x'], notification });
    expect(a.lowBatteryFired.sort()).toEqual(['l:x', 's:a']);
    const b = await c.observe({ events: [fix(T0 + MINUTE, 1.4, 0.0005)], ctx: ctx(T0 + MINUTE, { batteryPct: 13 }), sessionKeys: ['s:a', 'l:x'], notification });
    expect(b.lowBatteryFired).toEqual([]);
  });
});

describe('planOptions: matris satırı → expo-location', () => {
  const row: TrackingPlanRow = {
    gps: 'high',
    osIntervalMs: 5_000,
    distanceFilterM: 15,
    deferMs: 30_000,
    sendMinIntervalMs: 10_000,
    heartbeatMs: 60_000,
    useSleepGeofence: false,
    significantChanges: false,
  };

  it('iOS: activityType, mavi gösterge, otomatik duraklatma kapalı, ertelenmiş teslim', () => {
    const o = toPlanTaskOptions(row, 'driving', { title: 't', body: 'b' }, 'ios');
    expect(o).toMatchObject({ pausesUpdatesAutomatically: false, showsBackgroundLocationIndicator: true, distanceInterval: 15 });
    expect(o.deferredUpdatesInterval).toBe(30_000);
    expect(activityTypeFor('walking')).not.toBe(activityTypeFor('driving'));
  });

  it('Android: kalıcı bildirimli ön plan servisi, uyku satırı = canlı tutma (kapatılmaz)', () => {
    const sleep: TrackingPlanRow = { ...row, gps: 'off', osIntervalMs: 0, deferMs: 0, heartbeatMs: 15 * MINUTE, useSleepGeofence: true };
    const o = toPlanTaskOptions(sleep, 'stationary', { title: 'Konumun paylaşılıyor · Süresiz', body: '2 kişiyle' }, 'android');
    expect(o.foregroundService).toMatchObject({ notificationTitle: 'Konumun paylaşılıyor · Süresiz', notificationBody: '2 kişiyle', killServiceOnDestroy: false });
    expect(o.timeInterval).toBeGreaterThanOrEqual(60_000);
    expect(o.distanceInterval).toBe(0);
  });

  it('bildirim başlığı: en geç biten süreli paylaşımın saati ya da "Süresiz"', () => {
    const at = new Date(2026, 10, 24, 14, 45).getTime();
    expect(serviceTitleFor([at])).toMatch(/^Konumun paylaşılıyor · 14:45.e kadar$/);
    expect(serviceTitleFor([at, null])).toBe('Konumun paylaşılıyor · Süresiz');
    expect(audienceText(2, 1)).toBe('2 kişiyle + QR bağlantısı');
    expect(modeHint(row, 'driving')).toBeNull();
    expect(modeHint({ ...row, gps: 'off' }, 'stationary')).toBe('Hareketsiz: pil tasarrufu');
  });
});
