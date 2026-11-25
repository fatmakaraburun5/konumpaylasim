/**
 * Faz 6: cinsiyet alanı, cinsiyete göre çerçeve rengi ve profil fotoğrafı (avatar) sözleşmesi.
 *
 *  - `gender` kayıtta ZORUNLUDUR (`user_bootstrap` ile profil oluşturulurken). Eski (Faz 1–5) hesaplarda `null`
 *    kalabilir; uygulama bu hesaplara girişten sonra engelleyici bir seçim ekranı gösterir. Bir kez seçildikten
 *    sonra değiştirilebilir ama `null`'a geri çekilemez (`resolveProfileGender`).
 *  - Çerçeve şeridi: kadın pembe, erkek mavi; bilinmiyorsa (eski hesap, bekleyen istek profili) nötr gri. Aynı renk
 *    harita pininde, widget'ta ve arkadaş listesinde kullanılır (`genderRingColor`).
 *  - Fotoğraf cihazda kırpılır (1:1) ve İKİ boyda JPEG olarak yeniden kodlanır (512 px ana, 160 px küçük). Yeniden
 *    kodlama EXIF'i (GPS dahil) atar. Storage yolu `avatars/{uid}/{version}.jpg` + `avatars/{uid}/{version}_160.jpg`;
 *    `version` = yükleme anı (13 haneli epoch ms). Pin / liste / widget küçük boyu, profil ekranı ana boyu kullanır.
 *  - Arkadaşlar fotoğrafı `friendships.member_profiles` içindeki indirme-token'lı URL'lerden görür (Faz 1 tasarımı);
 *    Storage okuma kuralı kapalıdır.
 */
import { z } from 'zod';
import type { UserId } from './model';

export const GENDERS = ['female', 'male'] as const;
export type Gender = (typeof GENDERS)[number];
export const GenderSchema = z.enum(GENDERS);
export const GENDER_TEXT: Record<Gender, string> = { female: 'Kadın', male: 'Erkek' };

/** Çerçeve şeridi: kadın pembe, erkek mavi; bilinmiyorsa (eski hesap, bekleyen istek) nötr gri. */
export const GENDER_RING = { female: '#EC4899', male: '#3B82F6', unknown: '#9CA3AF' } as const;

export function isGender(x: unknown): x is Gender {
  return x === 'female' || x === 'male';
}

/** Çerçeve rengi (hex). Bilinmeyen / eksik değer gri döner: eski hesaplar ve bozuk veri pin çizimini kırmaz. */
export function genderRingColor(g: Gender | null | undefined): string {
  return g === 'female' ? GENDER_RING.female : g === 'male' ? GENDER_RING.male : GENDER_RING.unknown;
}

/**
 * Profil oluşturma / güncelleme kuralı (backend `user_bootstrap` ve demo sunucusu aynı kararı verir):
 *  - oluşturma (`creating`) sırasında cinsiyet yoksa → `gender_required`;
 *  - sonraki çağrılarda verilmezse mevcut değer kalır (eski hesapta `null` kalabilir);
 *  - `null` istek şemasında zaten reddedilir (bir kez seçilen cinsiyet temizlenemez).
 */
export function resolveProfileGender(
  current: Gender | null,
  requested: Gender | undefined,
  creating: boolean,
): { ok: true; gender: Gender | null; changed: boolean } | { ok: false; code: 'gender_required' } {
  if (creating && !requested) return { ok: false, code: 'gender_required' };
  if (!requested) return { ok: true, gender: current, changed: false };
  return { ok: true, gender: requested, changed: requested !== current };
}

// ---------------------------------------------------------------------------
// Avatar: boyutlar, Storage yolları, URL eşleme
// ---------------------------------------------------------------------------

export const AVATAR_LIMITS = {
  mainPx: 512,
  thumbPx: 160,
  /** Widget'a (App Group / uygulama dosyası) yazılan boy; küçük JPEG'den türetilir. */
  widgetPx: 120,
  mainMaxBytes: 400_000,
  thumbMaxBytes: 60_000,
  jpegQuality: 0.8,
  thumbJpegQuality: 0.7,
} as const;

/** Storage dosya adı: `{version}.jpg` (ana) ya da `{version}_160.jpg` (küçük). */
export const AVATAR_FILE_RE = /^[0-9]{13}(_160)?\.jpg$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Storage yolu: avatars/{uid}/{version}.jpg ve avatars/{uid}/{version}_160.jpg; version = yükleme anı EpochMs (13 hane). */
export function avatarObjectPaths(uid: UserId, version: number): { main: string; thumb: string } {
  if (!UID_RE.test(uid)) throw new Error('Geçersiz kullanıcı kimliği');
  if (!Number.isInteger(version) || String(version).length !== 13) throw new Error('Avatar sürümü 13 haneli epoch ms olmalı');
  return { main: `avatars/${uid}/${version}.jpg`, thumb: `avatars/${uid}/${version}_160.jpg` };
}

