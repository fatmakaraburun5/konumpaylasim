import { describe, expect, it } from 'vitest';
import { DAY, HOUR, PERMISSION_COPY, nextPermissionStep, needsBackgroundPermission, type PermissionFlowInput, type PermissionStep } from '../src';

const NOW = Date.UTC(2026, 10, 24, 12);
const ios = (o: Partial<PermissionFlowInput> = {}): PermissionFlowInput => ({
  platform: 'ios',
  osVersion: 18,
  foreground: 'granted',
  background: 'undetermined',
  notifications: 'granted',
  preciseLocation: true,
  shareMode: 'timed',
  durationMs: HOUR,
  now: NOW,
  ...o,
});
const android = (o: Partial<PermissionFlowInput> = {}): PermissionFlowInput => ({
  ...ios(),
  platform: 'android',
  osVersion: 34,
  batteryOptimization: 'optimized',
  ...o,
});

/** Kullanıcı her adımı kabul ederse sırayla görülen adımlar. */
function walk(input: PermissionFlowInput, accept: (s: PermissionStep, i: PermissionFlowInput) => PermissionFlowInput): PermissionStep[] {
  const steps: PermissionStep[] = [];
  let cur = input;
  for (let i = 0; i < 10; i++) {
    const r = nextPermissionStep(cur);
    if (r.step === 'done') break;
    steps.push(r.step);
    cur = accept(r.step, { ...cur, shownThisSession: [...(cur.shownThisSession ?? []), r.step] });
  }
  return steps;
}

describe('needsBackgroundPermission', () => {
  it('≥ 8 saat, gün sonu, haftalık, süresiz ya da paylaşımda arka plana gidince', () => {
    expect(needsBackgroundPermission({ shareMode: 'timed', durationMs: HOUR })).toBe(false);
    expect(needsBackgroundPermission({ shareMode: 'timed', durationMs: 8 * HOUR })).toBe(true);
    expect(needsBackgroundPermission({ shareMode: 'until_end_of_day' })).toBe(true);
    expect(needsBackgroundPermission({ shareMode: 'weekly' })).toBe(true);
    expect(needsBackgroundPermission({ shareMode: 'indefinite' })).toBe(true);
    expect(needsBackgroundPermission({ shareMode: 'timed', durationMs: HOUR, wentBackgroundDuringShare: true })).toBe(true);
    expect(needsBackgroundPermission({ shareMode: null })).toBe(false);
  });
});

describe('nextPermissionStep', () => {
  it('paylaşım yokken hiçbir şey sorulmaz (açılışta izin yok)', () => {
    expect(nextPermissionStep(ios({ shareMode: null, foreground: 'undetermined' })).step).toBe('done');
  });

  it('kısa paylaşım: yalnızca "Kullanırken" engelleyici; Always sorulmaz', () => {
    const r = nextPermissionStep(ios({ foreground: 'undetermined', notifications: 'undetermined' }));
    expect(r).toMatchObject({ step: 'when_in_use', action: 'system_prompt', blocking: true });
    const steps = walk(ios({ foreground: 'undetermined', notifications: 'undetermined' }), (s, i) =>
      s === 'when_in_use' ? { ...i, foreground: 'granted' } : s === 'notifications' ? { ...i, notifications: 'granted' } : i,
    );
    expect(steps).toEqual(['when_in_use', 'notifications']);
    const done = nextPermissionStep(ios());
    expect(done).toMatchObject({ step: 'done', canShare: true, canUseGeofence: false, blocking: false });
  });

  it('iOS haftalık: açıklama → Always yükseltme', () => {
    const steps = walk(ios({ shareMode: 'weekly' }), (s, i) =>
      s === 'always_rationale' ? { ...i, hasSeenRationale: { always: true } } : s === 'always_request' ? { ...i, background: 'granted' } : i,
    );
    expect(steps).toEqual(['always_rationale', 'always_request']);
    expect(nextPermissionStep(ios({ shareMode: 'weekly', hasSeenRationale: { always: true } })).action).toBe('system_prompt');
    expect(nextPermissionStep(ios({ shareMode: 'weekly', background: 'granted' }))).toMatchObject({ step: 'done', canUseGeofence: true });
  });

  it('Android 14 süresiz: açıklama → ayarlar (Her zaman izin ver) → pil optimizasyonu ipucu', () => {
    const steps = walk(android({ shareMode: 'indefinite' }), (s, i) =>
      s === 'always_rationale'
        ? { ...i, hasSeenRationale: { always: true } }
        : s === 'android_background_settings'
          ? { ...i, background: 'granted' }
          : s === 'battery_optimization_hint'
            ? { ...i, batteryOptimization: 'unrestricted' }
            : i,
    );
    expect(steps).toEqual(['always_rationale', 'android_background_settings', 'battery_optimization_hint']);
  });

  it('Android 10 diyalog, Android 9 ve öncesi arka plan izni ön planla gelir', () => {
    expect(nextPermissionStep(android({ osVersion: 29, shareMode: 'weekly', hasSeenRationale: { always: true } })).step).toBe('always_request');
    const a9 = nextPermissionStep(android({ osVersion: 28, shareMode: 'weekly', batteryOptimization: 'unrestricted' }));
    expect(a9).toMatchObject({ step: 'done', canUseGeofence: true });
  });

  it('pil ipucu yalnızca Android haftalık/süresiz; gün sonu için gösterilmez', () => {
    const eod = walk(android({ shareMode: 'until_end_of_day', background: 'granted' }), (_s, i) => i);
    expect(eod).not.toContain('battery_optimization_hint');
    expect(walk(ios({ shareMode: 'weekly', background: 'granted' }), (_s, i) => i)).not.toContain('battery_optimization_hint');
  });

  it('reddedilen adım 7 gün sorulmaz; 7 gün sonra bir kez', () => {
    const denied = ios({ shareMode: 'weekly', lastDeniedAt: { background: NOW - 3 * DAY } });
    expect(nextPermissionStep(denied).step).toBe('done');
    const later = ios({ shareMode: 'weekly', lastDeniedAt: { background: NOW - 8 * DAY } });
    expect(nextPermissionStep(later).step).toBe('always_rationale');
    const fg = ios({ foreground: 'denied', lastDeniedAt: { foreground: NOW - DAY } });
    expect(nextPermissionStep(fg)).toMatchObject({ step: 'done', canShare: false });
    const fgLater = ios({ foreground: 'denied', lastDeniedAt: { foreground: NOW - 8 * DAY } });
    expect(nextPermissionStep(fgLater)).toMatchObject({ step: 'when_in_use', action: 'open_settings' });
  });

  it('kısa paylaşımda arka plana gidilince bir kez Always önerilir, engellemez', () => {
    const r = nextPermissionStep(ios({ wentBackgroundDuringShare: true }));
    expect(r).toMatchObject({ step: 'always_rationale', blocking: false, canShare: true });
  });

  it('aynı oturumda gösterilen adım tekrarlanmaz (kullanıcı "Şimdi değil" dedi): akış sonlanır', () => {
    const steps = walk(android({ shareMode: 'weekly', notifications: 'undetermined', preciseLocation: false }), (_s, i) => i);
    expect(new Set(steps).size).toBe(steps.length);
    expect(steps).toEqual(['notifications', 'always_rationale', 'battery_optimization_hint', 'precise_hint']);
  });

  it('yaklaşık konum ipucu ve metinler', () => {
    expect(nextPermissionStep(ios({ preciseLocation: false })).step).toBe('precise_hint');
    for (const c of Object.values(PERMISSION_COPY)) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.dismiss.length).toBeGreaterThan(0);
    }
  });
});
