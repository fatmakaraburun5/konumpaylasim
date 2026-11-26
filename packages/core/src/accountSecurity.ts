/**
 * Faz 10: İki aşamalı hesap kurtarma (SMS + e-posta / Gmail), yeni telefona geçiş ve çoklu cihaz oturum yönetimi
 * (bkz. docs/PHASE10.md §3).
 *
 * Kavramlar:
 *  - **Cihaz oturumu** (`device_sessions/{dsid}`): her kurulum (install_id) için sunucunun verdiği oturum. Firebase
 *    kimliği kullanıcı başınadır; cihaz başına iptal için sunucu, cihaz etkinleşince `dsid` ÖZEL İDDİALI (custom claim)
 *    bir custom token üretir, istemci onunla yeniden oturum açar. Böylece her istek (callable, Firestore, RTDB) hangi
 *    cihazdan geldiğini taşır ve iptal edilen cihaz ANINDA reddedilir: callable ara katmanı + Firestore / RTDB
 *    kuralları `revoked_devices/{uid}_{dsid}` (RTDB `revoked_devices/{uid}/{dsid}`) kara listesine bakar. İlk cihaz
 *    kaydı yapılınca `dsid`'siz (eski / yarım) belirteçler de `legacy` işaretiyle kapanır.
 *  - **Kurtarma kanalları**: telefon numarası (SMS OTP) ve e-posta / Gmail adresi (e-posta OTP). İkisi de doğrulanınca
 *    "İki aşamalı kurtarma açık". Kodlar sunucuda üretilir, yalnızca HMAC özeti saklanır (10 dk, 5 deneme), gönderim
 *    `AuthVerificationProvider` arayüzü arkasındadır (şimdi sahte / yerel adaptör; Twilio / Netgsm / SendGrid / Gmail API
 *    canlı kurulumda bağlanır).
 *  - **Yeni telefona geçiş**: yeni cihaz telefonla giriş yapar (SMS = 1. aşama, Firebase Phone Auth) → `device_register`
 *    bu hesapta başka etkin cihaz ya da doğrulanmış e-posta varsa cihazı `pending` bırakır ve e-postaya kod yollar
 *    (2. aşama) → doğrulanınca cihaz `active`, custom token döner. Veriler uid'e bağlı olduğundan sunucuda zaten
 *    durur; taşıma = yeni cihazın aynı uid'le bağlanması + `account_migration_manifest` ile EKSİKSİZLİK denetimi
 *    (arkadaşlıklar, yönlü izinler, favoriler, bölgeler, KVKK onayı: sayı + özet; istemci yüklediği veriden aynı özeti
 *    hesaplar ve karşılaştırır). Cihaza bağlı olanlar (OS izinleri, SMS yedeği numaraları, widget, takvim eşlemesi,
 *    QR token'ları) yeni cihazda yeniden kurulur; liste `MIGRATION_DEVICE_LOCAL`.
 *  - **Eski cihazı kapat**: "Aktif Cihazlar ve Oturumlar" → "Eski Cihazdaki Oturumu ve Konum Yayınını Kapat" →
 *    `device_revoke`: kara liste (anında), o cihazın FCM token'larına sessiz `session_revoked` push'u (arka plan konum
 *    görevini durdurur, yerel veriyi siler, oturumu kapatır), token'lar silinir. İsteğe bağlı olarak açık
 *    paylaşımlar da durdurulur; aksi hâlde paylaşımlar bu telefondan yayınlanmaya devam eder.
 */
import { z } from 'zod';
import { sha256Hex } from './link';
import type { UserId } from './model';
import { DAY, MINUTE, SECOND, type EpochMs } from './time';

// --- sınırlar -------------------------------------------------------------------------------

