/**
 * Yayıncı: doğru fan-out haritası, hedef yokken hiçbir şey yapmama, PERMISSION_DENIED sonrası tek tekrar.
 */
import {
  DELIVERED_FIELDS,
  HOUR,
  SERVER_TIMESTAMP,
  type DeliveredLocationWrite,
  type NormalizedSample,
  type PublishTarget,
} from '@konum/core';
import { publishSample, type PublisherDeps } from '../src/services/firebase/publisher';

const NOW = Date.UTC(2026, 10, 23, 11, 0, 0);
const sample: NormalizedSample = { lat: 41.0082, lng: 28.9784, accuracy: 12, speed_mps: 1.2, heading: 90, timestamp: NOW - 1_000, mocked: false };
const device = { batteryLevel: 0.42, isCharging: false };
const target = (r: string, expires_at: number | null = NOW + HOUR): PublishTarget => ({ share_id: `me_${r}`, receiver_id: r, share_mode: 'timed', expires_at });

function deps() {
  const write = jest.fn<Promise<void>, [Record<string, DeliveredLocationWrite>]>().mockResolvedValue(undefined);
  const refreshTargets = jest.fn<Promise<PublishTarget[]>, []>().mockResolvedValue([]);
  const d = { write, refreshTargets };
  // Tip kontrolü: sahte bağımlılıklar gerçek arayüzü karşılamalı.
  const _check: PublisherDeps = d;
  void _check;
  return d;
}

const permissionDenied = Object.assign(new Error('PERMISSION_DENIED: Permission denied'), { code: 'database/permission-denied' });

