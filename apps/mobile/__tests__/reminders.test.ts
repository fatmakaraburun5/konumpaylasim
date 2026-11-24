/**
 * Süresiz paylaşımın haftalık hatırlatma zamanları: başlangıçtan itibaren hafta katları, hep ileride.
 */
import { DURATION_LIMITS, HOUR } from '@konum/core';
import { nextIndefiniteReminders } from '../src/services/notifications/expiryNotifications';

const WEEK = DURATION_LIMITS.indefiniteReminderMs;
const START = Date.UTC(2026, 10, 1, 9, 0, 0);

describe('nextIndefiniteReminders', () => {
  it('ilk hafta dolmadan: 1. haftadan başlar', () => {
    expect(nextIndefiniteReminders(START, START + HOUR, 2)).toEqual([
      { week: 1, at: START + WEEK },
      { week: 2, at: START + 2 * WEEK },
    ]);
  });

  it('üç buçuk hafta sonra: geçmiş haftaları atlar', () => {
    const r = nextIndefiniteReminders(START, START + 3.5 * WEEK, 1);
    expect(r).toEqual([{ week: 4, at: START + 4 * WEEK }]);
  });

  it('tam hafta sınırında: o anı değil bir sonrakini verir', () => {
    expect(nextIndefiniteReminders(START, START + WEEK, 1)[0]).toEqual({ week: 2, at: START + 2 * WEEK });
  });
});
