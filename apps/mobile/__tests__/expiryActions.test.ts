/**
 * "+30 dk" eylemi: soğuk açılışta depo oturumu tanımıyorsa callable doğrudan çağrılır; başarıdan sonra
 * bildirim kaldırılır ve son yanıt temizlenir. Durdurulan oturum uzatılmaz. Başarısızlık sessiz kalmaz.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { HOUR, MINUTE, type ShareExtendResponse } from '@konum/core';
import type { NotificationResponse } from 'expo-notifications';

jest.mock('expo-notifications', () => ({
  dismissNotificationAsync: jest.fn(async () => undefined),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  clearLastNotificationResponse: jest.fn(),
}));

import { __resetExpiryActionsForTests, handleExpiryResponse, type ExpiryActionDeps } from '../src/services/notifications/expiryActions';
import { loadTargets, saveTargets } from '../src/state/persist';

const NOW = Date.UTC(2026, 10, 23, 11, 0, 0);
const OP30 = '55555555-0000-4000-8000-000000000030';
const OP60 = '55555555-0000-4000-8000-000000000060';

const response = (action = 'EXTEND_30'): NotificationResponse =>
  ({
    actionIdentifier: action,
    notification: {
      request: {
        identifier: 'share-expiring-srv1',
        content: {
          categoryIdentifier: 'SHARE_EXPIRING',
          data: { kind: 'share_expiring', session_id: 'srv1', expires_at: NOW + HOUR, prompt_at: NOW + 48 * MINUTE, op_ids: { '30': OP30, '60': OP60 } },
        },
      },
    },
  }) as unknown as NotificationResponse;

function deps(over: Partial<ExpiryActionDeps> = {}) {
  const extendRes: ShareExtendResponse = {
    session_id: 'srv1',
    shares: [
      { share_id: 'me_a', session_id: 'srv1', receiver_id: 'a', status: 'active', share_mode: 'timed', started_at: NOW, expires_at: NOW + 90 * MINUTE, end_reason: null, version: 2 },
    ],
    expires_at: NOW + 90 * MINUTE,
    share_mode: 'timed',
    server_now: NOW,
  };
  return {
    extend: jest.fn(async () => extendRes),
    isStopRequested: jest.fn(async () => false),
    dismiss: jest.fn(async () => undefined),
    notifyFailure: jest.fn(async () => undefined),
    clearLastResponse: jest.fn(),
    ...over,
  } satisfies ExpiryActionDeps;
}

describe('handleExpiryResponse', () => {
  beforeEach(async () => {
    __resetExpiryActionsForTests();
    await AsyncStorage.clear();
    await saveTargets({
      uid: 'me',
      targets: [{ share_id: 'me_a', receiver_id: 'a', share_mode: 'timed', expires_at: NOW + HOUR, session_id: 'srv1', started_at: NOW, version: 1 }],
      serverOffsetMs: 0,
      notificationBody: '',
    });
  });

  it('soğuk açılış: depo oturumu tanımıyor → callable gömülü op_id ile, hedef bitişi güncellenir, sonra kaldırılır', async () => {
    const d = deps();
    const out = await handleExpiryResponse(response(), async () => ({ kind: 'unknown_session' }), d);
    expect(out).toEqual({ kind: 'ok' });
    expect(d.extend).toHaveBeenCalledWith({ session_id: 'srv1', minutes: 30, op_id: OP30 });
    expect((await loadTargets()).targets[0]).toMatchObject({ share_id: 'me_a', expires_at: NOW + 90 * MINUTE, version: 2 });
    expect(d.dismiss).toHaveBeenCalledWith('share-expiring-srv1');
    expect(d.clearLastResponse).toHaveBeenCalled();
    // Aynı dokunuş ikinci kez (dinleyici + son yanıt) işlenmez.
    await expect(handleExpiryResponse(response(), async () => ({ kind: 'unknown_session' }), d)).resolves.toBeNull();
    expect(d.extend).toHaveBeenCalledTimes(1);
  });

  it('kullanıcının durdurduğu oturum uzatılmaz', async () => {
    const d = deps({ isStopRequested: jest.fn(async () => true) });
    const out = await handleExpiryResponse(response('EXTEND_60'), null, d);
    expect(out).toEqual({ kind: 'rejected' });
    expect(d.extend).not.toHaveBeenCalled();
    expect(d.dismiss).toHaveBeenCalled();
  });

  it('başarısızlık: kullanıcıya bildirilir, kaldırılmaz; sonraki dokunuş yeniden denenebilir', async () => {
    const d = deps({
      extend: jest.fn(async () => {
        throw { code: 'functions/failed-precondition', details: { code: 'already_expired' } };
      }),
    });
    const out = await handleExpiryResponse(response(), null, d);
    expect(out).toEqual({ kind: 'failed', message: 'Paylaşımın süresi doldu, yeniden başlatın' });
    expect(d.notifyFailure).toHaveBeenCalledWith('srv1', 'Paylaşımın süresi doldu, yeniden başlatın');
    expect(d.dismiss).not.toHaveBeenCalled();
    expect(d.clearLastResponse).toHaveBeenCalled();
    await handleExpiryResponse(response(), null, d);
    expect(d.extend).toHaveBeenCalledTimes(2);
  });

  it('uygulama açıkken depo yolu kullanılır', async () => {
    const d = deps();
    const viaStore = jest.fn(async () => ({ kind: 'ok' }) as const);
    await expect(handleExpiryResponse(response(), viaStore, d)).resolves.toEqual({ kind: 'ok' });
    expect(viaStore).toHaveBeenCalledWith('srv1', 30, OP30);
    expect(d.extend).not.toHaveBeenCalled();
  });
});
