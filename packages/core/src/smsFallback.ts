/**
 * Faz 9: çevrimdışı SOS SMS yedeği. Ayrıntı: docs/PHASE9.md §4.
 *
 *  - İnternet tamamen kesikken SOS tetiklenirse (ya da `sos_send` ağ hatasıyla düşerse) cihaz, önbellekteki SON
 *    DOĞRULANMIŞ GPS konumunu, zaman damgasını, pil yüzdesini ve harita bağlantısını içeren HAZIR DOLU bir mesajı
 *    cihazın yerel SMS uygulamasında açar; kullanıcı tek dokunuşla gönderir.
 *      iOS: `MFMessageComposeViewController` (expo-sms). iOS üçüncü taraf uygulamaların SMS'i kendiliğinden
 *      göndermesine İZİN VERMEZ; mesajı kullanıcı gönderir.
 *      Android: `ACTION_SENDTO` `smsto:` intent (expo-sms) — SEND_SMS izni GEREKMEZ, Play SMS politikasına uygundur.
 *      Doğrudan arka plan gönderimi (SEND_SMS) yalnızca derleme bayrağıyla (`ANDROID_DIRECT_SMS=1`) ve Play'den
 *      izin istisnası alınırsa açılır [Varsayım: varsayılan kapalı].
 *  - SMS numaraları ve tercih YALNIZCA cihazda saklanır (`SMS_FALLBACK_STORAGE_KEY`); rehber sunucuya gitmez.
 *    Faz 4 acil kişileri uygulama içi arkadaşlardır ve numaraları bize görünmez (KVKK), bu yüzden SMS için ayrı,
 *    rehberden seçilen ya da elle yazılan numaralar tutulur.
 *  - Uygulama SMS'leri OKUMAZ; gelen SMS izni yoktur.
 *  - Ağ gelince SOS ayrıca normal yoldan (outbox) gönderilir; SMS ek bir yoldur, yerine geçmez.
 */
import { z } from 'zod';
import { formatCoord } from './sos';
import { formatClock } from './format';
import { toE164, E164_RE, maskPhone } from './phone';
import { MINUTE, type EpochMs, type OffsetFn, deviceOffset } from './time';

export const SMS_FALLBACK_STORAGE_KEY = 'konum.sms_fallback.v1';

export const SMS_FALLBACK_LIMITS = {
  maxNumbers: 5,
  labelMaxChars: 40,
  /** SOS gönderimi bu kadar sürede başarılı olmazsa SMS önerilir (çevrimiçi görünse bile). [Varsayım] */
  onlineTimeoutMs: 10_000,
  /** Bundan eski son konum mesajda "x dk önce" ile belirtilir. */
  staleFixMs: 2 * MINUTE,
} as const;

export interface SmsFallbackNumber {
  /** Rehberdeki ad ya da kullanıcının yazdığı etiket. */
  label: string;
  e164: string;
  source: 'contacts' | 'manual';
}

/** Cihazda saklanan tercih (sunucuya gitmez). */
export interface SmsFallbackSettings {
  /** Kullanıcı SMS yedeğine açık onay verdi mi. */
  enabled: boolean;
  numbers: SmsFallbackNumber[];
  /** Onboarding / Gizlilik Merkezi'nde karar verildi (açık ya da kapalı). */
  decided_at: EpochMs | null;
}

export const DEFAULT_SMS_FALLBACK: SmsFallbackSettings = Object.freeze({ enabled: false, numbers: [], decided_at: null }) as SmsFallbackSettings;

const SmsNumberSchema = z.object({
  label: z.string().max(SMS_FALLBACK_LIMITS.labelMaxChars * 2),
  e164: z.string().regex(E164_RE),
  source: z.enum(['contacts', 'manual']).catch('manual'),
});

/** Cihazdan okunan tercih; bozuksa varsayılan. Tekrarlanan numaralar ve fazlası atılır. */
export function parseSmsFallback(raw: unknown): SmsFallbackSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SMS_FALLBACK, numbers: [] };
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(r.numbers) ? r.numbers : [];
  const seen = new Set<string>();
  const numbers: SmsFallbackNumber[] = [];
  for (const n of list) {
    const p = SmsNumberSchema.safeParse(n);
    if (!p.success || seen.has(p.data.e164)) continue;
    seen.add(p.data.e164);
    numbers.push({ ...p.data, label: sanitizeLabel(p.data.label) });
    if (numbers.length >= SMS_FALLBACK_LIMITS.maxNumbers) break;
  }
  return { enabled: r.enabled === true, numbers, decided_at: typeof r.decided_at === 'number' ? r.decided_at : null };
}

