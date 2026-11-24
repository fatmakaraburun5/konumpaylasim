/**
 * Paylaşım süresi motoru: süre seçimi, bitiş zamanı, uzatma ve "süre dolmak üzere" eşiği.
 * İstemci bu fonksiyonları ÖNİZLEME için, Cloud Functions ise YETKİLİ hesap için kullanır.
 * Sunucunun hesapladığı `expires_at` her zaman geçerlidir.
 */
import {
  type EpochMs,
  type OffsetFn,
  MINUTE,
  HOUR,
  DAY,
  WEEK,
  clamp,
  deviceOffset,
  endOfLocalDay,
} from './time';

/** Paylaşımın yaşam süresi politikası. Konum paketindeki `share_mode` alanı budur. */
export type ShareMode = 'timed' | 'until_end_of_day' | 'weekly' | 'indefinite';

export const SHARE_MODES: readonly ShareMode[] = ['timed', 'until_end_of_day', 'weekly', 'indefinite'];

export type PresetId = 'm15' | 'h1' | 'h8';

export type DurationChoice =
  | { kind: 'preset'; preset: PresetId }
  | { kind: 'end_of_day' }
  | { kind: 'custom_minutes'; minutes: number }
  | { kind: 'custom_until'; until: EpochMs }
  | { kind: 'weekly' }
  | { kind: 'indefinite' };

export const PRESET_MINUTES: Record<PresetId, number> = { m15: 15, h1: 60, h8: 480 };

/** Ürün sınırları. [Varsayım] — onaya açık ürün kararları. */
export const DURATION_LIMITS = {
  /** Özel sürenin alt sınırı. */
  minCustomMs: 5 * MINUTE,
  /** Özel süre ve uzatmaların üst sınırı; daha uzunu için Haftalık/Süresiz seçilir. */
  maxTimedMs: WEEK,
  /** Gün sonuna bundan az kaldıysa bir sonraki günün sonuna kayar. */
  minEndOfDayRemainingMs: MINUTE,
  /** Süresiz paylaşımda hatırlatma aralığı (bildirim, Faz 1'de yalnızca yerel). */
  indefiniteReminderMs: WEEK,
} as const;

export interface DurationOption {
  id: 'm15' | 'h1' | 'h8' | 'eod' | 'custom' | 'week' | 'forever';
  label: string;
  group: 'short' | 'long';
  /** `custom` için null: kullanıcı süre seçer. */
  choice: DurationChoice | null;
}

/** Süre seçim ekranındaki sıra ve etiketler. */
export const DURATION_OPTIONS: readonly DurationOption[] = [
  { id: 'm15', label: '15 dk', group: 'short', choice: { kind: 'preset', preset: 'm15' } },
  { id: 'h1', label: '1 saat', group: 'short', choice: { kind: 'preset', preset: 'h1' } },
  { id: 'h8', label: '8 saat', group: 'short', choice: { kind: 'preset', preset: 'h8' } },
  { id: 'eod', label: 'Gün sonuna kadar', group: 'short', choice: { kind: 'end_of_day' } },
  { id: 'custom', label: 'Özel süre', group: 'short', choice: null },
  { id: 'week', label: '1 hafta', group: 'long', choice: { kind: 'weekly' } },
  { id: 'forever', label: 'Süresiz', group: 'long', choice: { kind: 'indefinite' } },
];

export interface ResolvedDuration {
  share_mode: ShareMode;
  /** null = süresiz. */
  expires_at: EpochMs | null;
}

export type DurationErrorCode = 'too_short' | 'too_long' | 'in_past' | 'invalid';

export class DurationError extends Error {
  constructor(
    public readonly code: DurationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DurationError';
  }
}

function assertTimedSpan(ms: number): void {
  if (!Number.isFinite(ms)) throw new DurationError('invalid', 'Süre sayı olmalı');
  if (ms < DURATION_LIMITS.minCustomMs) throw new DurationError('too_short', 'Süre en az 5 dakika olmalı');
  if (ms > DURATION_LIMITS.maxTimedMs)
    throw new DurationError('too_long', '7 günden uzun paylaşım için Haftalık veya Süresiz seçin');
}

