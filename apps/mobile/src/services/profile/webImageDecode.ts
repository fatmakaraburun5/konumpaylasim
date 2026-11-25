/**
 * Faz 6 (yalnızca web): seçilen fotoğrafı tarayıcıda çözer ve kare JPEG'e çevirir. Yalnızca `avatarUpload.web.ts`
 * içe aktarır; native pakete girmez.
 *
 * Neden ayrı bir hat (expo-image-manipulator web yerine): manipulator görüntüyü `crossOrigin='anonymous'` ile
 * `blob:` adresinden yükleyip tuvalden `toBlob` alır. Bazı tarayıcılarda / gömülü görüntüleyicilerde (özellikle
 * WebKit ve uygulama içi WebView'lar) bu yol "okunamadı" hatasına düşüyor [Varsayım: kullanıcı cihazında
 * yeniden üretilemedi, Chromium'da çalışıyor]. Burada CORS'suz ve URL'siz yollar sırayla denenir:
 *
 *   1. createImageBitmap(dosya)  (EXIF yönü uygulanır)
 *   2. <img> + nesne adresi (crossOrigin YOK)
 *   3. <img> + data: adresi
 *   4. HEIC / HEIF (iPhone): heic2any ile JPEG'e çevrilip yeniden 1-3
 *   5. TIFF: UTIF ile RGBA'ya çözülür
 *
 * Desteklenen: JPEG/JPG/JFIF, PNG, WEBP, GIF (ilk kare), BMP, ICO, AVIF (tarayıcı destekliyorsa), HEIC/HEIF, TIFF.
 * Şeffaf PNG / GIF beyaz zemine oturtulur (JPEG'de saydamlık yok; yoksa siyah çıkar).
 */
import heic2any from 'heic2any';
import { centerSquareCrop, type CropRect } from './avatarPipeline';

// utif tip paketi yok: kullanılan üç işlev burada tiplenir.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const UTIF = require('utif') as {
  decode: (buf: ArrayBuffer) => Array<{ width: number; height: number }>;
  decodeImage: (buf: ArrayBuffer, ifd: unknown) => void;
  toRGBA8: (ifd: unknown) => Uint8Array;
};

/** Dosya seçicide görünmesi istenen biçimler (uzantıyla da: bazı sistemler image/* ile HEIC/TIFF göstermiyor). */
export const WEB_IMAGE_ACCEPT =
  'image/*,.jpg,.jpeg,.jfif,.pjpeg,.pjp,.png,.webp,.gif,.bmp,.ico,.avif,.heic,.heif,.tif,.tiff';

export interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

export type ImageKind = 'heic' | 'tiff' | 'other';

/** Dosya imzası (magic bytes), MIME ve uzantıdan biçim tahmini. */
export function sniffImageKind(head: Uint8Array, mime: string, name: string): ImageKind {
  if (head.length >= 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
    const brand = String.fromCharCode(head[8]!, head[9]!, head[10]!, head[11]!);
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'heic';
  }
  if (
    head.length >= 4 &&
    ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0x00) ||
      (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && head[3] === 0x2a))
  ) {
    return 'tiff';
  }
  if (/hei[cf]/i.test(mime) || /\.hei[cf]$/i.test(name)) return 'heic';
  if (/tiff?$/i.test(mime) || /\.tiff?$/i.test(name)) return 'tiff';
  return 'other';
}

function loadImg(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // crossOrigin BİLEREK verilmez: blob:/data: adresleri bu belgeye aittir, tuval kirlenmez.
    img.decoding = 'async';
    img.onload = () => (img.naturalWidth > 0 && img.naturalHeight > 0 ? resolve(img) : reject(new Error('empty image')));
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

function readAsDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => (typeof r.result === 'string' ? resolve(r.result) : reject(new Error('read failed')));
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

/** Tarayıcının kendi çözücüleriyle (1-3). Olmazsa null. */
export async function decodeWithBrowser(blob: Blob): Promise<DecodedImage | null> {
  if (typeof createImageBitmap === 'function') {
    for (const opts of [{ imageOrientation: 'from-image' } as ImageBitmapOptions, undefined]) {
      try {
        const bmp = opts ? await createImageBitmap(blob, opts) : await createImageBitmap(blob);
        if (bmp.width > 0 && bmp.height > 0) return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
        bmp.close();
      } catch {
        // eski Safari seçenekli çağrıyı reddeder; seçeneksiz dene, o da olmazsa <img>
      }
    }
  }
  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImg(url);
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
    }
  }
  try {
    const img = await loadImg(await readAsDataURL(blob));
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
  } catch {
    return null;
  }
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function releaseCanvas(c: HTMLCanvasElement) {
  // iOS Safari tuval belleğini ancak boyut sıfırlanınca bırakır.
  c.width = 0;
  c.height = 0;
}