function sanitizeLabel(s: string): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, SMS_FALLBACK_LIMITS.labelMaxChars).join('') || 'Acil kişi';
}

/** Rehberden / elle gelen numarayı ekler (E.164'e çevrilir; geçersiz ya da tekrar → hata nedeni). */
export function addSmsNumber(
  s: SmsFallbackSettings,
  input: { label: string; phone: string; source: SmsFallbackNumber['source'] },
): { ok: true; settings: SmsFallbackSettings; number: SmsFallbackNumber } | { ok: false; reason: 'invalid' | 'duplicate' | 'limit' } {
  const e164 = toE164(input.phone);
  if (!e164) return { ok: false, reason: 'invalid' };
  if (s.numbers.some((n) => n.e164 === e164)) return { ok: false, reason: 'duplicate' };
  if (s.numbers.length >= SMS_FALLBACK_LIMITS.maxNumbers) return { ok: false, reason: 'limit' };
  const number: SmsFallbackNumber = { label: sanitizeLabel(input.label), e164, source: input.source };
  return { ok: true, settings: { ...s, numbers: [...s.numbers, number] }, number };
}

export const removeSmsNumber = (s: SmsFallbackSettings, e164: string): SmsFallbackSettings => ({ ...s, numbers: s.numbers.filter((n) => n.e164 !== e164) });

// --- mesaj ---------------------------------------------------------------------------------