/** Seçimi bitiş zamanına çevirir. `offsetAt` gün sonu için kullanıcının saat dilimidir. */
export function resolveDuration(
  choice: DurationChoice,
  now: EpochMs,
  offsetAt: OffsetFn = deviceOffset,
): ResolvedDuration {
  switch (choice.kind) {
    case 'preset': {
      const minutes = PRESET_MINUTES[choice.preset];
      if (minutes === undefined) throw new DurationError('invalid', 'Bilinmeyen hazır süre');
      return { share_mode: 'timed', expires_at: now + minutes * MINUTE };
    }
    case 'custom_minutes': {
      if (!Number.isInteger(choice.minutes)) throw new DurationError('invalid', 'Dakika tam sayı olmalı');
      const ms = choice.minutes * MINUTE;
      assertTimedSpan(ms);
      return { share_mode: 'timed', expires_at: now + ms };
    }
    case 'custom_until': {
      const ms = choice.until - now;
      if (ms <= 0) throw new DurationError('in_past', 'Bitiş zamanı gelecekte olmalı');
      assertTimedSpan(ms);
      return { share_mode: 'timed', expires_at: choice.until };
    }
    case 'end_of_day': {
      let end = endOfLocalDay(now, offsetAt);
      if (end - now < DURATION_LIMITS.minEndOfDayRemainingMs) end = endOfLocalDay(end + MINUTE, offsetAt);
      return { share_mode: 'until_end_of_day', expires_at: end };
    }
    case 'weekly':
      return { share_mode: 'weekly', expires_at: now + WEEK };
    case 'indefinite':
      return { share_mode: 'indefinite', expires_at: null };
    default: {
      const never: never = choice;
      throw new DurationError('invalid', `Bilinmeyen süre türü: ${JSON.stringify(never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Uzatma (+30 dk / +1 saat)
// ---------------------------------------------------------------------------

export type ExtensionMinutes = 30 | 60;

export const EXTENSION_STEPS: readonly { minutes: ExtensionMinutes; label: string }[] = [
  { minutes: 30, label: '+30 dk' },
  { minutes: 60, label: '+1 saat' },
];

export interface ExpiringShareLike {
  status: 'active' | 'ended';
  share_mode: ShareMode;
  started_at: EpochMs;
  expires_at: EpochMs | null;
}

export function canExtend(share: ExpiringShareLike, now: EpochMs): boolean {
  return share.status === 'active' && share.expires_at !== null && share.expires_at > now;
}

/**
 * Yeni bitiş = max(şimdiki bitiş, şimdi) + adım; üst sınır şimdi + 7 gün.
 * "Gün sonuna kadar" uzatılınca `timed` olur (artık gün sonuna bağlı değil). Haftalık, haftalık kalır.
 */
export function extendExpiry(
  share: ExpiringShareLike,
  minutes: ExtensionMinutes,
  now: EpochMs,
): ResolvedDuration {
  if (minutes !== 30 && minutes !== 60) throw new DurationError('invalid', 'Uzatma 30 veya 60 dakika olmalı');
  if (!canExtend(share, now)) throw new DurationError('invalid', 'Bu paylaşım uzatılamaz');
  const base = Math.max(share.expires_at as number, now);
  const expires_at = Math.min(base + minutes * MINUTE, now + DURATION_LIMITS.maxTimedMs);
  const share_mode: ShareMode = share.share_mode === 'until_end_of_day' ? 'timed' : share.share_mode;
  return { share_mode, expires_at };
}

/**
 * "Süre dolmak üzere" uyarısının bitişten ne kadar önce çıkacağı:
 * toplam sürenin %20'si, en az 3 dk, en çok 15 dk. [Varsayım]
 * 15 dk → 3 dk önce, 1 saat → 12 dk önce, 8 saat → 15 dk önce.
 */
export function extendPromptLeadMs(totalMs: number): number {
  return clamp(Math.round(totalMs * 0.2), 3 * MINUTE, 15 * MINUTE);
}

export function remainingMs(share: Pick<ExpiringShareLike, 'expires_at'>, now: EpochMs): number | null {
  return share.expires_at === null ? null : Math.max(0, share.expires_at - now);
}

export function isExpired(share: Pick<ExpiringShareLike, 'expires_at'>, now: EpochMs): boolean {
  return share.expires_at !== null && share.expires_at <= now;
}

export function isNearExpiry(share: ExpiringShareLike, now: EpochMs): boolean {
  if (share.status !== 'active' || share.expires_at === null) return false;
  const left = share.expires_at - now;
  if (left <= 0) return false;
  return left <= extendPromptLeadMs(share.expires_at - share.started_at);
}

/** Uyarının (ve yerel bildirimin) zamanlanacağı an; süresiz için null. */
export function extendPromptAt(share: ExpiringShareLike): EpochMs | null {
  if (share.expires_at === null) return null;
  return share.expires_at - extendPromptLeadMs(share.expires_at - share.started_at);
}
