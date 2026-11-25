/**
 * Web demo: profil fotoğrafı (avatarUpload.ts ile aynı dışa aktarımlar).
 *
 *  - Seçim: expo-image-picker web (gizli `<input type="file">`; kamera `capture` ile — telefonda kamera açılır,
 *    masaüstünde dosya seçici). Tarayıcı izin sormaz; `allowsEditing` web'de kırpıcı açmaz → kare kırpma
 *    manipulator'da yapılır (`centerSquareCrop`).
 *  - Sıkıştırma: expo-image-manipulator web (canvas) → JPEG data: URI; bayt = base64 uzunluğu.
 *  - "Yükleme": demo sunucusunda Storage yok. Firebase biçiminde bir indirme adresi üretilir ve görüntü
 *    `registerAvatarDataUri` ile tarayıcıda tutulur (Avatar bu adresi data: URI'ye çevirir). Demo sunucusu
 *    `putAvatarObject(path, dataUri)` sağlıyorsa (isteğe bağlı) adresi o üretir.
 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { demoServer } from '../../demo/server';
import { demoOnline } from '../../demo/web/network';
import { registerAvatarDataUri } from '../../ui/avatarUri';
import { AvatarError, type AvatarPlatform, type AvatarSource, type CropRect, type EncodedImage, type PickResult, type SourceImage } from './avatarPipeline';

/** Demo "kovası" (backend `avatarBuckets` gerçekte projenin kovası). */
export const DEMO_AVATAR_BUCKET = 'konum-demo.appspot.com';

const PICKER_OPTIONS: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.9, base64: false };

export async function pickAvatarImage(source: AvatarSource): Promise<PickResult> {
  try {
    const res = source === 'camera' ? await ImagePicker.launchCameraAsync(PICKER_OPTIONS) : await ImagePicker.launchImageLibraryAsync(PICKER_OPTIONS);
    if (res.canceled || !res.assets?.[0]) return { kind: 'cancelled' };
    const a = res.assets[0];
    return { kind: 'picked', image: { uri: a.uri, width: a.width || 0, height: a.height || 0 } };
  } catch {
    return { kind: 'unavailable', source };
  }
}

async function encode(src: SourceImage, px: number, quality: number, crop: CropRect | null): Promise<EncodedImage> {
  const ctx = ImageManipulator.manipulate(src.uri);
  // Web seçicisi kırpmaz: boyut bilinmiyorsa önce çözülür, kare değilse ortadan kırpılır.
  let rect = crop;
  if (!rect && !(src.width > 0 && src.height > 0)) {
    const probe = await ImageManipulator.manipulate(src.uri).renderAsync();
    const w = probe.width;
    const h = probe.height;
    probe.release();
    if (w !== h && w > 0 && h > 0) {
      const side = Math.min(w, h);
      rect = { originX: Math.floor((w - side) / 2), originY: Math.floor((h - side) / 2), width: side, height: side };
    }
  }
  if (rect) ctx.crop(rect);
  ctx.resize({ width: px, height: px });
  const img = await ctx.renderAsync();
  const out = await img.saveAsync({ compress: quality, format: SaveFormat.JPEG, base64: true });
  img.release();
  const b64 = out.base64 ?? '';
  return { uri: `data:image/jpeg;base64,${b64}`, width: out.width, height: out.height, bytes: Math.floor((b64.length * 3) / 4) };
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
