/**
 * Bağlantı (QR) süre bildirimleri Faz 1 ile AYNI yoldan: aynı kategori/eylemler, kimlik `share-expiring-link:<id>`,
 * uzatmada yeniden planlanır, durdurunca kaldırılır; "+30 dk" eylemi `link_share_extend` çağırır (op_id bildirimde),
 * durdurulan bağlantı uzatılmaz, kalıcı bağlantı hedefinin bitişi güncellenir.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { HOUR, linkTokenHash, MINUTE, type LinkShareUpdateResponse } from '@konum/core';
import type { NotificationResponse } from 'expo-notifications';

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  setNotificationCategoryAsync: jest.fn(async () => null),
  getAllScheduledNotificationsAsync: jest.fn(async () => []),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  cancelScheduledNotificationAsync: jest.fn(async () => undefined),
  dismissNotificationAsync: jest.fn(async () => undefined),
  clearLastNotificationResponse: jest.fn(),
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
}));

const N = require('expo-notifications') as Record<string, jest.Mock>;
import { __resetExpiryActionsForTests, handleExpiryResponse, type ExpiryActionDeps } from '../src/services/notifications/expiryActions';
import { syncExpiryNotifications, type LinkExpirySubject } from '../src/services/notifications/expiryNotifications';
import { loadTargets, saveTargets } from '../src/state/persist';

const NOW = Date.UTC(2026, 10, 23, 11, 0, 0);
const ID = 'share-expiring-link:lnk1';
const HASH = linkTokenHash('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');

const link = (over: Partial<LinkExpirySubject> = {}): LinkExpirySubject => ({
  link_id: 'lnk1',
  phase: 'active',
  started_at: NOW,
  expires_at: NOW + HOUR,
  prompt_at: NOW + HOUR - 12 * MINUTE,
  ...over,
});
const callsFor = (m: jest.Mock, id: string) => m.mock.calls.filter((c) => (typeof c[0] === 'string' ? c[0] : c[0]?.identifier) === id);

describe('bağlantı süre bildirimleri', () => {
  it('planlar (aynı kategori, link_expiring verisi); uzatmada değiştirir; durdurunca kaldırır', async () => {
    const l0 = link();
    await syncExpiryNotifications([], NOW, 0, [l0]);
    const first = callsFor(N.scheduleNotificationAsync!, ID);
    expect(first).toHaveLength(1);
    expect(first[0]![0]).toMatchObject({
      identifier: ID,
      content: { categoryIdentifier: 'SHARE_EXPIRING', title: 'Konum bağlantın bitmek üzere', data: { kind: 'link_expiring', link_id: 'lnk1', prompt_at: l0.prompt_at } },
      trigger: { date: l0.prompt_at },
    });

    // Evre değişimi (uyarı anı geldi): dokunulmaz.
    await syncExpiryNotifications([], NOW + 50 * MINUTE, 0, [link({ phase: 'expiring_soon' })]);
    expect(callsFor(N.scheduleNotificationAsync!, ID)).toHaveLength(1);

    // Uzatma: yeni uyarı anı.
    const l1 = link({ expires_at: NOW + 90 * MINUTE, prompt_at: NOW + 90 * MINUTE - 15 * MINUTE });
    await syncExpiryNotifications([], NOW + 51 * MINUTE, 0, [l1]);
    expect(callsFor(N.scheduleNotificationAsync!, ID)).toHaveLength(2);

    // Durduruldu.
    await syncExpiryNotifications([], NOW + 52 * MINUTE, 0, [link({ ...l1, phase: 'stopping' })]);
    expect(callsFor(N.dismissNotificationAsync!, ID).length).toBeGreaterThan(0);
  });

  it('süresiz bağlantı: haftalık "Konum bağlantın hâlâ açık" hatırlatması', async () => {
    await syncExpiryNotifications([], NOW, 0, [link({ link_id: 'lnk2', expires_at: null, prompt_at: null })]);
    const reminder = N.scheduleNotificationAsync!.mock.calls.find((c) => String(c[0]?.identifier).startsWith('share-reminder-link:lnk2#'));
    expect(reminder?.[0]).toMatchObject({ content: { title: 'Konum bağlantın hâlâ açık', data: { kind: 'link_reminder', link_id: 'lnk2' } } });
  });
});

describe('bağlantı "+30 dk" eylemi', () => {
  const OP30 = '77777777-0000-4000-8000-000000000030';
  const OP60 = '77777777-0000-4000-8000-000000000060';
  const response = (action = 'EXTEND_30'): NotificationResponse =>
    ({
      actionIdentifier: action,
      notification: {
        request: {
          identifier: ID,
          content: {
            categoryIdentifier: 'SHARE_EXPIRING',
            data: { kind: 'link_expiring', link_id: 'lnk1', expires_at: NOW + HOUR, prompt_at: NOW + 48 * MINUTE, op_ids: { '30': OP30, '60': OP60 } },
          },
        },
      },
    }) as unknown as NotificationResponse;

  const res: LinkShareUpdateResponse = {
    link_id: 'lnk1',
    session_id: 'ls1',
    token_hash: HASH,
    status: 'active',
    share_mode: 'timed',
    started_at: NOW,
    expires_at: NOW + 90 * MINUTE,
    end_reason: null,
    version: 2,
    extended_count: 1,
    server_now: NOW,
  };

  function deps(over: Partial<ExpiryActionDeps> = {}) {
    return {
      extend: jest.fn(),
      isStopRequested: jest.fn(async () => false),
      dismiss: jest.fn(async () => undefined),
      notifyFailure: jest.fn(async () => undefined),
      clearLastResponse: jest.fn(),
      extendLink: jest.fn(async () => res),
      isLinkStopRequested: jest.fn(async () => false),
      ...over,
    } satisfies ExpiryActionDeps;
  }

  beforeEach(async () => {
    __resetExpiryActionsForTests();
    await AsyncStorage.clear();
    await saveTargets({
      uid: 'me',
      targets: [],
      linkTargets: [{ link_id: 'lnk1', token_hash: HASH, share_mode: 'timed', expires_at: NOW + HOUR, sender_name: 'Ayşe' }],
      serverOffsetMs: 0,
      notificationBody: '',
    });
  });

  it('uygulama kapalıyken: link_share_extend (bildirimdeki op_id), kalıcı bitiş güncellenir, bildirim kalkar', async () => {
    const d = deps();
    await expect(handleExpiryResponse(response(), null, d)).resolves.toEqual({ kind: 'ok' });
    expect(d.extendLink).toHaveBeenCalledWith({ link_id: 'lnk1', minutes: 30, op_id: OP30 });
    expect(d.extend).not.toHaveBeenCalled();
    expect((await loadTargets()).linkTargets[0]).toMatchObject({ expires_at: NOW + 90 * MINUTE, version: 2, extended_count: 1 });
    expect(d.dismiss).toHaveBeenCalledWith(ID);
    // Aynı dokunuş ikinci kez işlenmez.
    await expect(handleExpiryResponse(response(), null, d)).resolves.toBeNull();
  });

  it('uygulama açıkken depo yolu kullanılır', async () => {
    const d = deps();
    const viaLink = jest.fn(async () => ({ kind: 'ok' as const }));
    await expect(handleExpiryResponse(response('EXTEND_60'), { link: viaLink }, d)).resolves.toEqual({ kind: 'ok' });
    expect(viaLink).toHaveBeenCalledWith('lnk1', 60, OP60);
    expect(d.extendLink).not.toHaveBeenCalled();
  });

  it('durdurulan bağlantı uzatılmaz; hata kullanıcıya bildirilir', async () => {
    const stopped = deps({ isLinkStopRequested: jest.fn(async () => true) });
    await expect(handleExpiryResponse(response(), null, stopped)).resolves.toEqual({ kind: 'rejected' });
    expect(stopped.extendLink).not.toHaveBeenCalled();

    __resetExpiryActionsForTests();
    const failing = deps({ extendLink: jest.fn(async () => Promise.reject({ code: 'functions/unavailable' })) });
    await expect(handleExpiryResponse(response(), null, failing)).resolves.toMatchObject({ kind: 'failed' });
    expect(failing.notifyFailure).toHaveBeenCalledWith('lnk1', expect.any(String));
  });
});
