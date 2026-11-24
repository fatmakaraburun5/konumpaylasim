import { describe, expect, it } from 'vitest';
import {
  APP_PHASES,
  BATTERY_BANDS,
  MINUTE,
  MOTION_STATES,
  SECOND,
  TRACKING_MATRIX,
  TRACKING_PROFILES,
  batteryBand,
  needsHeartbeatAnnounce,
  selectTrackingPlan,
  selectTrackingProfile,
  shouldPublish,
  trackingMatrixRows,
  type TrackingPlanInput,
} from '../src';

const input = (over: Partial<TrackingPlanInput> = {}): TrackingPlanInput => ({
  hasActiveOutgoingShare: true,
  appPhase: 'background',
  motion: 'walking',
  batteryPct: 80,
  isCharging: false,
  ...over,
});

describe('TRACKING_MATRIX', () => {
  it('her hareket × evre × pil hücresi tanımlı ve tutarlı', () => {
    const rows = trackingMatrixRows();
    expect(rows).toHaveLength(MOTION_STATES.length * APP_PHASES.length * BATTERY_BANDS.length);
    for (const r of rows) {
      expect(r.heartbeatMs).toBeGreaterThan(0);
      if (r.gps === 'off') expect(r.osIntervalMs).toBe(0);
      else expect(r.osIntervalMs).toBeGreaterThan(0);
      expect(r.heartbeatMs).toBeGreaterThanOrEqual(r.sendMinIntervalMs);
      expect(Object.isFrozen(TRACKING_MATRIX[r.motion][r.appPhase][r.battery])).toBe(true);
    }
  });

  it('sabit + arka plan: GPS kapalı, uyku çiti, kalp atışı 15 dk (düşük pilde 30 dk)', () => {
    const n = TRACKING_MATRIX.stationary.background.normal;
    expect(n).toMatchObject({ gps: 'off', useSleepGeofence: true, heartbeatMs: 15 * MINUTE });
    expect(TRACKING_MATRIX.stationary.background.low.heartbeatMs).toBe(30 * MINUTE);
    expect(TRACKING_MATRIX.stationary.background.low.useSleepGeofence).toBe(true);
  });

  it('hareket satırları: yürüme 15–30 sn / 10–20 m, araç 5–10 sn / 50 m, hızlı 5 sn / 100 m', () => {
    const w = TRACKING_MATRIX.walking.background.normal;
    expect(w.osIntervalMs).toBeGreaterThanOrEqual(15 * SECOND);
    expect(w.osIntervalMs).toBeLessThanOrEqual(30 * SECOND);
    expect(w.distanceFilterM).toBeGreaterThanOrEqual(10);
    expect(w.distanceFilterM).toBeLessThanOrEqual(20);
    const d = TRACKING_MATRIX.driving.background.normal;
    expect(d.osIntervalMs).toBe(5 * SECOND);
    expect(d.distanceFilterM).toBe(50);
    expect(d.sendMinIntervalMs).toBeLessThanOrEqual(10 * SECOND);
    expect(TRACKING_MATRIX.fast.background.normal).toMatchObject({ osIntervalMs: 5 * SECOND, distanceFilterM: 100, gps: 'high' });
  });

  it('düşük pil aralıkları ≈ 2 kat, doğruluğu bir kademe düşürür', () => {
    for (const m of MOTION_STATES) {
      for (const p of APP_PHASES) {
        const n = TRACKING_MATRIX[m][p].normal;
        const l = TRACKING_MATRIX[m][p].low;
        expect(l.osIntervalMs).toBe(n.osIntervalMs * 2);
        expect(l.sendMinIntervalMs).toBe(n.sendMinIntervalMs * 2);
        expect(l.heartbeatMs).toBeGreaterThanOrEqual(n.heartbeatMs);
        if (n.gps === 'high') expect(l.gps).toBe('balanced');
        if (n.gps === 'balanced') expect(l.gps).toBe('low');
      }
    }
  });

  it('kritik pil (arka plan): yalnızca kalp atışı + önemli konum değişikliği', () => {
    for (const m of MOTION_STATES) {
      const c = TRACKING_MATRIX[m].background.critical;
      expect(c.gps).toBe('off');
      expect(c.significantChanges).toBe(true);
      expect(c.heartbeatMs).toBeGreaterThanOrEqual(30 * MINUTE);
    }
  });
});

