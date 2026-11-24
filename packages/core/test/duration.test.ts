import { describe, expect, it } from 'vitest';
import {
  DAY,
  DurationError,
  HOUR,
  MINUTE,
  WEEK,
  canExtend,
  endOfLocalDay,
  extendExpiry,
  extendPromptAt,
  extendPromptLeadMs,
  fixedOffset,
  isNearExpiry,
  offsetFnForTimeZone,
  resolveDuration,
  type ExpiringShareLike,
} from '../src';

const IST = fixedOffset(180); // Europe/Istanbul, UTC+3, yaz saati yok
// 2026-11-23 14:00:00 İstanbul = 11:00:00Z
const NOW = Date.UTC(2026, 10, 23, 11, 0, 0);

describe('resolveDuration', () => {
  it('hazır süreler', () => {
    expect(resolveDuration({ kind: 'preset', preset: 'm15' }, NOW)).toEqual({ share_mode: 'timed', expires_at: NOW + 15 * MINUTE });
    expect(resolveDuration({ kind: 'preset', preset: 'h1' }, NOW).expires_at).toBe(NOW + HOUR);
    expect(resolveDuration({ kind: 'preset', preset: 'h8' }, NOW).expires_at).toBe(NOW + 8 * HOUR);
  });

  it('gün sonu kullanıcının saat diliminde yerel gece yarısıdır', () => {
    const r = resolveDuration({ kind: 'end_of_day' }, NOW, IST);
    expect(r.share_mode).toBe('until_end_of_day');
    // İstanbul 24.11 00:00 = 23.11 21:00Z
    expect(r.expires_at).toBe(Date.UTC(2026, 10, 23, 21, 0, 0));
  });

  it('gün sonuna 1 dakikadan az kaldıysa ertesi günün sonuna kayar', () => {
    const late = Date.UTC(2026, 10, 23, 20, 59, 30); // İstanbul 23:59:30
    expect(resolveDuration({ kind: 'end_of_day' }, late, IST).expires_at).toBe(Date.UTC(2026, 10, 24, 21, 0, 0));
  });

  it('özel süre sınırları', () => {
    expect(resolveDuration({ kind: 'custom_minutes', minutes: 90 }, NOW).expires_at).toBe(NOW + 90 * MINUTE);
    expect(() => resolveDuration({ kind: 'custom_minutes', minutes: 4 }, NOW)).toThrowError(DurationError);
    expect(() => resolveDuration({ kind: 'custom_minutes', minutes: 7 * 24 * 60 + 1 }, NOW)).toThrowError(/7 günden/);
    expect(() => resolveDuration({ kind: 'custom_minutes', minutes: 1.5 }, NOW)).toThrowError(DurationError);
    expect(() => resolveDuration({ kind: 'custom_until', until: NOW - 1 }, NOW)).toThrowError(/gelecekte/);
    expect(resolveDuration({ kind: 'custom_until', until: NOW + 2 * HOUR }, NOW).expires_at).toBe(NOW + 2 * HOUR);
  });

  it('haftalık ve süresiz', () => {
    expect(resolveDuration({ kind: 'weekly' }, NOW)).toEqual({ share_mode: 'weekly', expires_at: NOW + WEEK });
    expect(resolveDuration({ kind: 'indefinite' }, NOW)).toEqual({ share_mode: 'indefinite', expires_at: null });
  });
});

describe('endOfLocalDay', () => {
  it('IANA dilimi ve yaz saati geçişi (Europe/Berlin, 2026-10-25)', () => {
    const berlin = offsetFnForTimeZone('Europe/Berlin');
    // 25 Ekim 2026 Berlin 10:00 (CET, +60; geçiş 03:00'te oldu)
    const now = Date.UTC(2026, 9, 25, 9, 0, 0);
    expect(endOfLocalDay(now, berlin)).toBe(Date.UTC(2026, 9, 25, 23, 0, 0));
    // Geçişten önceki akşam: 24 Ekim 20:00 CEST (+120) → gün sonu 24 Ekim 22:00Z
    const before = Date.UTC(2026, 9, 24, 18, 0, 0);
    expect(endOfLocalDay(before, berlin)).toBe(Date.UTC(2026, 9, 24, 22, 0, 0));
  });

  it('Europe/Istanbul için IANA ve sabit +180 aynı sonucu verir', () => {
    expect(endOfLocalDay(NOW, offsetFnForTimeZone('Europe/Istanbul'))).toBe(endOfLocalDay(NOW, IST));
  });
});

describe('uzatma', () => {
  const share = (over: Partial<ExpiringShareLike> = {}): ExpiringShareLike => ({
    status: 'active',
    share_mode: 'timed',
    started_at: NOW - 50 * MINUTE,
    expires_at: NOW + 10 * MINUTE,
    ...over,
  });

  it('+30 dk mevcut bitişin üzerine eklenir', () => {
    expect(extendExpiry(share(), 30, NOW)).toEqual({ share_mode: 'timed', expires_at: NOW + 40 * MINUTE });
    expect(extendExpiry(share(), 60, NOW).expires_at).toBe(NOW + 70 * MINUTE);
  });

  it('gün sonu paylaşımı uzatılınca timed olur, haftalık haftalık kalır', () => {
    expect(extendExpiry(share({ share_mode: 'until_end_of_day' }), 30, NOW).share_mode).toBe('timed');
    expect(extendExpiry(share({ share_mode: 'weekly' }), 60, NOW).share_mode).toBe('weekly');
  });

  it('süresiz, bitmiş veya süresi dolmuş paylaşım uzatılamaz', () => {
    expect(canExtend(share({ share_mode: 'indefinite', expires_at: null }), NOW)).toBe(false);
    expect(canExtend(share({ status: 'ended' }), NOW)).toBe(false);
    expect(canExtend(share({ expires_at: NOW }), NOW)).toBe(false);
    expect(() => extendExpiry(share({ expires_at: NOW - 1 }), 30, NOW)).toThrowError(DurationError);
  });

  it('uzatma 7 günü aşamaz', () => {
    const s = share({ share_mode: 'weekly', started_at: NOW, expires_at: NOW + WEEK - 10 * MINUTE });
    expect(extendExpiry(s, 60, NOW).expires_at).toBe(NOW + WEEK);
  });

  it('yalnızca 30 veya 60 dakika kabul edilir', () => {
    expect(() => extendExpiry(share(), 45 as 30, NOW)).toThrowError(DurationError);
  });
});

describe('süre dolmak üzere eşiği', () => {
  it('toplamın %20si, 3 ile 15 dk arasında', () => {
    expect(extendPromptLeadMs(15 * MINUTE)).toBe(3 * MINUTE);
    expect(extendPromptLeadMs(HOUR)).toBe(12 * MINUTE);
    expect(extendPromptLeadMs(8 * HOUR)).toBe(15 * MINUTE);
    expect(extendPromptLeadMs(DAY)).toBe(15 * MINUTE);
  });

  it('isNearExpiry ve extendPromptAt uyumlu', () => {
    const s: ExpiringShareLike = { status: 'active', share_mode: 'timed', started_at: NOW, expires_at: NOW + HOUR };
    const at = extendPromptAt(s)!;
    expect(at).toBe(NOW + 48 * MINUTE);
    expect(isNearExpiry(s, at - 1)).toBe(false);
    expect(isNearExpiry(s, at)).toBe(true);
    expect(isNearExpiry(s, NOW + HOUR)).toBe(false); // bitti, artık "üzere" değil
    expect(extendPromptAt({ ...s, expires_at: null, share_mode: 'indefinite' })).toBeNull();
  });
});
