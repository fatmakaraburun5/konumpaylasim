/**
 * Hata modeli: her callable hatası `HttpsError` olur ve `details.code` core `ERROR_CODES`
 * anahtarlarından birini taşır. İstemci mesajı `ERROR_CODES[code].message` ile gösterir,
 * `retryable` ile tekrar deneyip denemeyeceğine karar verir.
 */
import { DurationError, ERROR_CODES, type ErrorCode } from '@konum/core';
import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/https';
import * as logger from 'firebase-functions/logger';

/** core hata kodu → callable (gRPC) durum kodu. */
const HTTPS_CODE: Record<ErrorCode, FunctionsErrorCode> = {
  invalid_argument: 'invalid-argument',
  invalid_duration: 'invalid-argument',
  not_friends: 'failed-precondition',
  share_not_active: 'failed-precondition',
  already_expired: 'failed-precondition',
  rate_limited: 'resource-exhausted',
  unauthenticated: 'unauthenticated',
  unavailable: 'unavailable',
  internal: 'internal',
  // Faz 2
  link_not_found: 'not-found',
  link_limit_reached: 'resource-exhausted',
  maps_unavailable: 'unavailable',
  quota_exceeded: 'resource-exhausted',
  route_not_found: 'not-found',
  // Faz 4
  no_emergency_contacts: 'failed-precondition',
  sos_not_active: 'failed-precondition',
  note_not_found: 'not-found',
  note_limit_reached: 'resource-exhausted',
  // Faz 5
  zone_not_found: 'not-found',
  zone_limit_reached: 'resource-exhausted',
  meetup_not_found: 'not-found',
  // Faz 6
  gender_required: 'invalid-argument',
  /** Widget hızlı paylaşımı: istemci `details.code` okur; durum kodu yalnızca genel sınıf. */
  token_invalid: 'unauthenticated',
  token_expired: 'unauthenticated',
  not_favorite: 'failed-precondition',
  not_friend: 'failed-precondition',
};

export interface ErrorDetails {
  code: ErrorCode;
  retryable: boolean;
  [extra: string]: unknown;
}

/**
 * Callable hatası üretir. `httpsCode` verilmezse core koduna karşılık gelen durum kullanılır
 * (ör. yarış kaybı için `failed-precondition` + `invalid_argument`).
 */
export function fail(
  code: ErrorCode,
  opts: { message?: string; httpsCode?: FunctionsErrorCode; extra?: Record<string, unknown> } = {},
): HttpsError {
  const def = ERROR_CODES[code];
  const details: ErrorDetails = { code, retryable: def.retryable, ...(opts.extra ?? {}) };
  return new HttpsError(opts.httpsCode ?? HTTPS_CODE[code], opts.message ?? def.message, details);
}

/** gRPC durum kodları (Firestore / Admin SDK hataları). */
const GRPC_ABORTED = 10;
const GRPC_DEADLINE_EXCEEDED = 4;
const GRPC_UNAVAILABLE = 14;
const GRPC_RESOURCE_EXHAUSTED = 8;

/** Beklenmeyen hataları istemciye sızdırmadan `HttpsError`'a çevirir. */
export function toHttpsError(err: unknown, where: string): HttpsError {
  if (err instanceof HttpsError) return err;
  if (err instanceof DurationError) {
    return fail('invalid_duration', { message: err.message, extra: { reason: err.code } });
  }
  const grpc = (err as { code?: unknown } | null)?.code;
  if (grpc === GRPC_ABORTED || grpc === GRPC_DEADLINE_EXCEEDED || grpc === GRPC_UNAVAILABLE || grpc === GRPC_RESOURCE_EXHAUSTED) {
    logger.warn(`${where}: geçici hata`, { err: String(err) });
    return fail('unavailable');
  }
  logger.error(`${where}: beklenmeyen hata`, err);
  return fail('internal');
}
