/**
 * Faz 2: bağlantı (QR) ile paylaşım. Token üretimi, özeti, URL biçimi ve token sahibinin
 * gördüğü canlı paket (`link_live/{token_hash}`).
 *
 * Akış:
 *   1. `link_share_create` callable'ı 32 bayt rastgele token üretir, YALNIZCA bir kez döner.
 *      Sunucu düz token'ı saklamaz; `link_shares/{link_id}.token_hash` = sha256Hex(token).
 *   2. QR şu URL'yi taşır: `https://<LINK_DOMAIN>/s/<token>` (Universal Links / App Links).
 *      Uygulama kuruluysa `app/s/[token].tsx`, değilse `apps/web` salt okunur haritası açılır.
 *   3. Okuyan taraf token'ı kendi cihazında özetler (`linkTokenHash`) ve `link_live/{hash}` dinler.
 *      Okuma kuralı `link_acl/{hash}` aktif ve süresi dolmamışsa izin verir.
 *   4. Durdurma / süre dolumu: Firestore commit → `link_acl` mezar taşı → `link_live` silinir.
 *
 * Bu dosyadaki her şey saftır (ağ, saat, rastgelelik dışarıdan verilir). SHA-256 ve base64url
 * saf TypeScript'tir: React Native Hermes'te `crypto.subtle` yoktur. Tarayıcıda
 * `crypto.subtle.digest('SHA-256', utf8(token))` aynı sonucu verir.
 */
import { z } from 'zod';
import { DURATION_OPTIONS, SHARE_MODES, type DurationOption, type ShareMode } from './duration';
import { defaultRandomBytes } from './ids';
import type { LinkEndReason, LinkId, LinkLiveLocation, LinkShare } from './model';
import {
  LIVE_PACKET_VERSION,
  SERVER_TIMESTAMP,
  batteryPct,
  cleanExtras,
  type DeviceStatus,
  type NormalizedSample,
  type PacketExtras,
  type ServerTimestamp,
} from './packet';
import type { EpochMs } from './time';

// ---------------------------------------------------------------------------
// Sabitler
// ---------------------------------------------------------------------------

/** Token uzunluğu: 32 bayt = 256 bit (tahmin edilemez, kaba kuvvetle taranamaz). */
export const LINK_TOKEN_BYTES = 32;
/** 32 bayt base64url (dolgusuz) = 43 karakter. */
export const LINK_TOKEN_LENGTH = 43;
/** Bağlantı alan adı. [Varsayım] Gerçek alan adı alınınca yapılandırmadan gelir. */
export const LINK_DOMAIN_DEFAULT = 'konum.example.com';
/** Uygulamanın özel şeması (`app.json` → `scheme`). */
export const LINK_SCHEME = 'konum';
/** Universal Links / App Links yol öneki. AASA ve assetlinks bu yolu kapsar. */
export const LINK_PATH_PREFIX = '/s/';

/**
 * 43 karakter; son karakter yalnızca 4 bit taşır (256 = 42·6 + 4), alt 2 biti 0 olmalı.
 * Böylece her geçerli token tek bir bayt dizisine karşılık gelir (kanonik biçim).
 */
export const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
/** `token_hash`: SHA-256, küçük harf hex, 64 karakter. RTDB anahtarı olarak güvenli. */
export const LINK_HASH_RE = /^[0-9a-f]{64}$/;

/** Ürün sınırları. [Varsayım] — onaya açık. */
export const LINK_LIMITS = {
  /** Kullanıcı başına aynı anda aktif bağlantı sayısı (kötüye kullanım ve maliyet koruması). */
  maxActivePerUser: 5,
  /** `sender_name` üst sınırı (profil `display_name` ile aynı). */
  senderNameMaxLength: 40,
} as const;

/**
 * QR / bağlantı süre seçenekleri: 15 dk, 1 saat, 8 saat, gün sonuna kadar, 1 hafta, süresiz.
 * Faz 1 `DURATION_OPTIONS` ile aynı motor; "Özel süre" QR ekranında gösterilmez (sunucu yine kabul eder).
 */
export const LINK_DURATION_OPTIONS: readonly DurationOption[] = DURATION_OPTIONS.filter((o) => o.id !== 'custom');

/** Görünen ad yoksa web haritasında gösterilecek metin. */
export const LINK_SENDER_NAME_FALLBACK = 'Konum paylaşan kişi';

