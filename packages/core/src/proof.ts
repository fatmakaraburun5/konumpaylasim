/**
 * Faz 9: tek kullanımlık anlık fotoğraf ispatı ("Mekana geçtim, masamız burası", "Trafik tamamen kilit").
 * Ayrıntı: docs/PHASE9.md §1.
 *
 * İlkeler:
 *  - YALNIZCA KAMERA: istemcide galeri yolu yoktur (uygulama içi kamera, `source: 'camera'`). Sunucu ayrıca çekimin
 *    taze olmasını şart koşar (`captured_at` sunucu saatine göre en çok `captureMaxAgeMs` önce). Bu, galeriden eski
 *    bir fotoğrafın yüklenmesini istemci kodu değiştirilse bile zorlaştırır; tam kanıt değildir [Varsayım].
 *  - 1 SAAT: `expires_at = created_at + ttlMs`. Sunucu (Cloud Tasks + dakikalık süpürücü + Firestore TTL + Storage
 *    yaşam döngüsü), gönderen ve alıcı cihaz önbellekleri (zamanlayıcı + açılış süpürmesi) aynı anı kullanır.
 *  - ERİŞİM sunucuda: fotoğrafı yalnızca o an sahibinden ETKİN canlı paylaşım alan kişi görür (`canViewProof`),
 *    sahibi görünmez değilken ve süre dolmamışken. Bayt yalnızca `proof_get` callable'ıyla gelir; Storage nesnesi
 *    istemcilere tamamen kapalıdır (indirme token'ı / herkese açık adres yok).
 *  - Meta veri yok: cihaz fotoğrafı yeniden kodlar (EXIF / GPS düşer), sunucu `stripJpegMetadata` ile APPn ve COM
 *    bölümlerini ayrıca atar.
 *  - Alıcılar fotoğrafın varlığını canlı paketteki `photo_id` + `photo_exp` alanlarından öğrenir (durum notu gibi;
 *    QR bağlantısına gitmez).
 */
import { z } from 'zod';
import type { UserId } from './model';
import { HOUR, MINUTE, SECOND, type EpochMs } from './time';

export const PROOF_LIMITS = {
  /** Fotoğrafın ömrü: 1 saat. */
  ttlMs: HOUR,
  /** Yeniden kodlanmış JPEG en çok (bayt). */
  maxBytes: 600_000,
  /** Uzun kenar en çok (piksel; sunucu SOF başlığından doğrular). */
  maxDimension: 1600,
  /** Cihazın yeniden kodlarken hedeflediği uzun kenar. */
  targetDimension: 1280,
  /** Cihaz JPEG kalitesi (0..1). */
  jpegQuality: 0.7,
  /** Çekimden yüklemeye en çok (sunucu saati). "O an çekilen" kuralı. [Varsayım] */
  captureMaxAgeMs: 2 * MINUTE,
  /** Cihaz saati ileride olsa bile kabul edilen pay. */
  captureMaxFutureMs: MINUTE,
  /** Aynı anda en çok etkin fotoğraf (yenisi eskisinin yerine geçer, eskisi hemen silinir). */
  maxActivePerUser: 1,
  /** Kullanıcı başına günlük en çok fotoğraf. [Varsayım] */
  perDay: 30,
  /** Açıklama (durum notu etiketi) üst sınırı. */
  captionMaxChars: 60,
  /** Biten fotoğraf kaydının (koordinatsız özet) Firestore TTL payı. */
  purgeAfterMs: 24 * HOUR,
  /** İstemci önbellek süpürme aralığı. */
  cacheSweepMs: 30 * SECOND,
} as const;

/** Sunucunun ürettiği kimlik: 20 karakter base64url. Paket kuralı da bu biçimi ister. */
export const PROOF_ID_RE = /^[A-Za-z0-9_-]{20}$/;

export const PROOF_STATES = ['active', 'ended'] as const;
export type ProofState = (typeof PROOF_STATES)[number];

export const PROOF_END_REASONS = ['expired', 'replaced', 'deleted', 'invisible', 'consent_withdrawn', 'account_deleted'] as const;
export type ProofEndReason = (typeof PROOF_END_REASONS)[number];

export interface ProofPosition {
  lat: number;
  lng: number;
  accuracy: number | null;
}