async function decodeTiff(buf: ArrayBuffer): Promise<DecodedImage | null> {
  try {
    const ifds = UTIF.decode(buf);
    const first = ifds[0];
    if (!first) return null;
    UTIF.decodeImage(buf, first);
    const rgba = UTIF.toRGBA8(first);
    const { width, height } = first;
    if (!(width > 0 && height > 0)) return null;
    const c = makeCanvas(width, height);
    const g = c.getContext('2d');
    if (!g) return null;
    const px = new Uint8ClampedArray(width * height * 4);
    px.set(rgba.subarray(0, px.length));
    g.putImageData(new ImageData(px, width, height), 0, 0);
    return { source: c, width, height, close: () => releaseCanvas(c) };
  } catch {
    return null;
  }
}

/** Herhangi bir fotoğraf dosyasını çözer; hiçbir yol açamazsa null. */
export async function decodeImageFile(file: Blob & { name?: string }): Promise<DecodedImage | null> {
  const name = file.name ?? '';
  const buf = await file.arrayBuffer();
  const kind = sniffImageKind(new Uint8Array(buf, 0, Math.min(16, buf.byteLength)), file.type || '', name);

  // TIFF'i yalnızca Safari çözer; önce tarayıcı, sonra UTIF.
  if (kind !== 'heic') {
    const native = await decodeWithBrowser(file);
    if (native) return native;
    if (kind === 'tiff') return decodeTiff(buf);
    return null;
  }

  // HEIC: Safari 17+ kendisi çözer; diğerlerinde heic2any (libheif) ile JPEG'e çevrilir.
  const native = await decodeWithBrowser(file);
  if (native) return native;
  try {
    const out = await heic2any({ blob: new Blob([buf], { type: 'image/heic' }), toType: 'image/jpeg', quality: 0.92 });
    const jpeg = Array.isArray(out) ? out[0] : out;
    return jpeg ? decodeWithBrowser(jpeg) : null;
  } catch {
    return null;
  }
}

/**
 * Kare kırp + `px` boyuta indir + JPEG kodla. Büyük oranlı küçültmede yarıya inerek ilerler (tek adımda 4032 → 512
 * küçültme bulanık / tırtıklı olur ve iOS'ta büyük ara tuval bellek sınırına takılabilir).
 */
export function renderSquareJpeg(img: DecodedImage, px: number, quality: number, crop: CropRect | null): { dataUrl: string; bytes: number } {
  const rect = crop ?? centerSquareCrop(img.width, img.height) ?? { originX: 0, originY: 0, width: img.width, height: img.height };
  let src: CanvasImageSource = img.source;
  let sx = rect.originX;
  let sy = rect.originY;
  let sw = rect.width;
  let sh = rect.height;
  const temps: HTMLCanvasElement[] = [];
  try {
    while (sw > px * 2 && sh > px * 2) {
      const nw = Math.max(px, Math.round(sw / 2));
      const nh = Math.max(px, Math.round(sh / 2));
      const c = makeCanvas(nw, nh);
      const g = c.getContext('2d');
      if (!g) break;
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(src, sx, sy, sw, sh, 0, 0, nw, nh);
      temps.push(c);
      src = c;
      sx = 0;
      sy = 0;
      sw = nw;
      sh = nh;
    }
    const out = makeCanvas(px, px);
    temps.push(out);
    const g = out.getContext('2d');
    if (!g) throw new Error('canvas 2d unavailable');
    g.fillStyle = '#FFFFFF';
    g.fillRect(0, 0, px, px);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, sx, sy, sw, sh, 0, 0, px, px);
    const dataUrl = out.toDataURL('image/jpeg', quality);
    if (!dataUrl.startsWith('data:image/jpeg')) throw new Error('jpeg encode failed');
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return { dataUrl, bytes: Math.floor((b64.length * 3) / 4) };
  } finally {
    temps.forEach(releaseCanvas);
  }
}
