/**
 * Uygulama hata modeli: callable `HttpsError.details.code` → core `ERROR_CODES`.
 * Arayüz her zaman core'daki Türkçe mesajı gösterir; sunucunun ham mesajı gösterilmez (bilgi sızmasın).
 */
import { ERROR_CODES, type ErrorCode, type SharingError } from '@konum/core';

export class KonumError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string = ERROR_CODES[code].message,
    public readonly retryable: boolean = ERROR_CODES[code].retryable,
  ) {
    super(message);
    this.name = 'KonumError';
  }

  toSharingError(): SharingError {
    return { code: this.code, message: this.message };
  }
}

const isErrorCode = (v: unknown): v is ErrorCode => typeof v === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, v);

/** Firebase Functions taşıma kodu (önekli ya da öneksiz) → core hata kodu. */
const TRANSPORT_MAP: Record<string, ErrorCode> = {
  'invalid-argument': 'invalid_argument',
  'out-of-range': 'invalid_argument',
  unauthenticated: 'unauthenticated',
  'permission-denied': 'unauthenticated',
  'resource-exhausted': 'rate_limited',
  unavailable: 'unavailable',
  'deadline-exceeded': 'unavailable',
  cancelled: 'unavailable',
  'failed-precondition': 'share_not_active',
  internal: 'internal',
  unknown: 'internal',
};

/** Herhangi bir hatayı KonumError'a çevirir. */
export function toKonumError(e: unknown): KonumError {
  if (e instanceof KonumError) return e;
  const err = (e ?? {}) as { code?: unknown; details?: unknown; message?: unknown; userInfo?: { details?: unknown } };
  const details = (err.details ?? err.userInfo?.details) as { code?: unknown } | null | undefined;
  if (details && isErrorCode(details.code)) return new KonumError(details.code);
  if (typeof err.code === 'string') {
    const transport = err.code.replace(/^functions\//, '');
    const mapped = TRANSPORT_MAP[transport];
    if (mapped) return new KonumError(mapped);
  }
  // Ağ kopukluğu (RN fetch "Network request failed" vb.)
  if (typeof err.message === 'string' && /network|timeout|offline/i.test(err.message)) return new KonumError('unavailable');
  return new KonumError('internal');
}

/** RTDB yazma reddi mi? (kural reddi: paylaşım bitmiş / süresi dolmuş / ACL henüz yok) */
export function isPermissionDenied(e: unknown): boolean {
  const err = (e ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof err.code === 'string' ? err.code.toLowerCase() : '';
  const msg = typeof err.message === 'string' ? err.message.toLowerCase() : '';
  return code.includes('permission-denied') || code.includes('permission_denied') || msg.includes('permission_denied') || msg.includes('permission denied');
}
