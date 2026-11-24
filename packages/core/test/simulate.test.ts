import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE, SIM_TRACES, formatSimTable, simulateTrace, type SimReport } from '../src';

const reports: Record<string, SimReport> = {};
const sim = (name: keyof typeof SIM_TRACES, opts = {}) => (reports[name] ??= simulateTrace(SIM_TRACES[name](), opts));

describe('Faz 3 simülasyon senaryoları', () => {
  it('deterministik: aynı iz aynı raporu verir', () => {
    expect(simulateTrace(SIM_TRACES.desk_2h())).toEqual(simulateTrace(SIM_TRACES.desk_2h()));
  });

  it('desk_2h: GPS zamanın > %90’ında kapalı, alıcı hiç "gecikiyor" görmez', () => {
    const r = sim('desk_2h');
    expect(r.sleepShare).toBeGreaterThan(0.9);
    expect(r.gpsFixes + r.oneShotFixes).toBeLessThan(15);
    expect(r.sends).toBeLessThanOrEqual(12); // ≈ 15 dk'da bir kalp atışı
    expect(r.receiverMinutes.delayed + r.receiverMinutes.offline_suspected + r.receiverMinutes.stale).toBe(0);
    expect(r.lostPoints).toBe(0);
  });

  it('walk_then_drive_1h: yürüme → araç → hızlı; GPS hiç uyumaz; alıcı sürekli canlı', () => {
    const r = sim('walk_then_drive_1h');
    expect(r.motionMinutes.walking).toBeGreaterThan(10);
    expect(r.motionMinutes.driving).toBeGreaterThan(25);
    expect(r.motionMinutes.fast).toBeGreaterThan(8);
    expect(r.sleepMinutes).toBe(0);
    expect(r.receiverMinutes.live).toBeGreaterThanOrEqual(55);
    expect(r.maxSilenceMs).toBeLessThanOrEqual(2 * MINUTE);
  });

  it('tunnel_offline_10min: nokta kaybı yok, kuyruk eşitlenir, alıcı kesintide uyarı görür', () => {
    const r = sim('tunnel_offline_10min');
    expect(r.queuedMax).toBeGreaterThan(20);
    expect(r.syncedPoints).toBe(r.queuedTotal);
    expect(r.trailWrites).toBe(r.queuedTotal);
    expect(r.lostPoints).toBe(0);
    expect(r.receiverMinutes.delayed).toBeGreaterThan(0);
    expect(r.receiverMinutes.offline_suspected).toBeGreaterThan(0);
    expect(r.maxSilenceMs).toBeLessThanOrEqual(10 * MINUTE + 30_000);
  });

  it('battery_16_to_14: tam olarak bir düşük pil uyarısı, titremede tekrar yok', () => {
    const r = sim('battery_16_to_14');
    expect(r.lowBatteryAlerts).toBe(1);
    expect(r.receiverMinutes.delayed + r.receiverMinutes.offline_suspected).toBe(0);
  });

  it('weekly_7d: 7 gün, tek düşük pil uyarısı (3. gün), kayıp yok, sahte gecikme yok', () => {
    const r = sim('weekly_7d', { withLink: true });
    expect(r.durationMs).toBe(7 * DAY);
    expect(r.lowBatteryAlerts).toBe(1);
    expect(r.lostPoints).toBe(0);
    expect(r.sleepShare).toBeGreaterThan(0.8);
    expect(r.receiverMinutes.offline_suspected + r.receiverMinutes.stale).toBe(0);
    expect(r.sends / 7).toBeLessThan(1_000); // gün başına
  });

  it('indefinite_30d_light: GPS çoğunlukla kapalı, gece modem kesintisinde kuyruk eşitlenir, kayıp yok', () => {
    const r = sim('indefinite_30d_light');
    expect(r.sleepShare).toBeGreaterThan(0.9);
    expect(r.lostPoints).toBe(0);
    expect(r.syncedPoints).toBe(r.queuedTotal);
    expect(r.queuedTotal).toBeGreaterThan(0);
    expect(r.sends / 30).toBeLessThan(250);
    expect(r.maxSilenceMs).toBeLessThan(2 * HOUR + 15 * MINUTE);
    expect(r.receiverMinutes.stale).toBe(0);
  });

  it('özet tablo', () => {
    for (const k of Object.keys(SIM_TRACES) as Array<keyof typeof SIM_TRACES>) sim(k, k === 'weekly_7d' ? { withLink: true } : {});
    const table = formatSimTable(Object.values(reports));
    expect(table.split('\n')).toHaveLength(2 + Object.keys(SIM_TRACES).length);
    console.log(`\n${table}\n`);
  });
});