export const SECURITY_LIMITS = {
  otpDigits: 6,
  /** Kodun geçerlilik süresi. */
  otpTtlMs: 10 * MINUTE,
  /** Kod başına en çok yanlış deneme (sonra kod yanar). */
  otpMaxAttempts: 5,
  /** Yeniden gönderme bekleme süresi. */
  otpResendMs: 60 * SECOND,
  /** Bir kod kaydı için en çok gönderim (ilk + 2 yeniden). */
  otpMaxSends: 3,
  /** Kullanıcı başına günlük kod gönderimi (kanal fark etmez). [Varsayım] */
  otpSendsPerDay: 10,
  /** Kullanıcı başına saatlik yanlış kod. [Varsayım] */
  otpFailuresPerHour: 10,
  /** Kullanıcı başına en çok etkin cihaz (fazlası en eski etkinden düşer). [Varsayım] */
  maxActiveDevices: 5,
  /** Heartbeat en sık (yayın durumu değişmedikçe). */
  heartbeatMinIntervalMs: 5 * MINUTE,
  /** Bu kadar süre görülmeyen cihaz "uzun süredir etkin değil". */
  idleAfterMs: 30 * DAY,
  /** İptal / bekleyen kayıtların saklanması. [Varsayım] */
  retentionMs: 30 * DAY,
  /** OTP kayıtlarının saklanması (TTL). */
  otpRetentionMs: DAY,
  emailMaxChars: 254,
  modelMaxChars: 60,
} as const;

// --- kimlikler ve kara liste ------------------------------------------------------------------

/** 20 karakter base64url (sunucu `randomBytes(15)`). */
export const DSID_RE = /^[A-Za-z0-9_-]{20}$/;
export const CHALLENGE_ID_RE = /^[A-Za-z0-9_-]{20}$/;
/** `dsid` iddiası olmayan belirteçlerin kara liste anahtarı (ilk cihaz kaydından sonra). */
export const LEGACY_DSID = 'legacy';
/** Custom token iddiası adı (ID token'da `request.auth.token.dsid`). */
export const DSID_CLAIM = 'dsid';

export const revokedDeviceKey = (uid: UserId, dsid: string | null | undefined): string => `${uid}_${dsid ?? LEGACY_DSID}`;

/** `dsid`'siz çalışmak ZORUNDA olan callable'lar (yeni cihaz henüz oturum almadı). */
export const DEVICE_GATE_EXEMPT = ['device_register', 'device_second_factor_send', 'device_second_factor_verify'] as const;

// --- cihaz oturumu ----------------------------------------------------------------------------

export const DEVICE_PLATFORMS = ['ios', 'android', 'web'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];
export const DEVICE_STATUSES = ['pending', 'active', 'revoked'] as const;
export type DeviceSessionStatus = (typeof DEVICE_STATUSES)[number];
export const DEVICE_REVOKE_REASONS = ['remote', 'all_others', 'signed_out', 'replaced', 'limit', 'account_recovery'] as const;
export type DeviceRevokeReason = (typeof DEVICE_REVOKE_REASONS)[number];
export const VERIFICATION_CHANNELS = ['sms', 'email'] as const;
export type VerificationChannel = (typeof VERIFICATION_CHANNELS)[number];

/** Firestore `device_sessions/{dsid}`: sahibi okur (sorgu `owner_id == ben`), YALNIZCA sunucu yazar. */
export interface DeviceSessionDoc {
  dsid: string;
  owner_id: UserId;
  /** install_id'nin SHA-256 özeti (aynı kurulum yeniden kaydolursa aynı oturum). */
  install_hash: string;
  platform: DevicePlatform;
  model: string;
  os_version: string | null;
  app_version: string | null;
  status: DeviceSessionStatus;
  created_at: EpochMs;
  activated_at: EpochMs | null;
  last_seen_at: EpochMs;
  /** Arka plan konum yayını açık mı (cihazın son heartbeat'i). */
  publishing: boolean;
  publishing_at: EpochMs | null;
  /** Hangi aşamalarla etkinleşti: telefonla giriş = `sms`, ikinci aşama = `email`. */
  verified_by: VerificationChannel[];
  revoked_at: EpochMs | null;
  revoke_reason: DeviceRevokeReason | null;
  /** İptali yapan cihaz (kendisi ise kendi dsid'i). */
  revoked_by: string | null;
}

export const DeviceInfoSchema = z.object({
  /** Kurulum kimliği (cihazda bir kez üretilir, `konum.device.id.v1`). */
  install_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  platform: z.enum(DEVICE_PLATFORMS),
  model: z.string().min(1).max(SECURITY_LIMITS.modelMaxChars * 2),
  os_version: z.string().max(40).nullable().default(null),
  app_version: z.string().max(40).nullable().default(null),
});
export type DeviceInfo = z.input<typeof DeviceInfoSchema>;