describe('batteryBand', () => {
  it('şarj önceliklidir; %15 düşük, %5 kritik; %20 altında düşükte kalır (histerezis)', () => {
    expect(batteryBand(3, true)).toBe('charging');
    expect(batteryBand(16, false)).toBe('normal');
    expect(batteryBand(15, false)).toBe('low');
    expect(batteryBand(5, false)).toBe('critical');
    expect(batteryBand(18, false, 'low')).toBe('low');
    expect(batteryBand(20, false, 'low')).toBe('normal');
    expect(batteryBand(null, null)).toBe('normal');
    expect(batteryBand(null, null, 'critical')).toBe('critical');
  });
});

describe('selectTrackingPlan', () => {
  it('paylaşım yoksa kapalı; Faz 1 profili off', () => {
    const p = selectTrackingPlan(input({ hasActiveOutgoingShare: false }));
    expect(p.active).toBe(false);
    expect(p.profile).toBe(TRACKING_PROFILES.off);
    expect(p.reason).toBe('off:no_share');
  });

  it('satır + gerekçe + Faz 1 uyumlu profil döner', () => {
    const p = selectTrackingPlan(input({ motion: 'stationary', batteryPct: 12 }));
    expect(p.row).toBe(TRACKING_MATRIX.stationary.background.low);
    expect(p.reason).toBe('background/stationary/low');
    expect(p.profile.id).toBe('low_battery');
    expect(p.profile.heartbeatMs).toBe(30 * MINUTE);
    const fg = selectTrackingPlan(input({ appPhase: 'foreground', motion: 'driving' }));
    expect(fg.profile.id).toBe('live_foreground');
    expect(fg.profile.timeIntervalMs).toBe(fg.row.sendMinIntervalMs);
  });

  it('çit izni yoksa (Always yok) sabit satırı düşük güçlü sürekli güncellemeye düşer', () => {
    const p = selectTrackingPlan(input({ motion: 'stationary', canUseGeofence: false }));
    expect(p.row.useSleepGeofence).toBe(false);
    expect(p.row.gps).toBe('low');
    expect(p.row.osIntervalMs).toBeGreaterThan(0);
    expect(p.reason).toContain('no_geofence');
  });

  it("GPS kapalı satır shouldPublish'te 'tracking_off' DEĞİL: kalp atışı çalışır", () => {
    const p = selectTrackingPlan(input({ motion: 'stationary' }));
    expect(p.profile.id).toBe('still_background');
    const now = Date.UTC(2026, 10, 24, 9);
    const last = { lat: 41, lng: 29, sent_at: now - 15 * MINUTE, battery_pct: 80, activity: 'still' as const };
    const sample = { lat: 41, lng: 29, accuracy: 30, speed_mps: null, heading: null, timestamp: now, mocked: false };
    expect(shouldPublish(last, { sample, battery_pct: 80, activity: 'still' }, p.profile, now)).toEqual({ publish: true, reason: 'heartbeat' });
    expect(shouldPublish({ ...last, sent_at: now - 5 * MINUTE }, { sample, battery_pct: 80, activity: 'still' }, p.profile, now).publish).toBe(false);
  });

  it('kalp atışı uzayınca hemen duyuru gerekir; kısalınca gerekmez', () => {
    const still = selectTrackingPlan(input({ motion: 'stationary' }));
    expect(needsHeartbeatAnnounce(5 * MINUTE, still)).toBe(true);
    expect(needsHeartbeatAnnounce(15 * MINUTE, still)).toBe(false);
    expect(needsHeartbeatAnnounce(null, still)).toBe(false);
    const walk = selectTrackingPlan(input({ motion: 'walking' }));
    expect(needsHeartbeatAnnounce(15 * MINUTE, walk)).toBe(false);
  });

  it('Faz 1 selectTrackingProfile değişmedi', () => {
    expect(selectTrackingProfile({ hasActiveOutgoingShare: true, appPhase: 'background', activity: 'still', batteryPct: 80, isCharging: false })).toBe(
      TRACKING_PROFILES.still_background,
    );
    expect(selectTrackingProfile({ hasActiveOutgoingShare: true, appPhase: 'background', activity: 'walking', batteryPct: 10, isCharging: false })).toBe(
      TRACKING_PROFILES.low_battery,
    );
  });
});