/** Kısa, evrensel harita bağlantısı (her telefonda açılır; SMS'te kısa olsun diye). */
export function smsMapsUrl(lat: number, lng: number): string {
  return `https://maps.google.com/?q=${formatCoord(lat)},${formatCoord(lng)}`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "26.11.2026 14:05" (yerel saat). */
export function formatSmsTimestamp(at: EpochMs, offsetAt: OffsetFn = deviceOffset): string {
  const local = new Date(at + offsetAt(at) * MINUTE);
  return `${pad2(local.getUTCDate())}.${pad2(local.getUTCMonth() + 1)}.${local.getUTCFullYear()} ${formatClock(at, offsetAt)}`;
}

export interface SosSmsInput {
  senderName: string;
  fix: { lat: number; lng: number; accuracy: number; timestamp: EpochMs } | null;
  battery_pct: number | null;
  now: EpochMs;
  offsetAt?: OffsetFn;
  /** Güvenli Dönüş alarmında "Güvenli Dönüş: Ev hedefine varamadım" eklenir. */
  safeReturnDest?: string | null;
}

/**
 * Hazır SMS gövdesi (satırlar `\n`). Örnek:
 *   ACİL: Ayşe Yılmaz tehlikede, internet yok.
 *   Son doğrulanmış konum: 41.008240,28.978359 (±12 m) · 26.11.2026 14:05 (3 dk önce) · Pil %23
 *   https://maps.google.com/?q=41.008240,28.978359
 *   Hayati tehlikede 112'yi ara.
 * Konum yoksa "Konum alınamadı" yazılır (yine de gönderilebilir).
 */
export function sosSmsBody(i: SosSmsInput): string {
  const name = i.senderName.trim() || 'Arkadaşın';
  const head = [`ACİL: ${name} tehlikede, internet yok.`];
  if (i.safeReturnDest) head.push(`Güvenli Dönüş: ${i.safeReturnDest} hedefine varamadım.`);
  const details: string[] = [];
  if (i.fix) {
    const age = i.now - i.fix.timestamp;
    const when = formatSmsTimestamp(i.fix.timestamp, i.offsetAt);
    const ago = age > SMS_FALLBACK_LIMITS.staleFixMs ? ` (${Math.round(age / MINUTE)} dk önce)` : '';
    const acc = i.fix.accuracy < 10 ? i.fix.accuracy.toFixed(0) : String(Math.round(i.fix.accuracy));
    details.push(`Son doğrulanmış konum: ${formatCoord(i.fix.lat)},${formatCoord(i.fix.lng)} (±${acc} m)`, `${when}${ago}`);
  } else {
    details.push('Konum alınamadı');
  }
  if (i.battery_pct !== null && Number.isFinite(i.battery_pct)) details.push(`Pil %${Math.round(i.battery_pct)}`);
  const lines = [head.join(' '), details.join(' · ')];
  // Bağlantı kendi satırında: sonuna noktalama gelmesin (bazı telefonlar bağlantıyı bozar).
  if (i.fix) lines.push(smsMapsUrl(i.fix.lat, i.fix.lng));
  lines.push("Hayati tehlikede 112'yi ara.");
  return lines.join('\n');
}

// --- karar ---------------------------------------------------------------------------------

export type SosSendOutcome = 'pending' | 'sent' | 'failed_network' | 'failed_other';

export type OfflineSosDecision =
  /** Normal yol (bekle / başarılı). */
  | 'online'
  /** SMS yedeğini öner (tek dokunuş). */
  | 'offer_sms'
  /** Ağ yok ama SMS ayarlanmamış: Gizlilik Merkezi / acil numaralar yönlendirmesi. */
  | 'sms_not_configured'
  /** Ağ yok ve cihaz SMS gönderemiyor (ör. SIM yok, tablet, web). */
  | 'sms_unavailable';

/**
 * İnternet yokken (ya da `sos_send` ağ hatasıyla düştüyse ya da `onlineTimeoutMs` içinde yanıt gelmediyse) ne
 * gösterilecek? Kullanıcı SMS yedeğine açık onay vermediyse SMS önerilmez, yalnızca nasıl açılacağı söylenir.
 */
export function offlineSosDecision(i: {
  online: boolean | null;
  outcome: SosSendOutcome;
  waitedMs: number;
  settings: Pick<SmsFallbackSettings, 'enabled' | 'numbers'>;
  smsAvailable: boolean | null;
}): OfflineSosDecision {
  const offline = i.online === false || i.outcome === 'failed_network' || (i.outcome === 'pending' && i.waitedMs >= SMS_FALLBACK_LIMITS.onlineTimeoutMs);
  if (!offline || i.outcome === 'sent') return 'online';
  if (i.smsAvailable === false) return 'sms_unavailable';
  if (!i.settings.enabled || i.settings.numbers.length === 0) return 'sms_not_configured';
  return 'offer_sms';
}

export const SMS_FALLBACK_TEXT = {
  title: 'SMS ile acil durum yedeği',
  body: "İnternet tamamen kesikken SOS'a basarsan son doğrulanmış konumun, saat, pil yüzden ve harita bağlantısı hazır bir SMS olarak telefonunun mesaj uygulamasında açılır; Gönder'e dokunman yeter.",
  consent: "SMS yedeğine açık onay veriyorum: SOS sırasında internet yoksa konum bilgilerim seçtiğim numaralara gönderilmek üzere telefonumun mesaj uygulamasında hazırlansın.",
  iosNote: "iPhone'da uygulamalar SMS'i kendiliğinden gönderemez: Mesajlar açılır, Gönder'e sen dokunursun.",
  androidNote: "Android'de mesaj, SMS uygulamanda hazır açılır; uygulama SMS'lerini okumaz.",
  costNote: 'SMS, operatörün üzerinden şifrelenmeden iletilir ve ücretli olabilir.',
  numbersTitle: 'SMS acil numaraları',
  numbersHint: 'Rehberinden seç ya da numarayı yaz. Numaralar yalnızca bu telefonda saklanır.',
  pickFromContacts: 'Rehberden seç',
  addManual: 'Numara yaz',
  invalidNumber: 'Geçerli bir telefon numarası gir.',
  duplicateNumber: 'Bu numara zaten listede.',
  limitReached: `En çok ${SMS_FALLBACK_LIMITS.maxNumbers} numara ekleyebilirsin.`,
  offlineTitle: 'İnternet yok',
  offlineBody: "SOS sunucuya ulaşamadı. Acil durum mesajını SMS ile gönder; internet gelince SOS ayrıca uygulama üzerinden de gönderilecek.",
  sendSms: (n: number): string => `SMS ile gönder (${n} kişi)`,
  notConfigured: 'SMS yedeği kapalı ya da numara yok. Gizlilik Merkezi > SMS ile acil durum yedeği.',
  unavailable: 'Bu cihaz SMS gönderemiyor. Güvendeysen bağlantı gelince SOS kendiliğinden gönderilecek.',
  call112: "112'yi ara",
  sentResult: { sent: 'SMS gönderildi.', cancelled: 'SMS gönderilmedi.', unknown: 'Mesaj uygulaması açıldı.' },
} as const;

/** Gizlilik Merkezi satırı için kısa durum: "Açık · 2 numara" / "Kapalı". */
export function smsFallbackStatus(s: Pick<SmsFallbackSettings, 'enabled' | 'numbers'>): string {
  if (!s.enabled) return 'Kapalı';
  return s.numbers.length === 0 ? 'Açık · numara yok' : `Açık · ${s.numbers.length} numara`;
}

/** Listede gösterim: "Annem · +90 5•• ••• 45 67". */
export const formatSmsNumber = (n: SmsFallbackNumber): string => `${n.label} · ${maskPhone(n.e164)}`;