/**
 * Firestore `photo_proofs/{proof_id}` (YALNIZCA sunucu okur/yazar; istemciye kapalı). Bayt Storage
 * `proofs/{owner_id}/{proof_id}.jpg` nesnesindedir.
 */
export interface PhotoProofDoc {
  proof_id: string;
  owner_id: UserId;
  /** Durum notu etiketi ("☕ Mekana geçtim, masamız burası"); yoksa null. */
  caption: string | null;
  source: 'camera';
  width: number;
  height: number;
  bytes: number;
  /** Çekildiği yer (son doğrulanmış konum, 6 ondalık); yoksa null. */
  position: ProofPosition | null;
  captured_at: EpochMs;
  created_at: EpochMs;
  expires_at: EpochMs;
  state: ProofState;
  end_reason: ProofEndReason | null;
  ended_at: EpochMs | null;
  /** Storage nesnesi silindi mi (süpürücü yeniden dener). */
  object_deleted: boolean;
  storage_path: string;
}

/** İstemcinin gördüğü özet (`proof_create` / `proof_get` yanıtı). */
export interface PhotoProofView {
  proof_id: string;
  owner_id: UserId;
  caption: string | null;
  width: number;
  height: number;
  position: ProofPosition | null;
  captured_at: EpochMs;
  expires_at: EpochMs;
}

export function toProofView(d: Pick<PhotoProofDoc, keyof PhotoProofView>): PhotoProofView {
  return {
    proof_id: d.proof_id,
    owner_id: d.owner_id,
    caption: d.caption,
    width: d.width,
    height: d.height,
    position: d.position,
    captured_at: d.captured_at,
    expires_at: d.expires_at,
  };
}

// --- şemalar -------------------------------------------------------------------------------

const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
/** base64 uzunluk tavanı: 4 * ceil(maxBytes / 3). */
export const PROOF_MAX_B64_LENGTH = 4 * Math.ceil(PROOF_LIMITS.maxBytes / 3);

export const ProofPositionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(5_000).nullable().default(null),
});

export const ProofCreateRequestSchema = z.object({
  op_id: z.uuid(),
  /** Galeri yolu yok: tek kabul edilen kaynak. */
  source: z.literal('camera'),
  /** Yeniden kodlanmış JPEG, standart base64 (data: öneki yok). */
  jpeg_b64: z
    .string()
    .min(16)
    .max(PROOF_MAX_B64_LENGTH)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  width: z.number().int().min(1).max(PROOF_LIMITS.maxDimension),
  height: z.number().int().min(1).max(PROOF_LIMITS.maxDimension),
  /** Deklanşör anı (sunucu saatine çevrilmiş). */
  captured_at: z.number().int().positive(),
  caption: z.string().max(PROOF_LIMITS.captionMaxChars * 2).nullable().default(null),
  position: ProofPositionSchema.nullable().default(null),
});
export type ProofCreateRequest = z.input<typeof ProofCreateRequestSchema>;

export const ProofViewSchema: z.ZodType<PhotoProofView> = z.object({
  proof_id: z.string().regex(PROOF_ID_RE),
  owner_id: uid,
  caption: z.string().nullable(),
  width: z.number(),
  height: z.number(),
  position: z.object({ lat: z.number(), lng: z.number(), accuracy: z.number().nullable() }).nullable(),
  captured_at: z.number(),
  expires_at: z.number(),
});

export interface ProofCreateResponse {
  proof: PhotoProofView;
  /** Yerine geçilen (hemen silinen) önceki fotoğraf. */
  replaced_proof_id: string | null;
  server_now: EpochMs;
}
export const ProofCreateResponseSchema: z.ZodType<ProofCreateResponse> = z.object({
  proof: ProofViewSchema,
  replaced_proof_id: z.string().nullable(),
  server_now: z.number(),
});

export const ProofGetRequestSchema = z.object({
  owner_id: uid,
  proof_id: z.string().regex(PROOF_ID_RE),
});
export type ProofGetRequest = z.input<typeof ProofGetRequestSchema>;

export interface ProofGetResponse {
  proof: PhotoProofView;
  jpeg_b64: string;
  server_now: EpochMs;
}
export const ProofGetResponseSchema: z.ZodType<ProofGetResponse> = z.object({
  proof: ProofViewSchema,
  jpeg_b64: z.string(),
  server_now: z.number(),
});

