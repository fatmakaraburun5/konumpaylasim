/**
 * Web demo: profil fotoğrafı (avatarUpload.ts ile aynı dışa aktarımlar).
 *
 *  - Seçim: kendi gizli `<input type="file">`'ımız (expo-image-picker web yerine). Böylece `accept` listesi geniş
 *    tutulur (JPEG, PNG, HEIC, WEBP, GIF, BMP, TIFF, AVIF… uzantıyla da) ve dosyanın kendisi alınır; kamera
 *    `capture` ile (telefonda kamera açılır, masaüstünde dosya seçici).
 *  - Çözme + sıkıştırma: `webImageDecode.ts` (tarayıcının kendi çözücüleri, CORS'suz yollar, beyaz zemin, kademeli
 *    küçültme) → JPEG data: URI; bayt = base64 uzunluğu.
 *  - "Yükleme": demo sunucusunda Storage yok. Firebase biçiminde bir indirme adresi üretilir ve görüntü
 *    `registerAvatarDataUri` ile tarayıcıda tutulur (Avatar bu adresi data: URI'ye çevirir). Demo sunucusu
 *    `putAvatarObject(path, dataUri)` sağlıyorsa (isteğe bağlı) adresi o üretir.
 */
import { demoServer } from '../../demo/server';
import { demoOnline } from '../../demo/web/network';
import { registerAvatarDataUri } from '../../ui/avatarUri';
import { AVATAR_ERROR_TEXT, AvatarError, centerSquareCrop, type AvatarPlatform, type AvatarSource, type CropRect, type EncodedImage, type PickResult, type SourceImage } from './avatarPipeline';
import { decodeImageFile, decodeWithBrowser, renderSquareJpeg, WEB_IMAGE_ACCEPT, type DecodedImage } from './webImageDecode';

/** Demo "kovası" (backend `avatarBuckets` gerçekte projenin kovası). */
export const DEMO_AVATAR_BUCKET = 'konum-demo.appspot.com';

/**
 * Seçilen ve çözülen görüntüler (anahtar = dosyanın nesne adresi; aynı adres yükleme sırasında önizlemede de
 * gösterilir). Yeni seçimde öncekiler bırakılır. null = çözülemedi.
 */
const picked = new Map<string, DecodedImage | null>();
/**
 * Ana boy (512) JPEG data: adresi → onu üreten asıl görüntü + kırpma. Küçük boy (160) bu asıl görüntüden çizilir;
 * 512'lik JPEG'i yeniden çözmek gerekmez (kısıtlı görüntüleyicilerde ikinci çözme hata kaynağıydı).
 */
const derived = new Map<string, { img: DecodedImage; crop: CropRect | null }>();
let seq = 0;

function releasePicked() {
  for (const d of picked.values()) d?.close();
  picked.clear();
  derived.clear();
}

/** Çözülemeyen dosyanın anahtarı: URL DEĞİL (blob: önizlemesi sıkı CSP'de engelleniyor ve konsolu dolduruyor). */
function opaqueKey(): string {
  return `konum-web-image:${++seq}`;
}

/**
 * Önizleme adresi: kare JPEG data: adresi. `blob:` adresi KULLANILMAZ: sıkı CSP'li görüntüleyiciler (img-src yalnızca
 * data:) blob: görselini engelliyor, önizleme boş kalıyordu.
 */
function previewFor(img: DecodedImage): string | null {
  try {
    return renderSquareJpeg(img, PREVIEW_PX, 0.8, null).dataUrl;
  } catch {
    return null;
  }
}
const PREVIEW_PX = 320;

/** data: adresini `fetch` OLMADAN Blob'a çevirir (connect-src kısıtlı sayfalarda fetch(data:) engelleniyor). */
export function dataUrlToBlob(uri: string): Blob | null {
  const comma = uri.indexOf(',');
  if (!uri.startsWith('data:') || comma < 0) return null;
  const meta = uri.slice(5, comma);
  const type = meta.split(';')[0] || 'application/octet-stream';
  try {
    const body = uri.slice(comma + 1);
    if (!/;base64/i.test(meta)) return new Blob([decodeURIComponent(body)], { type });
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  } catch {
    return null;
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
  const decoded = await decodeImageFile(file).catch(() => null);
  const key = (decoded && previewFor(decoded)) || opaqueKey();
  picked.set(key, decoded);
  // Çözülemese de "seçildi" döner: hata sıkıştırma adımında anlamlı metinle (`unsupported_format`) gösterilir.
  return { kind: 'picked', image: { uri: key, width: decoded?.width ?? 0, height: decoded?.height ?? 0 } };
}

async function sourceFor(uri: string): Promise<{ img: DecodedImage; crop: CropRect | null; own: boolean } | null> {
  if (picked.has(uri)) {
    const img = picked.get(uri);
    return img ? { img, crop: null, own: true } : null;
  }
  const d = derived.get(uri);
  if (d) return { img: d.img, crop: d.crop, own: true };
  // Yedek: başka bir data: adresi (ör. sayfa yenilendikten sonra). `fetch(data:)` KULLANILMAZ: sıkı CSP'li
  // görüntüleyicide (connect-src 'none') engelleniyor ve "Fotoğraf okunamadı" hatasına düşüyordu.
  if (uri.startsWith('data:')) {
    const blob = dataUrlToBlob(uri);
    const img = blob ? await decodeWithBrowser(blob) : null;
    return img ? { img, crop: null, own: false } : null;
  }
  return null;
}

async function encode(src: SourceImage, px: number, quality: number, crop: CropRect | null): Promise<EncodedImage> {
  const s = await sourceFor(src.uri);
  if (!s) throw new AvatarError('unsupported_format');
  const useCrop = crop ?? s.crop;
  try {
    const { dataUrl, bytes } = renderSquareJpeg(s.img, px, quality, useCrop);
    if (s.own) derived.set(dataUrl, { img: s.img, crop: useCrop ?? centerSquareCrop(s.img.width, s.img.height) });
    return { uri: dataUrl, width: px, height: px, bytes };
  } catch (e) {
    // Görüntüleyiciye özgü hatalar uzaktan teşhis edilebilsin: kısa neden koda eklenir.
    const why = e instanceof Error ? e.name || e.message : String(e);
    console.warn('[avatar] encode', px, e);
    throw new AvatarError('invalid_image', `${AVATAR_ERROR_TEXT.invalid_image} (${px}: ${why.slice(0, 40)})`);
  } finally {
    // data: kaynaklı geçici çözüm hemen bırakılır; seçilen asıl görüntü yeni seçime kadar kalır.
    if (!s.own) s.img.close();
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
