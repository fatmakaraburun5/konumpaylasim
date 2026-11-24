/**
 * Telefon numarası: her yerde E.164 (`+905XXXXXXXXX`).
 * Yerel girişler ("0532 123 45 67", "532 123 4567") varsayılan bölge TR ile çevrilir.
 */
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

export const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Faz 1'de yalnızca Türkiye cep numaralarına SMS gönderilir (SMS pompalama savunması). [Varsayım] */
export const ALLOWED_SMS_RE = /^\+905\d{9}$/;

export type PhoneNormalizeResult =
  | { ok: true; e164: string; national: string }
  | { ok: false; reason: 'invalid' | 'not_mobile_tr' };

export function normalizePhone(input: string, defaultRegion: CountryCode = 'TR'): PhoneNormalizeResult {
  const parsed = parsePhoneNumberFromString(input.trim(), defaultRegion);
  if (!parsed || !parsed.isValid()) return { ok: false, reason: 'invalid' };
  const e164 = parsed.number;
  if (!E164_RE.test(e164)) return { ok: false, reason: 'invalid' };
  if (!ALLOWED_SMS_RE.test(e164)) return { ok: false, reason: 'not_mobile_tr' };
  return { ok: true, e164, national: parsed.formatNational() };
}

/** Arkadaş ararken (SMS gönderilmeyecek) TR kısıtı olmadan yalnızca E.164'e çevirir. */
export function toE164(input: string, defaultRegion: CountryCode = 'TR'): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), defaultRegion);
  return parsed?.isValid() && E164_RE.test(parsed.number) ? parsed.number : null;
}

/** Ekranda maskeli gösterim: +90 5•• ••• 45 67 */
export function maskPhone(e164: string): string {
  if (!E164_RE.test(e164)) return e164;
  const cc = e164.startsWith('+90') ? '+90' : e164.slice(0, 3);
  const rest = e164.slice(cc.length);
  return `${cc} ${rest[0] ?? ''}•• ••• ${rest.slice(-4, -2)} ${rest.slice(-2)}`;
}
