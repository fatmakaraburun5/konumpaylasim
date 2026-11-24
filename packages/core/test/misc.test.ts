import { describe, expect, it } from 'vitest';
import {
  INVITE_CODE_RE,
  MINUTE,
  SECOND,
  TRACKING_PROFILES,
  dativeSuffixForClock,
  formatAgo,
  formatExpiryLabel,
  formatInviteCode,
  formatRemaining,
  fixedOffset,
  friendshipId,
  generateInviteCode,
  maskPhone,
  normalizeInviteCode,
  normalizePhone,
  selectTrackingProfile,
  shareId,
  shouldPublish,
  toE164,
  uuidV4,
  type NormalizedSample,
} from '../src';

const NOW = Date.UTC(2026, 10, 23, 11, 0, 0);

describe('kimlikler', () => {
  it('arkadaşlık yönsüz, paylaşım yönlü', () => {
    expect(friendshipId('b', 'a')).toBe('a_b');
    expect(friendshipId('a', 'b')).toBe('a_b');
    expect(shareId('b', 'a')).toBe('b_a');
    expect(() => shareId('a', 'a')).toThrow();
  });
  it('uuid v4', () => {
    expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('davet kodu', () => {
  it('üretilen kod biçime uyar', () => {
    for (let i = 0; i < 200; i++) expect(generateInviteCode()).toMatch(INVITE_CODE_RE);
  });
  it('yanlı baytları atar (248 ve üstü)', () => {
    let call = 0;
    const rand = (n: number) => {
      call++;
      return new Uint8Array(n).fill(call === 1 ? 250 : 0); // ilk tur tamamen atılır
    };
    expect(generateInviteCode(rand)).toBe('LOC-222222');
  });
  it('kullanıcı girişini normalize eder', () => {
    expect(normalizeInviteCode('loc-7kq2mx')).toBe('LOC-7KQ2MX');
    expect(normalizeInviteCode(' 7KQ 2MX ')).toBe('LOC-7KQ2MX');
    expect(normalizeInviteCode('LOC-7KQ2M0')).toBeNull(); // 0 alfabede yok
    expect(normalizeInviteCode('LOC-8492')).toBeNull();
    expect(formatInviteCode('LOC-7KQ2MX')).toBe('LOC-7KQ 2MX');
  });
});

describe('telefon', () => {
  it('yerel girişi E.164 yapar', () => {
    expect(normalizePhone('0532 123 45 67')).toMatchObject({ ok: true, e164: '+905321234567' });
    expect(normalizePhone('+90 532 123 4567')).toMatchObject({ ok: true, e164: '+905321234567' });
    expect(normalizePhone('0212 123 45 67')).toEqual({ ok: false, reason: 'not_mobile_tr' });
    expect(normalizePhone('12')).toEqual({ ok: false, reason: 'invalid' });
    expect(toE164('+44 7911 123456')).toBe('+447911123456');
    expect(maskPhone('+905321234567')).toBe('+90 5•• ••• 45 67');
  });
});

describe('biçimlendirme', () => {
  it('kalan süre', () => {
    expect(formatRemaining(14 * MINUTE)).toBe('14 dk');
    expect(formatRemaining(65 * MINUTE)).toBe('1 sa 5 dk');
    expect(formatRemaining(51 * 60 * MINUTE)).toBe('2 gün 3 sa');
    expect(formatRemaining(30 * SECOND)).toBe('30 sn');
    expect(formatRemaining(0)).toBe('süre doldu');
  });
  it('bitiş etiketi (İstanbul saati)', () => {
    const ist = fixedOffset(180);
    expect(formatExpiryLabel({ share_mode: 'timed', expires_at: NOW + 45 * MINUTE }, NOW, ist)).toBe("14:45'e kadar · 45 dk kaldı");
    expect(formatExpiryLabel({ share_mode: 'indefinite', expires_at: null }, NOW, ist)).toBe('Süresiz · siz durdurana kadar');
    expect(formatAgo(NOW - 3 * MINUTE, NOW)).toBe('3 dk önce');
    expect(formatExpiryLabel({ share_mode: 'timed', expires_at: NOW + 30 * MINUTE }, NOW, ist)).toBe("14:30'a kadar · 30 dk kaldı");
  });
  it('saat ekleri', () => {
    const cases: [string, string][] = [['14:45', 'e'], ['17:30', 'a'], ['22:00', 'ye'], ['16:00', 'ya'], ['19:00', 'a'], ['00:00', 'a'], ['10:20', 'ye'], ['09:06', 'ya'], ['13:50', 'ye'], ['12:00', 'ye'], ['15:00', 'e']];
    for (const [clock, suffix] of cases) expect(dativeSuffixForClock(clock), clock).toBe(suffix);
  });
});

describe('takip profili ve yayın kapısı', () => {
  const base = { hasActiveOutgoingShare: true, appPhase: 'background' as const, activity: 'walking' as const, batteryPct: 80, isCharging: false };
  it('profil seçimi', () => {
    expect(selectTrackingProfile({ ...base, hasActiveOutgoingShare: false }).id).toBe('off');
    expect(selectTrackingProfile({ ...base, appPhase: 'foreground' }).id).toBe('live_foreground');
    expect(selectTrackingProfile(base).id).toBe('live_background');
    expect(selectTrackingProfile({ ...base, activity: 'still' }).id).toBe('still_background');
    expect(selectTrackingProfile({ ...base, batteryPct: 12 }).id).toBe('low_battery');
    expect(selectTrackingProfile({ ...base, batteryPct: 12, isCharging: true }).id).toBe('live_background');
  });

  const sample = (lat: number, accuracy = 5): NormalizedSample => ({ lat, lng: 29, accuracy, speed_mps: 1, heading: null, timestamp: NOW, mocked: false });
  const last = { lat: 41, lng: 29, sent_at: NOW - 40 * SECOND, battery_pct: 80, activity: 'walking' as const };
  const p = TRACKING_PROFILES.live_background;

  it('ilk örnek, hareket, nabız, erken örnek', () => {
    expect(shouldPublish(null, { sample: sample(41), battery_pct: 80, activity: 'walking' }, p, NOW)).toEqual({ publish: true, reason: 'first' });
    expect(shouldPublish(last, { sample: sample(41.001), battery_pct: 80, activity: 'walking' }, p, NOW).reason).toBe('moved'); // ~111 m
    expect(shouldPublish(last, { sample: sample(41.0001), battery_pct: 80, activity: 'walking' }, p, NOW).reason).toBe('not_moved'); // ~11 m
    expect(shouldPublish({ ...last, sent_at: NOW - 10 * SECOND }, { sample: sample(41.01), battery_pct: 80, activity: 'walking' }, p, NOW).reason).toBe('too_soon');
    expect(shouldPublish({ ...last, sent_at: NOW - 6 * MINUTE }, { sample: sample(41), battery_pct: 80, activity: 'walking' }, p, NOW).reason).toBe('heartbeat');
  });

  it('doğruluk dairesindeki titreme hareket sayılmaz', () => {
    // ~55 m kayma, ama doğruluk 80 m
    expect(shouldPublish(last, { sample: sample(41.0005, 80), battery_pct: 80, activity: 'walking' }, p, NOW).publish).toBe(false);
  });

  it('pil eşiği ve alıcı değişimi hemen yayınlatır', () => {
    expect(shouldPublish(last, { sample: sample(41), battery_pct: 14, activity: 'walking' }, p, NOW).reason).toBe('battery_changed');
    expect(shouldPublish(last, { sample: sample(41), battery_pct: 80, activity: 'walking' }, p, NOW, true).reason).toBe('targets_changed');
    expect(shouldPublish(last, { sample: sample(41), battery_pct: 80, activity: 'walking' }, TRACKING_PROFILES.off, NOW).publish).toBe(false);
  });
});
