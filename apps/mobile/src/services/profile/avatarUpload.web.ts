/**
 * Web demo: profil fotoğrafı (avatarUpload.ts ile aynı dışa aktarımlar).
 *
 *  - Seçim: kendi gizli `<input type="file">`'ımız (expo-image-picker web yerine). Böylece `accept` listesi geniş
 *    tutulur (JPEG, PNG, HEIC, WEBP, GIF, BMP, TIFF, AVIF… uzantıyla da) ve dosyanın kendisi alınır; kamera
 *    `capture` ile (telefonda kamera açılır, masaüstünde dosya seçici).
 *  - Çözme + sıkıştırma: `webImageDecode.ts` (CORS'suz yollar, HEIC / TIFF çözücüleri, beyaz zemin, kademeli
 *    küçültme) → JPEG data: URI; bayt = base64 uzunluğu.
 *  - "Yükleme": demo sunucusunda Storage yok. Firebase biçiminde bir indirme adresi üretilir ve görüntü
 *    `registerAvatarDataUri` ile tarayıcıda tutulur (Avatar bu adresi data: URI'ye çevirir). Demo sunucusu
 *    `putAvatarObject(path, dataUri)` sağlıyorsa (isteğe bağlı) adresi o üretir.
 */
import { demoServer } from '../../demo/server';
import { demoOnline } from '../../demo/web/network';
import { registerAvatarDataUri } from '../../ui/avatarUri';
import { AvatarError, type AvatarPlatform, type AvatarSource, type CropRect, type EncodedImage, type PickResult, type SourceImage } from './avatarPipeline';
import { decodeImageFile, decodeWithBrowser, renderSquareJpeg, WEB_IMAGE_ACCEPT, type DecodedImage } from './webImageDecode';

/** Demo "kovası" (backend `avatarBuckets` gerçekte projenin kovası). */
export const DEMO_AVATAR_BUCKET = 'konum-demo.appspot.com';

/**
 * Seçilen ve çözülen görüntüler (anahtar = dosyanın nesne adresi; aynı adres yükleme sırasında önizlemede de
 * gösterilir). Yeni seçimde öncekiler bırakılır. null = çözülemedi.
 */
const picked = new Map<string, DecodedImage | null>();
let seq = 0;

function releasePicked() {
  for (const [key, d] of picked) {
    d?.close();
    if (key.startsWith('blob:')) URL.revokeObjectURL(key);
  }
  picked.clear();
}

function keyFor(file: File): string {
  try {
    return URL.createObjectURL(file);
  } catch {
    return `konum-web-image:${++seq}`;
  }
}

/** Dosya seçiciyi AYNI kullanıcı hareketi içinde açar (await'ten önce `click`), seçilen dosyayı döner. */
function chooseFile(source: AvatarSource): Promise<File | null> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('no document'));
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = WEB_IMAGE_ACCEPT;
    if (source === 'camera') input.setAttribute('capture', 'user');
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    input.style.opacity = '0';
    document.body.appendChild(input);
    let done = false;
    const finish = (f: File | null) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(f);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    // Chrome 113+, Safari 16.4+, Firefox 91+: vazgeçince `cancel` gelir.
    input.addEventListener('cancel', () => finish(null));
    input.click();
  });
}

export async function pickAvatarImage(source: AvatarSource): Promise<PickResult> {
  let file: File | null;
  try {
    file = await chooseFile(source);
  } catch {
    return { kind: 'unavailable', source };
  }
  if (!file) return { kind: 'cancelled' };
  releasePicked();
  const key = keyFor(file);
  const decoded = await decodeImageFile(file).catch(() => null);
  picked.set(key, decoded);
  // Çözülemese de "seçildi" döner: hata sıkıştırma adımında anlamlı metinle (`unsupported_format`) gösterilir.
  return { kind: 'picked', image: { uri: key, width: decoded?.width ?? 0, height: decoded?.height ?? 0 } };
}

async function sourceFor(uri: string): Promise<DecodedImage | null> {
  if (picked.has(uri)) return picked.get(uri) ?? null;
  // Küçük boy, ana boyun (bizim ürettiğimiz) JPEG data: adresinden üretilir.
  if (uri.startsWith('data:')) {
    const blob = await (await fetch(uri)).blob().catch(() => null);
    return blob ? decodeWithBrowser(blob) : null;
  }
  return null;
}

async function encode(src: SourceImage, px: number, quality: number, crop: CropRect | null): Promise<EncodedImage> {
  const own = picked.has(src.uri);
  const img = await sourceFor(src.uri);
  if (!img) throw new AvatarError('unsupported_format');
  try {
    const { dataUrl, bytes } = renderSquareJpeg(img, px, quality, crop);
    return { uri: dataUrl, width: px, height: px, bytes };
  } catch {
    throw new AvatarError('invalid_image');
  } finally {
    // data: kaynaklı (küçük boy) geçici çözüm hemen bırakılır; seçilen asıl görüntü yeni seçime kadar kalır.
    if (!own) img.close();
  }
}

type DemoAvatarStore = { putAvatarObject?: (path: string, dataUri: string) => string | Promise<string> };

async function upload(objectPath: string, file: EncodedImage): Promise<string> {
  await new Promise((r) => setTimeout(r, 250 + Math.random() * 300));
  // "Tünele gir" (simüle bağlantı yok): yükleme native'deki gibi başarısız olur, arayüz "Tekrar dene" gösterir.
  if (!demoOnline()) throw new AvatarError('offline');
  const server = demoServer() as unknown as DemoAvatarStore;
  const url =
    typeof server.putAvatarObject === 'function'
      ? await server.putAvatarObject(objectPath, file.uri)
      : `https://firebasestorage.googleapis.com/v0/b/${DEMO_AVATAR_BUCKET}/o/${encodeURIComponent(objectPath)}?alt=media&token=demo-${Math.random().toString(36).slice(2, 10)}`;
  registerAvatarDataUri(url, file.uri);
  return url;
}

export const avatarPlatform: AvatarPlatform = {
  pick: pickAvatarImage,
  deps: { encode, upload, now: () => Date.now() },
  openSettings: async () => undefined,
  cameraAvailable: true,
};
