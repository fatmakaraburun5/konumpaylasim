/**
 * Faz 6: profil fotoğrafı hattı (saf; yerel modüller bağımlılık olarak verilir, testte sahtesi kullanılır).
 *
 *   seç (kamera / galeri, 1:1 kırpma) → kare kırp (gerekirse) → 512 px JPEG (0.8) → 160 px JPEG (0.7)
 *   → Storage `avatars/{uid}/{sürüm}.jpg` + `{sürüm}_160.jpg` (sürüm = yükleme anı, 13 haneli epoch ms)
 *   → `user_bootstrap { avatar_url, avatar_thumb_url }` (sunucu ikisinin aynı sürüm olduğunu doğrular).
 *
 * Gizlilik: görüntü cihazda YENİDEN KODLANIR; bu, kameranın / galerinin EXIF verisini (GPS konumu dahil) atar.
 * Boyut: ana boy `AVATAR_LIMITS.mainMaxBytes`, küçük boy `thumbMaxBytes` üstündeyse kalite düşürülerek yeniden
 * kodlanır (Storage kuralı da bu sınırları uygular).
 */
import { AVATAR_LIMITS, avatarObjectPaths, type UserId } from '@konum/core';

export interface SourceImage {
  uri: string;
  /** 0 = bilinmiyor (bazı Android seçicileri boyut vermez). */
  width: number;
  height: number;
}

export interface EncodedImage extends SourceImage {
  /** Dosya boyutu (bayt); ölçülemiyorsa null (sınır denetimi atlanır, Storage kuralı yine uygular). */
  bytes: number | null;
}

export interface CropRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export type AvatarErrorCode = 'too_large' | 'invalid_image' | 'unsupported_format' | 'upload_failed' | 'offline';

export class AvatarError extends Error {
  constructor(
    public readonly code: AvatarErrorCode,
    message: string = AVATAR_ERROR_TEXT[code],
  ) {
    super(message);
    this.name = 'AvatarError';
  }
}

export const AVATAR_ERROR_TEXT: Record<AvatarErrorCode, string> = {
  too_large: 'Fotoğraf sıkıştırılamadı. Başka bir fotoğraf dene.',
  invalid_image: 'Fotoğraf okunamadı. Başka bir fotoğraf dene.',
  unsupported_format: 'Bu fotoğraf açılamadı. JPEG, PNG, HEIC, WEBP, GIF, BMP, TIFF ya da AVIF bir fotoğraf dene.',
  upload_failed: 'Fotoğraf yüklenemedi. Tekrar dene.',
  offline: 'Bağlantı yok. İnternet gelince tekrar dene.',
};

export interface AvatarPipelineDeps {
  /** Kırp (verilirse) + `px` kare boyuta getir + JPEG `quality` ile kaydet. */
  encode: (src: SourceImage, px: number, quality: number, crop: CropRect | null) => Promise<EncodedImage>;
  /** Storage'a yükler, indirme adresini döner. */
  upload: (objectPath: string, file: EncodedImage) => Promise<string>;
  now: () => number;
}

/** Kare değilse ortadan kare kırpma dikdörtgeni; boyut bilinmiyor ya da zaten kareyse null. */
export function centerSquareCrop(width: number, height: number): CropRect | null {
  if (!(width > 0) || !(height > 0) || width === height) return null;
  const side = Math.min(width, height);
  return { originX: Math.floor((width - side) / 2), originY: Math.floor((height - side) / 2), width: side, height: side };
}

/** Kalite merdiveni: sınırı aşan JPEG daha düşük kaliteyle yeniden kodlanır. [Varsayım] */
const MAIN_QUALITY_STEPS = [AVATAR_LIMITS.jpegQuality, 0.65, 0.5] as const;
const THUMB_QUALITY_STEPS = [AVATAR_LIMITS.thumbJpegQuality, 0.55, 0.4] as const;

