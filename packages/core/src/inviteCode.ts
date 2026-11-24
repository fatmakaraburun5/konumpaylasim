/**
 * Davet kodu: `LOC-` + 6 karakter, 31 harfli alfabe (0/O, 1/I/L yok) → 31^6 ≈ 887 milyon değer.
 * Örnekteki `LOC-8492` (4 rakam = 10.000 değer) hem çakışır hem kolay taranır. [Varsayım: onay bekliyor]
 * Tekillik sunucuda `invite_codes/{code}` belgesinin `create()` ile yazılmasıyla garanti edilir.
 */
import { defaultRandomBytes } from './ids';

export const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const INVITE_PREFIX = 'LOC-';
export const INVITE_BODY_LENGTH = 6;
export const INVITE_CODE_RE = new RegExp(`^${INVITE_PREFIX}[${INVITE_ALPHABET}]{${INVITE_BODY_LENGTH}}$`);

/** Modulo yanlılığı olmadan rastgele kod üretir. */
export function generateInviteCode(rand: (n: number) => Uint8Array = defaultRandomBytes): string {
  const n = INVITE_ALPHABET.length; // 31
  const limit = 256 - (256 % n); // 248: bunun üstündeki baytlar atılır
  let body = '';
  while (body.length < INVITE_BODY_LENGTH) {
    for (const b of rand(INVITE_BODY_LENGTH * 2)) {
      if (b >= limit) continue;
      body += INVITE_ALPHABET[b % n];
      if (body.length === INVITE_BODY_LENGTH) break;
    }
  }
  return INVITE_PREFIX + body;
}

/**
 * Kullanıcı girişini normalize eder: büyük harf, boşluk/tire temizliği, `LOC` öneki isteğe bağlı,
 * karışan karakterler düzeltilir (O→0 yok sayılmaz: alfabede 0 yok, O → geçersiz; I/L → 1 → geçersiz).
 * Geçersizse null döner (sunucuya hiç gitmez).
 */
export function normalizeInviteCode(input: string): string | null {
  let s = input.normalize('NFKC').toUpperCase().replace(/[\s\-_.]/g, '');
  // Türkçe klavye: 'ı' → 'I' (toUpperCase), 'i' → 'İ' olabilir
  s = s.replace(/İ/g, 'I');
  if (s.startsWith('LOC')) s = s.slice(3);
  if (s.length !== INVITE_BODY_LENGTH) return null;
  const code = INVITE_PREFIX + s;
  return INVITE_CODE_RE.test(code) ? code : null;
}

/** Ekranda gösterim: `LOC-7KQ 2MX` gibi okunması kolay gruplama. */
export function formatInviteCode(code: string): string {
  return code.length === INVITE_PREFIX.length + INVITE_BODY_LENGTH
    ? `${code.slice(0, 7)} ${code.slice(7)}`
    : code;
}
