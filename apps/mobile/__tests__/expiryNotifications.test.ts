/**
 * "Bitmek üzere" bildirimi: evre active → expiring_soon dönünce planlı/teslim edilmiş bildirim
 * İPTAL EDİLMEZ; uzatmada eskisi kaldırılıp yenisi planlanır; durdurulunca kaldırılır.
 */
import { HOUR, MINUTE, type ShareSession } from '@konum/core';

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  setNotificationCategoryAsync: jest.fn(async () => null),
  getAllScheduledNotificationsAsync: jest.fn(async () => []),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  cancelScheduledNotificationAsync: jest.fn(async () => undefined),
  dismissNotificationAsync: jest.fn(async () => undefined),
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
}));

const N = require('expo-notifications') as Record<string, jest.Mock>;
import { syncExpiryNotifications } from '../src/services/notifications/expiryNotifications';

const NOW = Date.UTC(2026, 10, 23, 11, 0, 0);
const ID = 'share-expiring-srv1';

const session = (over: Partial<ShareSession> = {}): ShareSession => ({
  session_id: 'srv1',
  phase: 'active',
  active_receiver_ids: ['a'],
  ended_receivers: [],
  share_mode: 'timed',
  started_at: NOW,
  expires_at: NOW + HOUR,
  prompt_at: NOW + HOUR - 12 * MINUTE,
  end_reason: null,
  error: null,
  confirmed: true,
  ...over,
});

const expiryCalls = (m: jest.Mock) => m.mock.calls.filter((c) => (typeof c[0] === 'string' ? c[0] : c[0]?.identifier) === ID).length;

describe('syncExpiryNotifications', () => {
  it('uyarı anında (evre değişimi) bildirime dokunmaz; uzatmada değiştirir; durdurunca kaldırır', async () => {
    const s0 = session();
    await syncExpiryNotifications([s0], NOW, 0);
    expect(expiryCalls(N.scheduleNotificationAsync!)).toBe(1);
    expect(N.scheduleNotificationAsync!.mock.calls[0]![0]).toMatchObject({
      identifier: ID,
      content: { categoryIdentifier: 'SHARE_EXPIRING', data: { session_id: 'srv1', prompt_at: s0.prompt_at } },
      trigger: { date: s0.prompt_at },
    });
    jest.clearAllMocks();

    // Tam uyarı anı: TICK evreyi expiring_soon yapar → bildirim (az önce teslim edildi) KALMALI.
    await syncExpiryNotifications([session({ phase: 'expiring_soon' })], s0.prompt_at!, 0);
    await syncExpiryNotifications([session({ phase: 'expiring_soon' })], s0.prompt_at! + 30_000, 0);
    expect(expiryCalls(N.cancelScheduledNotificationAsync!)).toBe(0);
    expect(expiryCalls(N.dismissNotificationAsync!)).toBe(0);
    expect(expiryCalls(N.scheduleNotificationAsync!)).toBe(0);

    // Uzatma (+30 dk): eski uyarı geçersiz → kaldır + yeni zamana planla.
    const extended = session({ expires_at: NOW + 90 * MINUTE, prompt_at: NOW + 90 * MINUTE - 15 * MINUTE, phase: 'active' });
    await syncExpiryNotifications([extended], s0.prompt_at! + MINUTE, 0);
    expect(expiryCalls(N.cancelScheduledNotificationAsync!)).toBeGreaterThanOrEqual(1);
    expect(expiryCalls(N.dismissNotificationAsync!)).toBe(1);
    expect(N.scheduleNotificationAsync!.mock.calls.at(-1)![0]).toMatchObject({ identifier: ID, trigger: { date: extended.prompt_at } });
    jest.clearAllMocks();

    // Kullanıcı durdurdu: bildirim kaldırılır.
    await syncExpiryNotifications([session({ phase: 'stopping', expires_at: extended.expires_at, prompt_at: extended.prompt_at })], s0.prompt_at! + 2 * MINUTE, 0);
    expect(expiryCalls(N.cancelScheduledNotificationAsync!)).toBe(1);
    expect(expiryCalls(N.dismissNotificationAsync!)).toBe(1);
    expect(expiryCalls(N.scheduleNotificationAsync!)).toBe(0);
  });

  it('geçmişe düşecek YENİ bildirim planlanmaz', async () => {
    jest.clearAllMocks();
    await syncExpiryNotifications([session({ session_id: 'late', phase: 'expiring_soon' })], NOW + HOUR - 5 * MINUTE, 0);
    expect(N.scheduleNotificationAsync!.mock.calls.filter((c) => c[0]?.identifier === 'share-expiring-late')).toHaveLength(0);
  });
});
