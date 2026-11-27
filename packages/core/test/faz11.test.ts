import { describe, expect, it } from 'vitest';
import { formatMinute, isDayTime, nextThemeSwitchAt, parseThemeSchedule, parseThemeSettings, resolveThemeId, THEME_ID_SCHEME } from '../src';

const at = (h: number, m = 0) => new Date(2026, 10, 27, h, m, 0);

describe('Faz 11 tema ayarları', () => {
  const sched = { pref: 'schedule' as const, schedule: { day: 'blush' as const, night: 'charcoal' as const, day_start: 420, night_start: 1140 } };

  it('saat kuralı: gündüz / gece ve gece yarısını aşan aralık', () => {
    expect(resolveThemeId(sched, 'light', at(12))).toBe('blush');
    expect(resolveThemeId(sched, 'light', at(19))).toBe('charcoal');
    expect(resolveThemeId(sched, 'light', at(3))).toBe('charcoal');
    expect(isDayTime({ ...sched.schedule, day_start: 1320, night_start: 300 }, 60)).toBe(true);
    expect(THEME_ID_SCHEME.charcoal).toBe('dark');
  });

  it('sonraki geçiş anı: bir sonraki sınır dakikası', () => {
    expect(nextThemeSwitchAt(sched, at(12, 30))).toBe(at(19).getTime());
    expect(nextThemeSwitchAt(sched, at(20))).toBe(new Date(2026, 10, 28, 7).getTime());
    expect(nextThemeSwitchAt({ ...sched, pref: 'nude' }, at(1))).toBeNull();
  });

  it('kayıt: v1 taşınır, bozuk kayıt varsayılana düşer, aynı saatler ayrılır', () => {
    expect(parseThemeSettings(null, 'dark').pref).toBe('dark');
    expect(parseThemeSettings('{bozuk', null).pref).toBe('system');
    expect(parseThemeSettings(JSON.stringify(sched)).schedule.day).toBe('blush');
    expect(parseThemeSchedule({ day_start: 600, night_start: 600 }).night_start).toBe(1320);
    expect(formatMinute(425)).toBe('07:05');
  });
});