// ---------------------------------------------------------------------------
// base64url ve UTF-8
// ---------------------------------------------------------------------------

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_INDEX: Record<string, number> = Object.fromEntries([...B64URL].map((c, i) => [c, i]));

/** RFC 4648 §5 base64url, dolgu (`=`) yok. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += B64URL[(n >>> 18) & 63]! + B64URL[(n >>> 12) & 63]! + B64URL[(n >>> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += B64URL[(n >>> 18) & 63]! + B64URL[(n >>> 12) & 63]!;
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += B64URL[(n >>> 18) & 63]! + B64URL[(n >>> 12) & 63]! + B64URL[(n >>> 6) & 63]!;
  }
  return out;
}

/** Dolgusuz base64url çözer; geçersiz karakter veya uzunlukta null. */
export function base64UrlDecode(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const c of s) {
    const v = B64URL_INDEX[c];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

/** WHATWG TextEncoder ile aynı: eşsiz vekil (lone surrogate) U+FFFD olur. */
export function utf8Encode(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 3);
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      const d = s.charCodeAt(i + 1);
      if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else {
        c = 0xfffd;
      }
    }
    if (c < 0x80) out[o++] = c;
    else if (c < 0x800) {
      out[o++] = 0xc0 | (c >> 6);
      out[o++] = 0x80 | (c & 63);
    } else if (c < 0x10000) {
      out[o++] = 0xe0 | (c >> 12);
      out[o++] = 0x80 | ((c >> 6) & 63);
      out[o++] = 0x80 | (c & 63);
    } else {
      out[o++] = 0xf0 | (c >> 18);
      out[o++] = 0x80 | ((c >> 12) & 63);
      out[o++] = 0x80 | ((c >> 6) & 63);
      out[o++] = 0x80 | (c & 63);
    }
  }
  return out.slice(0, o);
}

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4), saf TypeScript
// ---------------------------------------------------------------------------

