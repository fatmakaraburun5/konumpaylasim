import { describe, expect, it } from 'vitest';
import {
  DELIVERED_FIELDS,
  LocationPacketSchema,
  MINUTE,
  SERVER_TIMESTAMP,
  batteryPct,
  buildPackets,
  freshness,
  inferActivityFromSpeed,
  normalizeSample,
  parseDelivered,
  toFanoutUpdate,
  type NormalizedSample,
  type PublishTarget,
  type RawLocationSample,
} from '../src';

const NOW = Date.UTC(2026, 10, 23, 11, 0, 0);
const raw = (over: Partial<RawLocationSample> = {}): RawLocationSample => ({
  latitude: 41.0082371234,
  longitude: 28.9783591234,
  accuracy: 8.37,
  speed: 1.234,
  heading: 359.96,
  timestamp: NOW - 2_000,
  ...over,
});

describe('normalizeSample', () => {
  it('koordinatı 6 ondalığa yuvarlar, saati sunucu saatine çevirir', () => {
    const r = normalizeSample(raw(), { serverOffsetMs: 1_500, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sample).toMatchObject({ lat: 41.008237, lng: 28.978359, accuracy: 8.4, speed_mps: 1.23, timestamp: NOW - 500 });
    expect(r.sample.heading).toBe(0); // 359.96 → 360.0 → 0
  });

  it('iOS geçersiz hız/yön (-1) null olur', () => {
    const r = normalizeSample(raw({ speed: -1, heading: -1 }), { serverOffsetMs: 0, now: NOW });
    expect(r.ok && r.sample.speed_mps).toBeNull();
    expect(r.ok && r.sample.heading).toBeNull();
  });

  it('bozuk, çok eski, gelecekteki ve düşük doğruluklu örnekleri reddeder', () => {
    const o = { serverOffsetMs: 0, now: NOW };
    expect(normalizeSample(raw({ latitude: 91 }), o)).toEqual({ ok: false, reason: 'bad_coordinates' });
    expect(normalizeSample(raw({ latitude: 0, longitude: 0 }), o)).toEqual({ ok: false, reason: 'bad_coordinates' });
    expect(normalizeSample(raw({ latitude: Number.NaN }), o)).toEqual({ ok: false, reason: 'bad_coordinates' });
    expect(normalizeSample(raw({ accuracy: -1 }), o)).toEqual({ ok: false, reason: 'bad_accuracy' });
    expect(normalizeSample(raw({ accuracy: 5_000 }), o)).toEqual({ ok: false, reason: 'bad_accuracy' });
    expect(normalizeSample(raw({ timestamp: NOW - 3 * MINUTE }), o)).toEqual({ ok: false, reason: 'too_old' });
    expect(normalizeSample(raw({ timestamp: NOW + 2 * MINUTE }), o)).toEqual({ ok: false, reason: 'in_future' });
  });
});

describe('pil ve aktivite', () => {
  it('batteryPct', () => {
    expect(batteryPct(0.734)).toBe(73);
    expect(batteryPct(-1)).toBeNull();
    expect(batteryPct(null)).toBeNull();
  });
  it('hızdan aktivite', () => {
    expect(inferActivityFromSpeed(null)).toBe('unknown');
    expect(inferActivityFromSpeed(0.2)).toBe('still');
    expect(inferActivityFromSpeed(1.4)).toBe('walking');
    expect(inferActivityFromSpeed(3)).toBe('running');
    expect(inferActivityFromSpeed(6)).toBe('cycling');
    expect(inferActivityFromSpeed(14)).toBe('automotive');
  });
});

describe('buildPackets + toFanoutUpdate', () => {
  const sample: NormalizedSample = { lat: 41.0, lng: 29.0, accuracy: 10, speed_mps: null, heading: null, timestamp: NOW, mocked: false };
  const t = (receiver: string, expires_at: number | null, share_mode: PublishTarget['share_mode'] = 'timed'): PublishTarget => ({
    share_id: `me_${receiver}`,
    receiver_id: receiver,
    share_mode,
    expires_at,
  });

  it('aynı süreye sahip alıcılar tek pakette, farklı süreler ayrı pakette', () => {
    const packets = buildPackets(sample, { batteryLevel: 0.5, isCharging: false }, 'me', [t('a', NOW + MINUTE), t('b', NOW + MINUTE), t('c', null, 'indefinite')], NOW);
    expect(packets).toHaveLength(2);
    expect(packets[0]!.receiver_ids).toEqual(['a', 'b']);
    expect(packets[1]!.receiver_ids).toEqual(['c']);
    for (const p of packets) expect(LocationPacketSchema.safeParse(p).success).toBe(true);
  });

  it('süresi dolmuş hedef ve kendisi atlanır', () => {
    const packets = buildPackets(sample, { batteryLevel: null, isCharging: null }, 'me', [t('a', NOW), t('me', null)], NOW);
    expect(packets).toEqual([]);
  });

  it('alıcı kopyalarında receiver_ids yok, null alanlar yok, server_ts yer tutucu', () => {
    const packets = buildPackets(sample, { batteryLevel: null, isCharging: true }, 'me', [t('a', NOW + MINUTE), t('b', NOW + MINUTE)], NOW);
    const update = toFanoutUpdate(packets);
    expect(Object.keys(update).sort()).toEqual(['live_locations/a/me_a', 'live_locations/b/me_b']);
    const copy = update['live_locations/a/me_a']!;
    expect(copy).not.toHaveProperty('receiver_ids');
    expect(copy).not.toHaveProperty('battery_pct');
    expect(copy).not.toHaveProperty('is_charging'); // pil bilinmiyorsa şarj bilgisi de gönderilmez
    expect(copy).not.toHaveProperty('speed_mps');
    expect(copy.server_ts).toEqual(SERVER_TIMESTAMP);
    expect(copy.share_id).toBe('me_a');
    for (const k of Object.keys(copy)) expect(DELIVERED_FIELDS as readonly string[]).toContain(k);
  });

  it('okuma tarafı eksik alanları null yapar, bozuk kaydı atar', () => {
    const parsed = parseDelivered({ v: 1, share_id: 'me_a', sender_id: 'me', lat: 41, lng: 29, accuracy: 5, timestamp: NOW, share_mode: 'timed', server_ts: NOW, activity_state: 'teleporting' });
    expect(parsed).toMatchObject({ heading: null, battery_pct: null, expires_at: null, activity_state: 'unknown' });
    expect(parseDelivered({ lat: 'x' })).toBeNull();
  });

  it('tazelik', () => {
    expect(freshness({ timestamp: NOW - MINUTE }, NOW)).toBe('live');
    expect(freshness({ timestamp: NOW - 10 * MINUTE }, NOW)).toBe('recent');
    expect(freshness({ timestamp: NOW - 20 * MINUTE }, NOW)).toBe('stale');
  });
});
