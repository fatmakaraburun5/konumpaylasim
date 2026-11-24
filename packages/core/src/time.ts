/**
 * Zaman yardımcıları.
 *
 * Kablo (wire) formatı: TÜM zaman damgaları UTC epoch milisaniyedir (int).
 * Sebep: Realtime Database kurallarındaki `now` ve ServerValue.TIMESTAMP da
 * epoch ms kullanır; aynı birim istemci, kural ve Functions tarafında karşılaştırılabilir.
 */

export type EpochMs = number;

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** Verilen andaki yerel saat farkı, UTC'nin DOĞUSUNA dakika (Europe/Istanbul = +180). */
export type OffsetFn = (epochMs: EpochMs) => number;

/** Cihazın kendi saat dilimi (istemcide varsayılan). */
export const deviceOffset: OffsetFn = (ms) => -new Date(ms).getTimezoneOffset();

/** Sabit farklı bir dilim (testler ve Türkiye için: UTC+3, yaz saati yok). */
export const fixedOffset =
  (minutesEast: number): OffsetFn =>
  () =>
    minutesEast;

/**
 * IANA saat dilimi için fark fonksiyonu (sunucu tarafı: Node'da tam Intl desteği var).
 * İstemci `time_zone` gönderir, sunucu "gün sonu"nu bununla hesaplar.
 */
export function offsetFnForTimeZone(timeZone: string): OffsetFn {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return (ms: EpochMs) => {
    const parts: Record<string, number> = {};
    for (const p of fmt.formatToParts(new Date(ms))) {
      if (p.type !== 'literal') parts[p.type] = Number(p.value);
    }
    const asUtc = Date.UTC(
      parts.year ?? 1970,
      (parts.month ?? 1) - 1,
      parts.day ?? 1,
      parts.hour ?? 0,
      parts.minute ?? 0,
      parts.second ?? 0,
    );
    // saniye altı kısmı at, farkı dakikaya yuvarla
    return Math.round((asUtc - Math.floor(ms / SECOND) * SECOND) / MINUTE);
  };
}

/** `now` anından sonraki ilk yerel gece yarısı (yerel 00:00), epoch ms. Yaz saati geçişini düzeltir. */
export function endOfLocalDay(now: EpochMs, offsetAt: OffsetFn = deviceOffset): EpochMs {
  const off = offsetAt(now);
  const localNow = now + off * MINUTE;
  const nextLocalMidnight = Math.floor(localNow / DAY) * DAY + DAY;
  let candidate = nextLocalMidnight - off * MINUTE;
  const offAtCandidate = offsetAt(candidate - 1);
  if (offAtCandidate !== off) candidate = nextLocalMidnight - offAtCandidate * MINUTE;
  return candidate;
}

/** Sunucu saatine göre "şimdi". `offsetMs` = sunucu - cihaz (RTDB `.info/serverTimeOffset`). */
export function serverNow(offsetMs: number, deviceNow: EpochMs = Date.now()): EpochMs {
  return deviceNow + offsetMs;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