// prettier-ignore
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 özeti (32 bayt). */
export function sha256(data: Uint8Array): Uint8Array {
  const len = data.length;
  const blocks = Math.floor((len + 9 + 63) / 64);
  const buf = new Uint8Array(blocks * 64);
  buf.set(data);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  // 64 bit büyük-uçlu bit uzunluğu (2^53 bayta kadar doğru).
  view.setUint32(buf.length - 8, Math.floor(len / 0x20000000), false);
  view.setUint32(buf.length - 4, (len * 8) >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a; // prettier-ignore
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19; // prettier-ignore
  const w = new Uint32Array(64);

  for (let off = 0; off < buf.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15] as number;
      const y = w[t - 2] as number;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7; // prettier-ignore
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (K256[t] as number) + (w[t] as number)) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => ov.setUint32(i * 4, v >>> 0, false));
  return out;
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** SHA-256, küçük harf hex. Metin UTF-8 olarak özetlenir (Node `createHash('sha256').update(s)` ile aynı). */
export function sha256Hex(input: string | Uint8Array): string {
  return toHex(sha256(typeof input === 'string' ? utf8Encode(input) : input));
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/** 32 baytı token'a çevirir. Sunucu `crypto.randomBytes(32)` verir. */
export function encodeLinkToken(bytes: Uint8Array): string {
  if (bytes.length !== LINK_TOKEN_BYTES) throw new Error(`Token ${LINK_TOKEN_BYTES} bayt olmalı`);
  return base64UrlEncode(bytes);
}

/** Yeni token. Varsayılan üreteç `crypto.getRandomValues`; sunucuda `randomBytes` verilir. */
export function generateLinkToken(rand: (n: number) => Uint8Array = defaultRandomBytes): string {
  return encodeLinkToken(rand(LINK_TOKEN_BYTES));
}

export function isLinkToken(s: unknown): s is string {
  return typeof s === 'string' && LINK_TOKEN_RE.test(s);
}

export function isLinkTokenHash(s: unknown): s is string {
  return typeof s === 'string' && LINK_HASH_RE.test(s);
}

/** `token_hash` = sha256Hex(token). Token ASCII olduğundan UTF-8/ASCII farkı yoktur. */
export function linkTokenHash(token: string): string {
  return sha256Hex(token);
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/** "https://Konum.Example.com/" → "konum.example.com". Geçersizse null. */
export function normalizeLinkDomain(domain: string): string | null {
  const d = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return HOST_RE.test(d) ? d : null;
}

/** QR'ın taşıdığı URL: `https://<domain>/s/<token>`. */
export function buildLinkUrl(domain: string, token: string): string {
  const host = normalizeLinkDomain(domain);
  if (!host) throw new Error('Geçersiz bağlantı alan adı');
  if (!isLinkToken(token)) throw new Error('Geçersiz bağlantı token değeri');
  return `https://${host}${LINK_PATH_PREFIX}${token}`;
}

const HTTP_LINK_RE = /^(https?):\/\/([^/?#\s]+)\/s\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i;
const SCHEME_LINK_RE = new RegExp(`^${LINK_SCHEME}:\\/\\/\\/?s\\/([A-Za-z0-9_-]+)\\/?(?:[?#].*)?$`, 'i');
const DEV_HOST_RE = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * QR / bağlantı / yapıştırılan metinden token'ı çıkarır. Kabul edilenler:
 *   - `https://<domains içindeki alan>/s/<token>` (sorgu ve # yok sayılır)
 *   - `konum://s/<token>` ve `konum:///s/<token>` (expo-router biçimleri)
 *   - çıplak token
 * `http://` yalnızca `localhost` / `127.0.0.1` için (yerel geliştirme) ve o alan listede ise.
 * Başka alan, kullanıcı bilgisi (`a@host`) veya bozuk token → null.
 * `URL` sınıfı kullanılmaz: React Native'in `URL` gerçeklemesi `hostname` vb. desteklemez.
 */
export function parseLinkToken(input: string, domains: readonly string[] = [LINK_DOMAIN_DEFAULT]): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (isLinkToken(s)) return s;

  const scheme = SCHEME_LINK_RE.exec(s);
  if (scheme) return isLinkToken(scheme[1]) ? scheme[1] : null;

  const m = HTTP_LINK_RE.exec(s);
  if (!m) return null;
  const proto = (m[1] as string).toLowerCase();
  const host = (m[2] as string).toLowerCase();
  const token = m[3];
  const allowed = new Set(domains.map(normalizeLinkDomain).filter((d): d is string => d !== null));
  if (!allowed.has(host)) return null;
  if (proto === 'http' && !DEV_HOST_RE.test(host)) return null;
  return isLinkToken(token) ? token : null;
}

// ---------------------------------------------------------------------------
// Gönderen tarafı görünüm ve yayın hedefi
// ---------------------------------------------------------------------------

/** Gönderenin kendi bağlantı paylaşımı (callable yanıtları ve `link_shares` belgesinden). */
export type LinkShareView = Pick<
  LinkShare,
  | 'link_id'
  | 'session_id'
  | 'token_hash'
  | 'status'
  | 'share_mode'
  | 'started_at'
  | 'expires_at'
  | 'end_reason'
  | 'version'
  | 'extended_count'
>;

/**
 * Yayıncının bağlantı hedefi. Token GEREKMEZ: yazma yolu `link_live/{token_hash}`.
 * Faz 1 `PublishTarget` listesinin yanına eklenir; konum toplama kodu değişmez.
 */
export interface LinkPublishTarget {
  link_id: LinkId;
  token_hash: string;
  share_mode: ShareMode;
  expires_at: EpochMs | null;
  /** Gönderenin görünen adı (telefon numarası ASLA). */
  sender_name: string;
}

/** Aktif ve süresi dolmamış bağlantılar → yayın hedefleri. */
export function selectLinkPublishTargets(
  links: readonly LinkShareView[],
  senderName: string,
  now: EpochMs,
): LinkPublishTarget[] {
  return links
    .filter((l) => l.status === 'active' && (l.expires_at === null || l.expires_at > now) && isLinkTokenHash(l.token_hash))
    .map((l) => ({
      link_id: l.link_id,
      token_hash: l.token_hash,
      share_mode: l.share_mode,
      expires_at: l.expires_at,
      sender_name: senderName,
    }));
}

/** Görünen adı paket için temizler: boşluklar sadeleşir, 40 karakterle kesilir, boşsa yedek metin. */
export function linkSenderName(displayName: string | null | undefined): string {
  const s = (displayName ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return LINK_SENDER_NAME_FALLBACK;
  const chars = [...s];
  return chars.length > LINK_LIMITS.senderNameMaxLength ? chars.slice(0, LINK_LIMITS.senderNameMaxLength).join('') : s;
}

// ---------------------------------------------------------------------------
// link_live paketi
// ---------------------------------------------------------------------------

/**
 * RTDB `link_live/{token_hash}` kuralı bu alanlara izin verir (backend testleri karşılaştırır).
 * Gizlilik: `sender_id`, `share_id`, `receiver_ids`, `link_id`, `session_id`, telefon, avatar,
 * `is_charging`, `activity_state` ve `mocked` token sahibine GÖSTERİLMEZ. Ayrıntı: `LinkLiveLocation`.
 */
export const LINK_LIVE_FIELDS = [
  'v',
  'lat',
  'lng',
  'accuracy',
  'heading',
  'speed_mps',
  'battery_pct',
  'timestamp',
  'server_ts',
  'sender_name',
  'expires_at',
  'share_mode',
  // Faz 3 (isteğe bağlı)
  'hb',
  'q',
] as const satisfies readonly (keyof LinkLiveLocation)[];

// Derleme zamanı tamlık denetimi: LinkLiveLocation'a alan eklenirse liste de güncellenmeli.
type _MissingLinkLiveField = Exclude<keyof LinkLiveLocation, (typeof LINK_LIVE_FIELDS)[number]>;
const _linkLiveFieldsComplete: _MissingLinkLiveField extends never ? true : false = true;
void _linkLiveFieldsComplete;

/** RTDB'ye giden kopya: null alan yok, `server_ts` yer tutucu. */
export type LinkLiveLocationWrite = {
  [K in keyof LinkLiveLocation]?: K extends 'server_ts' ? ServerTimestamp : Exclude<LinkLiveLocation[K], null | undefined>;
};

export const linkLivePath = (tokenHash: string): string => `link_live/${tokenHash}`;

/** Tek bağlantı için yazılacak kopya. */
export function buildLinkLiveWrite(
  sample: NormalizedSample,
  device: DeviceStatus,
  target: Pick<LinkPublishTarget, 'share_mode' | 'expires_at' | 'sender_name'>,
  extras: Pick<PacketExtras, 'hb' | 'q'> = {},
): LinkLiveLocationWrite {
  const out: LinkLiveLocationWrite = {
    v: LIVE_PACKET_VERSION,
    lat: sample.lat,
    lng: sample.lng,
    accuracy: sample.accuracy,
    timestamp: sample.timestamp,
    server_ts: SERVER_TIMESTAMP,
    sender_name: linkSenderName(target.sender_name),
    share_mode: target.share_mode,
  };
  if (sample.heading !== null) out.heading = sample.heading;
  if (sample.speed_mps !== null) out.speed_mps = sample.speed_mps;
  const pct = batteryPct(device.batteryLevel);
  if (pct !== null) out.battery_pct = pct;
  if (target.expires_at !== null) out.expires_at = target.expires_at;
  // Faz 3: recorded_at bağlantıya yazılmaz (anonim izleyiciye gerekmez).
  const { hb, q } = cleanExtras(extras);
  if (hb !== undefined) out.hb = hb;
  if (q !== undefined) out.q = q;
  return out;
}

/**
 * Yol → değer haritası (`ref().update(map)`). Süresi dolmuş hedef atlanır.
 * Not: çok yollu yazma atomiktir; tek bir yol kuralda reddedilirse hepsi düşer. Bu yüzden
 * bağlantı yazmalarını arkadaş fan-out'undan AYRI çağrıda yapmak önerilir.
 */
export function toLinkLiveUpdate(
  sample: NormalizedSample,
  device: DeviceStatus,
  targets: readonly LinkPublishTarget[],
  now: EpochMs,
  extras: Pick<PacketExtras, 'hb' | 'q'> = {},
): Record<string, LinkLiveLocationWrite> {
  const update: Record<string, LinkLiveLocationWrite> = {};
  for (const t of targets) {
    if (t.expires_at !== null && t.expires_at <= now) continue;
    if (!isLinkTokenHash(t.token_hash)) continue;
    update[linkLivePath(t.token_hash)] = buildLinkLiveWrite(sample, device, t, extras);
  }
  return update;
}

/** Okuma tarafı (web ve uygulama): eksik alan null olur, bilinmeyen alan yok sayılır. */
export const LinkLiveLocationSchema = z.object({
  v: z.number().int(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0),
  heading: z.number().nullable().default(null),
  speed_mps: z.number().nullable().default(null),
  battery_pct: z.number().int().min(0).max(100).nullable().default(null),
  timestamp: z.number(),
  server_ts: z.number(),
  sender_name: z.string().max(LINK_LIMITS.senderNameMaxLength * 2).catch(LINK_SENDER_NAME_FALLBACK),
  expires_at: z.number().nullable().default(null),
  share_mode: z.enum(SHARE_MODES as [ShareMode, ...ShareMode[]]),
  hb: z.number().positive().optional().catch(undefined),
  q: z.literal(1).optional().catch(undefined),
});

/** Bozuk kaydı sessizce atar (null). */
export function parseLinkLive(raw: unknown): LinkLiveLocation | null {
  const r = LinkLiveLocationSchema.safeParse(raw);
  return r.success ? (r.data as LinkLiveLocation) : null;
}

// ---------------------------------------------------------------------------
// Token sahibinin ekran durumu (web haritası ve app/s/[token].tsx aynı mantığı kullanır)
// ---------------------------------------------------------------------------

export type LinkViewState = 'invalid' | 'unavailable' | 'loading' | 'waiting' | 'live' | 'ended';

export interface LinkViewInput {
  /** `parseLinkToken` sonucu null değilse true. */
  tokenValid: boolean;
  /** İlk anlık görüntü (veya hata) geldi mi. */
  loaded: boolean;
  /** Dinleyici `permission_denied` ile iptal edildi: ACL bitti, süresi doldu veya hiç yok. */
  denied: boolean;
  live: LinkLiveLocation | null;
  /** Bu oturumda en az bir konum görüldü mü (sonradan null = paylaşım silindi). */
  seenLive: boolean;
  /**
   * Bu oturumda en az bir anlık görüntü (null bile olsa) OKUNDU mu: bağlantı o an geçerliydi.
   * Verilmezse `seenLive || live !== null` sayılır. Ret bu değer false iken gelirse durum `unavailable`.
   */
  hadAccess?: boolean;
  now: EpochMs;
}

/**
 * Ekran durumu. Web haritası ve uygulama içi görüntüleyici (`app/s/[token].tsx`) aynı kuralı kullanır.
 *
 *  - `unavailable`: İLK okuma reddedildi (hiç erişim olmadı). Var olmayan, durdurulmuş ve süresi dolmuş
 *    bağlantı burada AYIRT EDİLMEZ: token tahmin eden biri hangi token'ların bir zamanlar geçerli olduğunu
 *    öğrenemez ("Bağlantı geçersiz ya da süresi dolmuş").
 *  - `ended`: erişim vardı, sonra düğüm silindi / dinleyici reddedildi / paketteki `expires_at` geçti
 *    ("Paylaşım sona erdi"); pin kalkar.
 */
export function linkViewState(i: LinkViewInput): LinkViewState {
  if (!i.tokenValid) return 'invalid';
  const hadAccess = i.hadAccess ?? (i.seenLive || i.live !== null);
  if (i.denied) return hadAccess ? 'ended' : 'unavailable';
  if (i.live) {
    if (i.live.expires_at !== null && i.live.expires_at <= i.now) return 'ended';
    return 'live';
  }
  if (!i.loaded) return 'loading';
  return i.seenLive ? 'ended' : 'waiting';
}

export const LINK_VIEW_TEXT: Record<LinkViewState, string> = {
  invalid: 'Bağlantı geçersiz',
  unavailable: 'Bağlantı geçersiz ya da süresi dolmuş',
  loading: 'Konum yükleniyor…',
  waiting: 'Paylaşan kişinin konumu bekleniyor',
  live: 'Canlı konum',
  ended: 'Paylaşım sona erdi',
};

/** Durum başlığının altındaki açıklama (web ve uygulama aynı metni gösterir; boş = açıklama yok). */
export const LINK_VIEW_DETAIL: Record<LinkViewState, string> = {
  invalid: 'Bağlantının tamamını kopyaladığından emin ol.',
  unavailable: 'Konumu görmek için paylaşan kişiden yeni bir bağlantı isteyebilirsin.',
  loading: '',
  waiting: 'Konum gelince harita kendiliğinden güncellenir.',
  live: '',
  ended: 'Paylaşan kişi konum paylaşımını durdurdu ya da süresi doldu.',
};

/** Gönderen tarafı bitiş metinleri (Faz 1 `END_REASON_TEXT` ile aynı dil). */
export const LINK_END_REASON_TEXT: Record<LinkEndReason, string> = {
  stopped_by_sender: 'Bağlantı paylaşımını durdurdun',
  expired: 'Bağlantının süresi doldu',
  account_deleted: 'Hesap silindi',
};