export interface AvatarObjectRef {
  uid: UserId;
  version: number;
  thumb: boolean;
}

/** `avatars/{uid}/{dosya}` yolunu çözer; kurala uymayan her şey null. */
export function parseAvatarObjectPath(path: string): AvatarObjectRef | null {
  const m = /^avatars\/([A-Za-z0-9_-]{1,128})\/([^/]+)$/.exec(path);
  if (!m?.[1] || !m[2] || !AVATAR_FILE_RE.test(m[2])) return null;
  return { uid: m[1], version: Number(m[2].slice(0, 13)), thumb: m[2].includes('_160') };
}

/**
 * İndirme URL'sinden nesne yolunu çıkarır: `.../v0/b/{kova}/o/{yüzde-kodlu yol}?alt=media&token=...`
 * (üretim `firebasestorage.googleapis.com` ve emülatör aynı biçim). Alan adı / kova doğrulaması backend'dedir.
 * `URL` sınıfı kullanılmaz (React Native gerçeklemesi eksik).
 */
export function avatarObjectPathFromUrl(url: string): string | null {
  const m = /^https?:\/\/[^/?#]+\/v0\/b\/[^/?#]+\/o\/([^/?#]+)(?:[?#].*)?$/.exec(url);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

export type AvatarPairCheck = 'ok' | 'thumb_without_main' | 'thumb_mismatch';

/**
 * `avatar_url` + `avatar_thumb_url` birlikte doğrulanır: küçük boy, AYNI sürümün `_160` kardeşi olmalı ve aynı
 * kullanıcıya ait olmalı. `undefined` = alan gönderilmedi (değişmez). Fotoğraf kaldırılırken ikisi de `null`.
 * [Varsayım] Eski istemci yalnızca `avatar_url` gönderebilir: küçük boy yoksa sunucu `null` yazar, istemci ana boya düşer.
 */
export function checkAvatarPair(
  main: string | null | undefined,
  thumb: string | null | undefined,
  uid: UserId,
): AvatarPairCheck {
  if (thumb === undefined || thumb === null) return 'ok';
  if (typeof main !== 'string') return 'thumb_without_main';
  const a = parseAvatarObjectPath(avatarObjectPathFromUrl(main) ?? '');
  const b = parseAvatarObjectPath(avatarObjectPathFromUrl(thumb) ?? '');
  if (!a || !b || a.thumb || !b.thumb || a.uid !== uid || b.uid !== uid || a.version !== b.version) return 'thumb_mismatch';
  return 'ok';
}

/**
 * `user_bootstrap` isteğine Faz 6'da EKLENEN alanlar. Backend ve mobil istek şemaları
 * `.extend(ProfileFieldsF6Schema.shape)` ile kullanır. `avatar_thumb_url` `avatar_url` ile aynı biçim kuralına
 * tabidir (sunucu ayrıca `checkAvatarPair` + kova doğrulaması yapar). `gender: null` kabul edilmez.
 */
export const ProfileFieldsF6Schema = z.object({
  gender: GenderSchema.optional(),
  avatar_thumb_url: z.url({ protocol: /^https$/ }).max(2048).nullable().optional(),
});
export type ProfileFieldsF6 = z.input<typeof ProfileFieldsF6Schema>;

// ---------------------------------------------------------------------------
// Görünüm modeli (pin / widget / liste)
// ---------------------------------------------------------------------------

/** "Ayşe Yılmaz" → "AY" (Türkçe büyük harf kuralıyla: i → İ). */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length >= 2 ? [parts[0]!, parts[parts.length - 1]!] : parts.slice(0, 1);
  const out = letters.map((p) => Array.from(p)[0] ?? '').join('');
  return out.toLocaleUpperCase('tr-TR') || '?';
}

/** Pin / widget / liste için tek görünüm modeli. */
export interface AvatarView {
  name: string;
  initials: string;
  photo_url: string | null;
  ring: string;
  gender: Gender | null;
}

/**
 * `prefer: 'thumb'` (pin, liste, widget) küçük boyu, yoksa ana boyu; `'main'` (profil ekranı) tersini seçer.
 * Fotoğraf yoksa `photo_url: null` → baş harfli varsayılan avatar.
 */
export function avatarViewOf(
  p: { display_name: string; avatar_url: string | null; avatar_thumb_url?: string | null; gender?: Gender | null },
  prefer: 'main' | 'thumb',
): AvatarView {
  const main = p.avatar_url || null;
  const thumb = p.avatar_thumb_url || null;
  const gender = isGender(p.gender) ? p.gender : null;
  return {
    name: p.display_name,
    initials: initialsOf(p.display_name),
    photo_url: prefer === 'thumb' ? (thumb ?? main) : (main ?? thumb),
    ring: genderRingColor(gender),
    gender,
  };
}