export const ProofDeleteRequestSchema = z.object({ op_id: z.uuid(), proof_id: z.string().regex(PROOF_ID_RE) });
export type ProofDeleteRequest = z.input<typeof ProofDeleteRequestSchema>;

export interface ProofDeleteResponse {
  proof_id: string;
  deleted: boolean;
  server_now: EpochMs;
}
export const ProofDeleteResponseSchema: z.ZodType<ProofDeleteResponse> = z.object({
  proof_id: z.string(),
  deleted: z.boolean(),
  server_now: z.number(),
});

// --- kurallar ------------------------------------------------------------------------------

export const isProofActive = (p: Pick<PhotoProofView, 'expires_at'>, now: EpochMs): boolean => p.expires_at > now;

export const proofExpiresAt = (createdAt: EpochMs): EpochMs => createdAt + PROOF_LIMITS.ttlMs;

/** Çekim "o an" mı? Sunucu `proof_create`'te, istemci yüklemeden önce aynı kuralı uygular. */
export function isFreshCapture(capturedAt: EpochMs, now: EpochMs): boolean {
  return capturedAt <= now + PROOF_LIMITS.captureMaxFutureMs && now - capturedAt <= PROOF_LIMITS.captureMaxAgeMs;
}

export type ProofAccess = 'ok' | 'expired' | 'not_found';

/**
 * Bir alıcı fotoğrafı görebilir mi? (Sunucu `proof_get` ve demo sunucusu.) Sahibi her zaman görür (süresi dolana
 * kadar). Diğerleri: sahibinden şu an ETKİN canlı paylaşım alıyor (`location_view` ile başlamış) ve sahibi görünmez
 * değil. Erişimi olmayan "bulunamadı" alır (fotoğrafın varlığı sızmaz); süresi dolmuşsa herkese "süresi doldu".
 */
export function canViewProof(i: {
  proof: Pick<PhotoProofDoc, 'owner_id' | 'state' | 'expires_at'> | null;
  viewerId: UserId;
  now: EpochMs;
  /** Sahibinden izleyiciye etkin paylaşım var mı (süresi dolmamış). */
  hasActiveShareFromOwner: boolean;
  ownerInvisible: boolean;
}): ProofAccess {
  const p = i.proof;
  if (!p) return 'not_found';
  const isOwner = p.owner_id === i.viewerId;
  if (!isOwner && (!i.hasActiveShareFromOwner || i.ownerInvisible)) return 'not_found';
  if (p.state !== 'active' || p.expires_at <= i.now) return 'expired';
  return 'ok';
}

/** Açıklamayı temizler (kontrol karakterleri, boşluklar, uzunluk); boşsa null. */
export function sanitizeProofCaption(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // eslint-disable-next-line no-control-regex
  let s = raw.replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > PROOF_LIMITS.captionMaxChars) {
    const cps = Array.from(s);
    while (cps.length > 0 && cps.join('').length > PROOF_LIMITS.captionMaxChars) cps.pop();
    s = cps.join('').trim();
  }
  return s.length > 0 ? s : null;
}

/** Ekrandaki kalan süre: "52 dk kaldı", "45 sn kaldı", "Süresi doldu". */
export function formatProofLeft(expiresAt: EpochMs, now: EpochMs): string {
  const left = expiresAt - now;
  if (left <= 0) return 'Süresi doldu';
  if (left < MINUTE) return `${Math.max(1, Math.ceil(left / SECOND))} sn kaldı`;
  return `${Math.ceil(left / MINUTE)} dk kaldı`;
}

/** Halka göstergesi: kalan ömrün oranı 1 → 0. */
export function proofRemainingRatio(p: Pick<PhotoProofView, 'expires_at'>, now: EpochMs): number {
  return Math.min(1, Math.max(0, (p.expires_at - now) / PROOF_LIMITS.ttlMs));
}

/** Önbellek kaydı süresi dolmuş mu (gönderen ve alıcı cihazda aynı kural). */
export const proofCacheExpired = (entry: { expires_at: EpochMs }, now: EpochMs): boolean => entry.expires_at <= now;

// --- JPEG yardımcıları (saf; Node, Hermes ve tarayıcıda aynı) -------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV: Record<string, number> = Object.fromEntries(Array.from(B64, (c, i) => [c, i]));

