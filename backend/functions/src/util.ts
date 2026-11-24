import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  type DurationChoice,
  type EpochMs,
  type ResolvedDuration,
  offsetFnForTimeZone,
  resolveDuration,
  uuidV4,
} from '@konum/core';
import { phonePepper } from './config';
import { fail } from './errors';

/** core `uuidV4` / `generateInviteCode` için Node'un güvenli rastgele üreteci. */
export const nodeRandom = (n: number): Uint8Array => new Uint8Array(randomBytes(n));

export const newSessionId = (): string => uuidV4(nodeRandom);

export const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

/**
 * Süreyi SUNUCU saatine ve kullanıcının IANA saat dilimine göre hesaplar (yetkili hesap).
 * Geçersiz saat dilimi `invalid_argument`, geçersiz süre `DurationError` → `invalid_duration`.
 */
export function resolveForZone(choice: DurationChoice, timeZone: string, now: EpochMs): ResolvedDuration {
  let offsetAt: (ms: EpochMs) => number;
  try {
    offsetAt = offsetFnForTimeZone(timeZone);
    offsetAt(now);
  } catch {
    throw fail('invalid_argument', { message: 'Saat dilimi geçersiz', extra: { field: 'time_zone' } });
  }
  return resolveDuration(choice, now, offsetAt);
}

/** Firestore `ALREADY_EXISTS` (gRPC 6): `create()` çakışması. */
export const isAlreadyExists = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 6;

export function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** İstemciden gelen belge kimlikleri (friendship_id, request_id ...): `/` içeremez, yol enjeksiyonu olmaz. */
const DOC_ID_RE = /^[A-Za-z0-9_-]{1,300}$/;
export function assertDocId(id: string, field: string): string {
  if (!DOC_ID_RE.test(id)) throw fail('invalid_argument', { extra: { field } });
  return id;
}

/**
 * Sunucunun kabul ettiği uid biçimi: `_` YOK. Belge kimlikleri iki uid'i `_` ile birleştirir
 * (core shareId / friendshipId / requestId); `_` içeren uid'ler ('a_b','c') ile ('a','b_c') çakıştırırdı.
 * Telefonla giriş uid'leri 28 karakter harf-rakamdır. (core uid şeması `_` kabul ediyor → core_requests)
 */
export const SERVER_UID_RE = /^[A-Za-z0-9-]{1,128}$/;
export const isServerUid = (id: string): boolean => SERVER_UID_RE.test(id);
export function assertUid(id: string, field: string): string {
  if (!isServerUid(id)) throw fail('invalid_argument', { extra: { field } });
  return id;
}

/** Anahtarları sıralı JSON (op tekrarında isteğin aynı olduğunu karşılaştırmak için). */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Geri çevrilemez telefon özeti (gizli biberle HMAC-SHA256). Yalnızca sunucuya açık belgelerde. */
export const phoneHmac = (e164: string): string => createHmac('sha256', phonePepper()).update(e164).digest('hex').slice(0, 40);

/**
 * Giden istek kaydının kimliği: isteyen + yöntem + aranan değer. İsteyen bu girdilerin hepsini zaten bilir;
 * kimlik hedef hakkında bilgi taşımaz. Aynı numaraya tekrar istek aynı kaydı tazeler.
 */
export const outgoingId = (uid: string, via: string, value: string): string => sha256Hex(`${uid}|${via}|${value}`).slice(0, 32);