async function encodeWithin(
  deps: AvatarPipelineDeps,
  src: SourceImage,
  px: number,
  steps: readonly number[],
  maxBytes: number,
  crop: CropRect | null,
): Promise<EncodedImage> {
  let last: EncodedImage | null = null;
  for (const q of steps) {
    last = await deps.encode(src, px, q, crop);
    if (last.bytes === null || last.bytes <= maxBytes) return last;
  }
  throw new AvatarError('too_large');
}

/** Seçilen görüntüden iki boy: 512 px ana ve (ana boydan) 160 px küçük. */
export async function prepareAvatar(src: SourceImage, deps: AvatarPipelineDeps): Promise<{ main: EncodedImage; thumb: EncodedImage }> {
  if (!src.uri) throw new AvatarError('invalid_image');
  let main: EncodedImage;
  try {
    main = await encodeWithin(deps, src, AVATAR_LIMITS.mainPx, MAIN_QUALITY_STEPS, AVATAR_LIMITS.mainMaxBytes, centerSquareCrop(src.width, src.height));
  } catch (e) {
    throw e instanceof AvatarError ? e : new AvatarError('invalid_image');
  }
  let thumb: EncodedImage;
  try {
    thumb = await encodeWithin(deps, main, AVATAR_LIMITS.thumbPx, THUMB_QUALITY_STEPS, AVATAR_LIMITS.thumbMaxBytes, null);
  } catch (e) {
    throw e instanceof AvatarError ? e : new AvatarError('invalid_image');
  }
  return { main, thumb };
}

export interface UploadedAvatar {
  avatar_url: string;
  avatar_thumb_url: string;
  version: number;
}

/** Önce ana, sonra küçük boy yüklenir (aynı sürüm). Hata `upload_failed` / `offline` olur. */
export async function uploadPreparedAvatar(
  uid: UserId,
  prepared: { main: EncodedImage; thumb: EncodedImage },
  deps: AvatarPipelineDeps,
): Promise<UploadedAvatar> {
  const version = Math.floor(deps.now());
  const paths = avatarObjectPaths(uid, version);
  try {
    const avatar_url = await deps.upload(paths.main, prepared.main);
    const avatar_thumb_url = await deps.upload(paths.thumb, prepared.thumb);
    return { avatar_url, avatar_thumb_url, version };
  } catch (e) {
    throw toAvatarUploadError(e);
  }
}

/** Storage / ağ hatası → arayüz kodu. */
export function toAvatarUploadError(e: unknown): AvatarError {
  if (e instanceof AvatarError) return e;
  const code = String((e as { code?: unknown })?.code ?? '');
  const msg = String((e as { message?: unknown })?.message ?? '');
  if (/network|unavailable|retry-limit|offline/i.test(code) || /network|offline|timeout/i.test(msg)) return new AvatarError('offline');
  return new AvatarError('upload_failed');
}

// --- Seçim (kamera / galeri) sonucu: native ve web kardeşleri aynı tipi döner -----------------------------

export type AvatarSource = 'camera' | 'library';

export type PickResult =
  | { kind: 'picked'; image: SourceImage }
  | { kind: 'cancelled' }
  /** İzin reddedildi. `canAskAgain: false` → arayüz "Ayarları aç" gösterir. */
  | { kind: 'denied'; source: AvatarSource; canAskAgain: boolean }
  /** Cihazda kamera yok / seçici açılamadı. */
  | { kind: 'unavailable'; source: AvatarSource };

/** Platform bağlaması (avatarUpload.ts / avatarUpload.web.ts). */
export interface AvatarPlatform {
  pick: (source: AvatarSource) => Promise<PickResult>;
  deps: AvatarPipelineDeps;
  openSettings: () => Promise<void>;
  /** Kamera bu platformda var mı (web: dosya seçici `capture`). */
  cameraAvailable: boolean;
}

export const PICK_DENIED_TEXT: Record<AvatarSource, string> = {
  camera: 'Kamera izni kapalı. Fotoğraf çekmek için Ayarlar’dan kamera iznini aç.',
  library: 'Fotoğraflara erişim kapalı. Galeriden seçmek için Ayarlar’dan izin ver.',
};