/** Standart base64 → bayt; geçersizse null. */
export function base64ToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = B64_INV[s[i] ?? 'A'] ?? 0;
    const b = B64_INV[s[i + 1] ?? 'A'] ?? 0;
    const c = s[i + 2] === '=' ? 0 : (B64_INV[s[i + 2] ?? 'A'] ?? 0);
    const d = s[i + 3] === '=' ? 0 : (B64_INV[s[i + 3] ?? 'A'] ?? 0);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

/** Bayt → standart base64 (dolgulu). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += b === undefined ? '=' : B64[(n >> 6) & 63]!;
    out += c === undefined ? '=' : B64[n & 63]!;
  }
  return out;
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** JPEG mi ve boyutu ne? (SOI + SOFn başlığı). Bozuksa null. */
export function jpegInfo(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1; // dolgu
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // SOF'tan önce SOS / EOI
    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    if (len < 2 || i + 2 + len > bytes.length) return null;
    if (SOF_MARKERS.has(marker)) {
      if (len < 7) return null;
      const height = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0);
      const width = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

/**
 * APP1–APP15 (EXIF, XMP, GPS, ICC dahil) ve COM bölümlerini atar; APP0 (JFIF) ve görüntü verisi kalır. SOS'tan
 * sonrası olduğu gibi kopyalanır. JPEG değilse null.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] ?? 0;
    if (marker === 0xda) {
      parts.push(bytes.subarray(i));
      return concatBytes(parts);
    }
    if (marker === 0xd9) {
      parts.push(bytes.subarray(i, i + 2));
      return concatBytes(parts);
    }
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      parts.push(bytes.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    if (len < 2 || i + 2 + len > bytes.length) return null;
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) parts.push(bytes.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Sunucu doğrulaması (tek yerde): bayt → temizlenmiş JPEG + boyut, ya da hata nedeni. */
export function validateProofJpeg(
  b64: string,
  declared: { width: number; height: number },
): { ok: true; bytes: Uint8Array; width: number; height: number } | { ok: false; reason: 'not_jpeg' | 'too_large' | 'bad_dimensions' } {
  const raw = base64ToBytes(b64);
  if (!raw) return { ok: false, reason: 'not_jpeg' };
  if (raw.length > PROOF_LIMITS.maxBytes) return { ok: false, reason: 'too_large' };
  const info = jpegInfo(raw);
  if (!info) return { ok: false, reason: 'not_jpeg' };
  if (info.width > PROOF_LIMITS.maxDimension || info.height > PROOF_LIMITS.maxDimension) return { ok: false, reason: 'bad_dimensions' };
  if (info.width !== declared.width || info.height !== declared.height) return { ok: false, reason: 'bad_dimensions' };
  const clean = stripJpegMetadata(raw);
  if (!clean) return { ok: false, reason: 'not_jpeg' };
  return { ok: true, bytes: clean, width: info.width, height: info.height };
}

// --- metinler ------------------------------------------------------------------------------

export const PROOF_TEXT = {
  add: 'Anlık fotoğraf ekle',
  addHint: 'Yalnızca şu an kamerayla çektiğin fotoğraf eklenir; galeriden seçilemez.',
  ttlHint: '1 saat sonra sunucudan ve tüm cihazlardan silinir.',
  audience: 'Konumunu paylaştığın kişiler görür.',
  cameraTitle: 'Anlık fotoğraf',
  shutter: 'Fotoğraf çek',
  retake: 'Yeniden çek',
  use: 'Fotoğrafı ekle',
  uploading: 'Ekleniyor…',
  remove: 'Fotoğrafı kaldır',
  removed: 'Fotoğraf kaldırıldı',
  expired: 'Fotoğrafın süresi doldu',
  expiredBody: 'Anlık fotoğraflar 1 saat sonra silinir.',
  stale: 'Fotoğraf az önce çekilmiş olmalı. Yeniden çek.',
  noCamera: 'Anlık fotoğraf için kamera izni gerekiyor. Galeriden seçim yapılamaz.',
  noCameraAction: 'Ayarları aç',
  unavailable: 'Bu cihazda kamera bulunamadı.',
  viewerTitle: (name: string): string => `${name} · Anlık fotoğraf`,
  takenAt: (clock: string): string => `Çekim ${clock}`,
  pinBadge: 'Fotoğraf',
} as const;