describe('publishSample', () => {
  it('alıcı başına kopya yazar: doğru yollar, v + share_id var, receiver_ids yok', async () => {
    const d = deps();
    const res = await publishSample({ sample, device, senderId: 'me', targets: [target('a'), target('b')], now: NOW }, d);

    expect(res).toMatchObject({ status: 'published', retried: false, dropped: [] });
    expect(d.write).toHaveBeenCalledTimes(1);
    const map = d.write.mock.calls[0]![0];
    expect(Object.keys(map).sort()).toEqual(['live_locations/a/me_a', 'live_locations/b/me_b']);
    expect(map['live_locations/a/me_a']).toEqual({
      v: 1,
      share_id: 'me_a',
      sender_id: 'me',
      lat: 41.0082,
      lng: 28.9784,
      accuracy: 12,
      speed_mps: 1.2,
      heading: 90,
      battery_pct: 42,
      is_charging: false,
      activity_state: 'walking',
      timestamp: NOW - 1_000,
      expires_at: NOW + HOUR,
      share_mode: 'timed',
      server_ts: SERVER_TIMESTAMP,
    });
    for (const copy of Object.values(map)) {
      expect(copy).not.toHaveProperty('receiver_ids');
      for (const k of Object.keys(copy)) expect(DELIVERED_FIELDS).toContain(k);
    }
  });

  it('süresiz paylaşımda expires_at alanı yazılmaz (RTDB null saklamaz)', async () => {
    const d = deps();
    await publishSample({ sample, device: { batteryLevel: null, isCharging: null }, senderId: 'me', targets: [target('a', null)], now: NOW }, d);
    const copy = d.write.mock.calls[0]![0]['live_locations/a/me_a']!;
    expect(copy).not.toHaveProperty('expires_at');
    expect(copy).not.toHaveProperty('battery_pct');
    expect(copy).not.toHaveProperty('is_charging');
  });

  it('hedef yoksa hiçbir şey yazmaz', async () => {
    const d = deps();
    await expect(publishSample({ sample, device, senderId: 'me', targets: [], now: NOW }, d)).resolves.toEqual({ status: 'skipped', reason: 'no_targets', dropped: [] });
    expect(d.write).not.toHaveBeenCalled();
    expect(d.refreshTargets).not.toHaveBeenCalled();
  });

  it('yalnızca süresi dolmuş (ya da kendine) hedefler varsa hiçbir şey yazmaz', async () => {
    const d = deps();
    const targets = [target('a', NOW - 1), { ...target('me'), share_id: 'me_me' }];
    await expect(publishSample({ sample, device, senderId: 'me', targets, now: NOW }, d)).resolves.toEqual({ status: 'skipped', reason: 'no_targets', dropped: [] });
    expect(d.write).not.toHaveBeenCalled();
  });

  it('PERMISSION_DENIED: Firestore’dan tazeler, reddedilen hedef olmadan BİR KEZ yeniden dener', async () => {
    const d = deps();
    d.write.mockRejectedValueOnce(permissionDenied);
    // Sunucuya göre yalnızca "a" hâlâ aktif; ayrıca yerelde olmayan "c" eklenmez (kesişim).
    d.refreshTargets.mockResolvedValue([target('a'), target('c')]);

    const res = await publishSample({ sample, device, senderId: 'me', targets: [target('a'), target('b')], now: NOW }, d);

    expect(d.refreshTargets).toHaveBeenCalledTimes(1);
    expect(d.write).toHaveBeenCalledTimes(2);
    expect(Object.keys(d.write.mock.calls[1]![0])).toEqual(['live_locations/a/me_a']);
    expect(res).toMatchObject({ status: 'published', retried: true, dropped: ['me_b'] });
  });

  it('PERMISSION_DENIED ve aktif hedef kalmadıysa yeniden yazmaz, takibin kapanmasını ister', async () => {
    const d = deps();
    d.write.mockRejectedValueOnce(permissionDenied);
    d.refreshTargets.mockResolvedValue([]);
    const res = await publishSample({ sample, device, senderId: 'me', targets: [target('a')], now: NOW }, d);
    expect(res).toEqual({ status: 'no_active_targets', dropped: ['me_a'] });
    expect(d.write).toHaveBeenCalledTimes(1);
  });

  it('ikinci ret: yalnızca bir kez dener ve hatayı döndürür', async () => {
    const d = deps();
    d.write.mockRejectedValue(permissionDenied);
    d.refreshTargets.mockResolvedValue([target('a')]);
    const res = await publishSample({ sample, device, senderId: 'me', targets: [target('a')], now: NOW }, d);
    expect(res.status).toBe('failed');
    expect(d.write).toHaveBeenCalledTimes(2);
  });

  it('ağ hatası (izin dışı) tazeleme yapmaz', async () => {
    const d = deps();
    d.write.mockRejectedValueOnce(new Error('network error'));
    const res = await publishSample({ sample, device, senderId: 'me', targets: [target('a')], now: NOW }, d);
    expect(res.status).toBe('failed');
    expect(d.refreshTargets).not.toHaveBeenCalled();
  });

  it('kesme anahtarı: durdurulan hedefe ilk yazmada da yazılmaz', async () => {
    const d = { ...deps(), isAllowed: (id: string) => id !== 'me_a' };
    const res = await publishSample({ sample, device, senderId: 'me', targets: [target('a'), target('b')], now: NOW }, d);
    expect(Object.keys(d.write.mock.calls[0]![0])).toEqual(['live_locations/b/me_b']);
    expect(res).toMatchObject({ status: 'published', targets: [{ share_id: 'me_b' }] });
    const only = { ...deps(), isAllowed: () => false };
    await expect(publishSample({ sample, device, senderId: 'me', targets: [target('a')], now: NOW }, only)).resolves.toEqual({
      status: 'skipped',
      reason: 'blocked',
      dropped: [],
    });
    expect(only.write).not.toHaveBeenCalled();
  });

  it('PERMISSION_DENIED tazelemesi sürerken "Durdur": yeniden deneme durdurulan hedefe YAZMAZ', async () => {
    const blocked = new Set<string>();
    const d = { ...deps(), isAllowed: (id: string) => !blocked.has(id) };
    d.write.mockRejectedValueOnce(permissionDenied);
    d.refreshTargets.mockImplementation(async () => {
      blocked.add('me_a'); // tazeleme beklenirken kullanıcı a ile paylaşımı durdurdu
      return [target('a'), target('b')];
    });
    const res = await publishSample({ sample, device, senderId: 'me', targets: [target('a'), target('b')], now: NOW }, d);
    expect(d.write).toHaveBeenCalledTimes(2);
    expect(Object.keys(d.write.mock.calls[1]![0])).toEqual(['live_locations/b/me_b']);
    expect(res).toMatchObject({ status: 'published', retried: true, targets: [{ share_id: 'me_b' }] });
  });
});