/** Cihaz adı temizliği: kontrol karakterleri atılır, 60 karakter. */
export function cleanDeviceModel(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, SECURITY_LIMITS.modelMaxChars).join('') || 'Bilinmeyen cihaz';
}

export const DeviceSessionDocSchema: z.ZodType<DeviceSessionDoc> = z.object({
  dsid: z.string(),
  owner_id: z.string(),
  install_hash: z.string(),
  platform: z.enum(DEVICE_PLATFORMS),
  model: z.string(),
  os_version: z.string().nullable(),
  app_version: z.string().nullable(),
  status: z.enum(DEVICE_STATUSES),
  created_at: z.number(),
  activated_at: z.number().nullable(),
  last_seen_at: z.number(),
  publishing: z.boolean(),
  publishing_at: z.number().nullable(),
  verified_by: z.array(z.enum(VERIFICATION_CHANNELS)),
  revoked_at: z.number().nullable(),
  revoke_reason: z.enum(DEVICE_REVOKE_REASONS).nullable(),
  revoked_by: z.string().nullable(),
});

export function parseDeviceSession(raw: unknown): DeviceSessionDoc | null {
  const r = DeviceSessionDocSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// --- doğrulama kodu (OTP) ------------------------------------------------------------------

export const VERIFICATION_PURPOSES = ['link_email', 'verify_phone', 'device_second_factor'] as const;
export type VerificationPurpose = (typeof VERIFICATION_PURPOSES)[number];

/** İstemcinin gördüğü kod kaydı (alıcı maskeli). `dev_code` YALNIZCA emülatör / demo. */
export interface ChallengeView {
  challenge_id: string;
  channel: VerificationChannel;
  purpose: VerificationPurpose;
  to_masked: string;
  expires_at: EpochMs;
  resend_at: EpochMs;
  attempts_left: number;
  dev_code?: string;
}

export const ChallengeViewSchema: z.ZodType<ChallengeView> = z.object({
  challenge_id: z.string(),
  channel: z.enum(VERIFICATION_CHANNELS),
  purpose: z.enum(VERIFICATION_PURPOSES),
  to_masked: z.string(),
  expires_at: z.number(),
  resend_at: z.number(),
  attempts_left: z.number(),
  dev_code: z.string().optional(),
});

/** Sunucu kaydı `verification_challenges/{id}` (istemciye kapalı, TTL `purge_at`). */
export interface ChallengeRecord {
  challenge_id: string;
  owner_id: UserId;
  channel: VerificationChannel;
  purpose: VerificationPurpose;
  /** Alıcı (yalnızca sunucuda; e-posta küçük harf, telefon E.164). */
  to: string;
  to_masked: string;
  /** HMAC-SHA256(biber, `${challenge_id}:${code}`). Düz kod SAKLANMAZ. */
  code_hash: string;
  attempts: number;
  sends: number;
  state: 'pending' | 'verified' | 'failed' | 'expired';
  created_at: EpochMs;
  expires_at: EpochMs;
  resend_at: EpochMs;
  /** `device_second_factor` için hangi cihaz. */
  dsid: string | null;
}

export type OtpCheck =
  | { ok: true; record: ChallengeRecord }
  | { ok: false; code: 'otp_invalid' | 'otp_expired' | 'otp_locked'; record: ChallengeRecord };

/**
 * Kod denetimi (saf): süre, deneme sınırı, özet karşılaştırması. `hashOf(code)` çağıranın HMAC'idir; karşılaştırma
 * sabit zamanlıdır (`constantTimeEqual`). Yanlış kod denemeyi artırır, son denemede kayıt `failed` olur.
 */
export function checkOtp(rec: ChallengeRecord, code: string, hashOf: (code: string) => string, now: EpochMs): OtpCheck {
  if (rec.state === 'failed') return { ok: false, code: 'otp_locked', record: rec };
  if (rec.state !== 'pending' || now >= rec.expires_at) return { ok: false, code: 'otp_expired', record: { ...rec, state: rec.state === 'pending' ? 'expired' : rec.state } };
  const clean = code.replace(/\D/g, '');
  if (clean.length === SECURITY_LIMITS.otpDigits && constantTimeEqual(hashOf(clean), rec.code_hash)) {
    return { ok: true, record: { ...rec, state: 'verified', attempts: rec.attempts + 1 } };
  }
  const attempts = rec.attempts + 1;
  const locked = attempts >= SECURITY_LIMITS.otpMaxAttempts;
  return { ok: false, code: locked ? 'otp_locked' : 'otp_invalid', record: { ...rec, attempts, state: locked ? 'failed' : 'pending' } };
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 0–999999 → 6 hane (sunucu `crypto.randomInt(0, 1e6)`). */
export const formatOtp = (n: number): string => String(Math.floor(Math.abs(n)) % 10 ** SECURITY_LIMITS.otpDigits).padStart(SECURITY_LIMITS.otpDigits, '0');

export function challengeView(rec: ChallengeRecord, devCode?: string): ChallengeView {
  const v: ChallengeView = {
    challenge_id: rec.challenge_id,
    channel: rec.channel,
    purpose: rec.purpose,
    to_masked: rec.to_masked,
    expires_at: rec.expires_at,
    resend_at: rec.resend_at,
    attempts_left: Math.max(0, SECURITY_LIMITS.otpMaxAttempts - rec.attempts),
  };
  if (devCode) v.dev_code = devCode;
  return v;
}

// --- e-posta ---------------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Küçük harf + boşluksuz; Gmail için noktalar ve `+etiket` aynı kutuya gider ama adres OLDUĞU GİBİ saklanır. */
export function normalizeEmail(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (t.length > SECURITY_LIMITS.emailMaxChars || !EMAIL_RE.test(t)) return null;
  return t;
}

export const isGmail = (email: string): boolean => /@(gmail|googlemail)\.com$/i.test(email);

/** "deniz.kaya@gmail.com" → "d••••••••a@gmail.com". */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const chars = Array.from(local);
  if (chars.length <= 2) return `${chars[0] ?? ''}•@${domain}`;
  return `${chars[0]}${'•'.repeat(Math.min(8, chars.length - 2))}${chars[chars.length - 1]}@${domain}`;
}

// --- sağlayıcı arayüzü (sunucu ve demo adaptörleri) -------------------------------------------------

/**
 * Harici SMS / e-posta gönderimi bu arayüzün arkasındadır. Şimdi: `mock_sms` / `mock_email` (emülatör / demo; kod
 * yalnızca geliştirme yanıtında ve sunucu günlüğünde maskeli). Canlı kurulumda: `twilio_verify` / `netgsm` (SMS),
 * `sendgrid` / `gmail_api` (e-posta). Google ile doğrulama (OAuth `email_verified`) ileride aynı kanala eklenir.
 */
export interface AuthVerificationProvider {
  readonly channel: VerificationChannel;
  readonly id: string;
  send(msg: VerificationMessage): Promise<VerificationSendResult>;
}

export interface VerificationMessage {
  to: string;
  code: string;
  purpose: VerificationPurpose;
  /** Hazır metin (`verificationSmsText` / `verificationEmail`). */
  text: string;
  subject?: string;
}

export type VerificationSendResult = { ok: true; provider_ref: string | null } | { ok: false; reason: 'invalid_destination' | 'provider_unavailable' | 'rate_limited' };

const PURPOSE_TEXT: Record<VerificationPurpose, string> = {
  link_email: 'kurtarma e-postanı doğrulamak',
  verify_phone: 'kurtarma numaranı doğrulamak',
  device_second_factor: 'yeni cihazda hesabına girmek',
};

export function verificationSmsText(code: string, purpose: VerificationPurpose): string {
  return `Konum doğrulama kodun: ${code}. Bu kod ${PURPOSE_TEXT[purpose]} için. Kimseyle paylaşma. 10 dk geçerli.`;
}

export function verificationEmail(code: string, purpose: VerificationPurpose, deviceModel?: string | null): { subject: string; text: string } {
  const subject = purpose === 'device_second_factor' ? `Konum: yeni cihaz girişi kodu ${code}` : `Konum doğrulama kodu: ${code}`;
  const lines = [
    'Merhaba,',
    '',
    `Konum doğrulama kodun: ${code}`,
    `Bu kod ${PURPOSE_TEXT[purpose]} için ve 10 dakika geçerli.`,
  ];
  if (purpose === 'device_second_factor' && deviceModel) lines.push('', `Giriş yapmaya çalışan cihaz: ${deviceModel}.`);
  lines.push('', 'Bu isteği sen yapmadıysan kodu kimseyle paylaşma; uygulamada Profil → Güvenlik → Aktif Cihazlar ve Oturumlar’dan cihazlarını kontrol et.');
  return { subject, text: lines.join('\n') };
}

// --- kurtarma özeti ----------------------------------------------------------------------------

/** Firestore `users/{uid}/security/recovery` (sahibi okur, sunucu yazar): maskeli kanal özeti. */
export interface RecoverySummary {
  sms: { masked: string; verified_at: EpochMs | null } | null;
  email: { masked: string; verified_at: EpochMs | null; gmail: boolean } | null;
  /** İki kanal da doğrulandı: yeni cihaz ikinci aşama (e-posta) ister. */
  two_step: boolean;
  updated_at: EpochMs;
}

export const RecoverySummarySchema: z.ZodType<RecoverySummary> = z.object({
  sms: z.object({ masked: z.string(), verified_at: z.number().nullable() }).nullable(),
  email: z.object({ masked: z.string(), verified_at: z.number().nullable(), gmail: z.boolean() }).nullable(),
  two_step: z.boolean(),
  updated_at: z.number(),
});

export const EMPTY_RECOVERY: RecoverySummary = { sms: null, email: null, two_step: false, updated_at: 0 };

export function recoveryStatusText(r: RecoverySummary): { title: string; tone: 'ok' | 'warn' } {
  if (r.two_step) return { title: 'İki aşamalı kurtarma açık', tone: 'ok' };
  if (r.email?.verified_at) return { title: 'Telefon numaranı da doğrula', tone: 'warn' };
  return { title: 'E-posta / Gmail adresi ekle', tone: 'warn' };
}

/**
 * Yeni (bu hesapta daha önce görülmemiş) cihaz için ikinci aşama: kurtarma e-postası doğrulanmışsa HER ZAMAN e-posta
 * kodu istenir (eski telefon kaybolmuş / iptal edilmiş olabilir; SIM'i ele geçiren tek başına giremesin). E-posta yoksa
 * tek aşama (SMS) yeterli, ama diğer etkin cihazlara "yeni cihaz girişi" bildirimi gider.
 */
export function needsSecondFactor(i: { emailVerified: boolean; knownInstall: boolean }): 'email' | 'none' {
  return i.emailVerified && !i.knownInstall ? 'email' : 'none';
}

// --- taşıma bildirimi (eksiksizlik denetimi) --------------------------------------------------------

export const MIGRATION_KINDS = ['friendships', 'permission_grants', 'favorites', 'zones', 'consents'] as const;
export type MigrationKind = (typeof MIGRATION_KINDS)[number];

export interface MigrationItemSummary {
  count: number;
  digest: string;
}

export interface MigrationManifest {
  generated_at: EpochMs;
  items: Record<MigrationKind, MigrationItemSummary>;
}

/** Sıralı kanonik anahtarlar → 16 hane özet (sunucu ve istemci aynı fonksiyonu kullanır). */
export function migrationDigest(keys: readonly string[]): MigrationItemSummary {
  const sorted = [...keys].sort();
  return { count: sorted.length, digest: sha256Hex(JSON.stringify(sorted)).slice(0, 16) };
}

/** Favoriler sıralıdır: sıra da özete girer. */
export function orderedDigest(keys: readonly string[]): MigrationItemSummary {
  return { count: keys.length, digest: sha256Hex(JSON.stringify(keys.map((k, i) => `${i}:${k}`))).slice(0, 16) };
}

/** Kanonik anahtarlar. */
export const migrationKeys = {
  friendship: (friendId: UserId): string => friendId,
  grant: (granterId: UserId, granteeId: UserId, scopes: readonly string[]): string => `${granterId}>${granteeId}:${[...scopes].sort().join(',')}`,
  zone: (zoneId: string): string => zoneId,
  consent: (version: string, acceptedAt: EpochMs | null): string => `${version}@${acceptedAt ?? 'none'}`,
};

export interface MigrationCheckRow {
  kind: MigrationKind;
  title: string;
  server: MigrationItemSummary;
  local: MigrationItemSummary | null;
  ok: boolean;
  detail: string;
}

export const MIGRATION_TITLES: Record<MigrationKind, string> = {
  friendships: 'Arkadaşlar',
  permission_grants: 'Kişi izinleri (verdiğin ve aldığın)',
  favorites: 'Favoriler',
  zones: 'Kayıtlı bölgeler',
  consents: 'Güvenlik Sözleşmesi ve KVKK onayı',
};

/** Sunucu bildirimi ile cihazın yüklediği veriyi karşılaştırır. `local` null = henüz yüklenmedi. */
export function compareMigration(manifest: MigrationManifest, local: Partial<Record<MigrationKind, MigrationItemSummary>>): MigrationCheckRow[] {
  return MIGRATION_KINDS.map((kind) => {
    const server = manifest.items[kind];
    const l = local[kind] ?? null;
    const ok = !!l && l.count === server.count && l.digest === server.digest;
    const detail = !l ? 'Yükleniyor…' : ok ? `${server.count} kayıt · eksiksiz` : `Sunucuda ${server.count}, bu cihazda ${l.count}: yeniden denenecek`;
    return { kind, title: MIGRATION_TITLES[kind], server, local: l, ok, detail };
  });
}

/** Yeni cihazda yeniden kurulan, sunucuya hiç gitmeyen ya da cihaza bağlı olanlar. */
export const MIGRATION_DEVICE_LOCAL = [
  'Konum, bildirim, kamera, rehber ve takvim izinleri (her telefonda ayrı)',
  'SMS ile acil durum yedeği numaraları (yalnızca eski cihazdaydı)',
  'Ana ekran ve kilit ekranı widget’ları',
  'Takvime eklediğin etkinliklerin eşlemesi',
  'Açık QR bağlantılarının kodu (bağlantılar çalışır ama yeniden gösterilemez)',
] as const;

// --- callable şemaları ------------------------------------------------------------------------

const dsid = z.string().regex(DSID_RE);
const challengeId = z.string().regex(CHALLENGE_ID_RE);
const otp = z.string().regex(/^\d{6}$/);

export const DeviceRegisterRequestSchema = z.object({ op_id: z.uuid(), device: DeviceInfoSchema });
export type DeviceRegisterRequest = z.input<typeof DeviceRegisterRequestSchema>;

export interface DeviceSessionView {
  dsid: string;
  platform: DevicePlatform;
  model: string;
  os_version: string | null;
  app_version: string | null;
  status: DeviceSessionStatus;
  created_at: EpochMs;
  activated_at: EpochMs | null;
  last_seen_at: EpochMs;
  publishing: boolean;
  verified_by: VerificationChannel[];
  revoked_at: EpochMs | null;
  revoke_reason: DeviceRevokeReason | null;
}

export const DeviceSessionViewSchema: z.ZodType<DeviceSessionView> = z.object({
  dsid: z.string(),
  platform: z.enum(DEVICE_PLATFORMS),
  model: z.string(),
  os_version: z.string().nullable(),
  app_version: z.string().nullable(),
  status: z.enum(DEVICE_STATUSES),
  created_at: z.number(),
  activated_at: z.number().nullable(),
  last_seen_at: z.number(),
  publishing: z.boolean(),
  verified_by: z.array(z.enum(VERIFICATION_CHANNELS)),
  revoked_at: z.number().nullable(),
  revoke_reason: z.enum(DEVICE_REVOKE_REASONS).nullable(),
});

export const deviceView = (d: DeviceSessionDoc): DeviceSessionView => ({
  dsid: d.dsid,
  platform: d.platform,
  model: d.model,
  os_version: d.os_version,
  app_version: d.app_version,
  status: d.status,
  created_at: d.created_at,
  activated_at: d.activated_at,
  last_seen_at: d.last_seen_at,
  publishing: d.publishing,
  verified_by: d.verified_by,
  revoked_at: d.revoked_at,
  revoke_reason: d.revoke_reason,
});

export interface DeviceRegisterResponse {
  status: 'active' | 'needs_second_factor';
  device: DeviceSessionView;
  /** `dsid` iddialı custom token (yalnızca `active`); istemci `signInWithCustomToken` ile yeniden oturum açar. */
  custom_token: string | null;
  challenge: ChallengeView | null;
  /** Bu hesapta daha önce başka cihaz vardı (taşıma özeti gösterilir). */
  migrated: boolean;
  server_now: EpochMs;
}
export const DeviceRegisterResponseSchema: z.ZodType<DeviceRegisterResponse> = z.object({
  status: z.enum(['active', 'needs_second_factor']),
  device: DeviceSessionViewSchema,
  custom_token: z.string().nullable(),
  challenge: ChallengeViewSchema.nullable(),
  migrated: z.boolean(),
  server_now: z.number(),
});

export const DeviceSecondFactorSendRequestSchema = z.object({ op_id: z.uuid(), dsid });
export type DeviceSecondFactorSendRequest = z.input<typeof DeviceSecondFactorSendRequestSchema>;
export interface ChallengeResponse {
  challenge: ChallengeView;
  server_now: EpochMs;
}
export const ChallengeResponseSchema: z.ZodType<ChallengeResponse> = z.object({ challenge: ChallengeViewSchema, server_now: z.number() });

export const DeviceSecondFactorVerifyRequestSchema = z.object({ op_id: z.uuid(), dsid, challenge_id: challengeId, code: otp });
export type DeviceSecondFactorVerifyRequest = z.input<typeof DeviceSecondFactorVerifyRequestSchema>;
export interface DeviceActivatedResponse {
  device: DeviceSessionView;
  custom_token: string;
  migrated: boolean;
  server_now: EpochMs;
}
export const DeviceActivatedResponseSchema: z.ZodType<DeviceActivatedResponse> = z.object({
  device: DeviceSessionViewSchema,
  custom_token: z.string(),
  migrated: z.boolean(),
  server_now: z.number(),
});

export const DeviceHeartbeatRequestSchema = z.object({
  op_id: z.uuid(),
  publishing: z.boolean(),
  app_version: z.string().max(40).nullable().default(null),
});
export type DeviceHeartbeatRequest = z.input<typeof DeviceHeartbeatRequestSchema>;
export interface DeviceHeartbeatResponse {
  device: DeviceSessionView | null;
  written: boolean;
  server_now: EpochMs;
}
export const DeviceHeartbeatResponseSchema: z.ZodType<DeviceHeartbeatResponse> = z.object({
  device: DeviceSessionViewSchema.nullable(),
  written: z.boolean(),
  server_now: z.number(),
});

export const DeviceRevokeRequestSchema = z
  .object({
    op_id: z.uuid(),
    /** Kapatılacak cihaz; `all_others: true` ise boş. */
    dsid: dsid.nullable().default(null),
    all_others: z.boolean().default(false),
    /** Açık konum paylaşımlarını da durdur (varsayılan: paylaşımlar bu telefondan sürer). */
    stop_shares: z.boolean().default(false),
  })
  .refine((d) => d.all_others || d.dsid !== null, { message: 'dsid ya da all_others gerekli' });
export type DeviceRevokeRequest = z.input<typeof DeviceRevokeRequestSchema>;
export interface DeviceRevokeResponse {
  revoked: string[];
  stopped_shares: number;
  server_now: EpochMs;
}
export const DeviceRevokeResponseSchema: z.ZodType<DeviceRevokeResponse> = z.object({
  revoked: z.array(z.string()),
  stopped_shares: z.number(),
  server_now: z.number(),
});

export const DeviceSignOutRequestSchema = z.object({ op_id: z.uuid() });
export type DeviceSignOutRequest = z.input<typeof DeviceSignOutRequestSchema>;

export const RecoveryChannelStartRequestSchema = z
  .object({
    op_id: z.uuid(),
    channel: z.enum(VERIFICATION_CHANNELS),
    /** Yalnızca `email`. Telefon kanalı hesabın giriş numarasıdır. */
    email: z.string().max(SECURITY_LIMITS.emailMaxChars).nullable().default(null),
  })
  .refine((d) => d.channel !== 'email' || (d.email !== null && normalizeEmail(d.email) !== null), { message: 'Geçerli bir e-posta adresi gerekli', path: ['email'] });
export type RecoveryChannelStartRequest = z.input<typeof RecoveryChannelStartRequestSchema>;

export const RecoveryChannelVerifyRequestSchema = z.object({ op_id: z.uuid(), challenge_id: challengeId, code: otp });
export type RecoveryChannelVerifyRequest = z.input<typeof RecoveryChannelVerifyRequestSchema>;
export interface RecoveryResponse {
  recovery: RecoverySummary;
  server_now: EpochMs;
}
export const RecoveryResponseSchema: z.ZodType<RecoveryResponse> = z.object({ recovery: RecoverySummarySchema, server_now: z.number() });

export const RecoveryChannelRemoveRequestSchema = z.object({ op_id: z.uuid(), channel: z.literal('email') });
export type RecoveryChannelRemoveRequest = z.input<typeof RecoveryChannelRemoveRequestSchema>;

export const MigrationManifestRequestSchema = z.object({}).passthrough();
export interface MigrationManifestResponse {
  manifest: MigrationManifest;
  server_now: EpochMs;
}
const itemSummary = z.object({ count: z.number(), digest: z.string() });
export const MigrationManifestResponseSchema: z.ZodType<MigrationManifestResponse> = z.object({
  manifest: z.object({
    generated_at: z.number(),
    items: z.object({ friendships: itemSummary, permission_grants: itemSummary, favorites: itemSummary, zones: itemSummary, consents: itemSummary }),
  }),
  server_now: z.number(),
});

// --- metinler ---------------------------------------------------------------------------------

export function deviceLastSeenText(d: Pick<DeviceSessionView, 'last_seen_at' | 'status'>, now: EpochMs, isCurrent: boolean): string {
  if (isCurrent) return 'Bu cihaz · şu an etkin';
  if (d.status === 'revoked') return 'Oturum kapatıldı';
  const min = Math.max(0, Math.round((now - d.last_seen_at) / MINUTE));
  if (min < 2) return 'Son etkin: az önce';
  if (min < 60) return `Son etkin: ${min} dk önce`;
  const h = Math.round(min / 60);
  if (h < 24) return `Son etkin: ${h} sa önce`;
  return `Son etkin: ${Math.round(h / 24)} gün önce`;
}

export const SECURITY_TEXT = {
  screenTitle: 'Aktif Cihazlar ve Oturumlar',
  thisDevice: 'Bu cihaz',
  publishingOn: 'Konum yayını açık',
  publishingOff: 'Konum yayını kapalı',
  revokeOld: 'Eski Cihazdaki Oturumu ve Konum Yayınını Kapat',
  revokeAll: 'Diğer tüm cihazlardan çık',
  revokeConfirmTitle: (model: string) => `${model} kapatılsın mı?`,
  revokeConfirmBody:
    'Bu cihazdaki oturum anında iptal edilir, arka plandaki konum yayını durur ve uygulama o telefonda çıkış yapar. Arkadaşların, izinlerin ve bölgelerin bu telefonda kalır.',
  stopSharesToggle: 'Açık konum paylaşımlarımı da durdur',
  revokedToast: (model: string) => `${model}: oturum kapatıldı, konum yayını durdu`,
  revokedHere: 'Bu cihazdaki oturumun başka bir cihazdan kapatıldı. Konum yayını durduruldu.',
  newDeviceTitle: 'Yeni cihazda giriş',
  newDeviceBody: (masked: string) => `Hesabını korumak için ${masked} adresine gönderdiğimiz 6 haneli kodu gir.`,
  migrationTitle: 'Hesabın bu telefona taşındı',
  recoveryTitle: 'Hesap kurtarma',
  emailLabel: 'E-posta / Gmail adresi',
  smsLabel: 'Telefon numarası (SMS)',
  sendCode: 'Kod gönder',
  verify: 'Doğrula',
  resend: 'Kodu yeniden gönder',
} as const;

export function newDevicePushText(model: string): { title: string; body: string } {
  return { title: 'Hesabına yeni cihazdan girildi', body: `${model}. Sen değilsen Aktif Cihazlar’dan kapat.` };
}

export const SECURITY_PUSH_TYPES = ['session_revoked', 'device_new_signin'] as const;

/** Eski cihazın kendi zamanlayıcısı / izleyicisi için: iptal edildiyse yapılacaklar. */
export const SESSION_REVOKED_STEPS = ['stop_background_location', 'stop_geofencing', 'clear_local_state', 'delete_push_token', 'sign_out'] as const;
