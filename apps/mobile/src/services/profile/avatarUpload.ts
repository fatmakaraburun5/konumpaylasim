/**
 * Faz 6 (native): profil fotoğrafı seçimi, sıkıştırma ve Storage yüklemesi — `avatarPipeline.ts` bağımlılıkları.
 *
 *  - Seçim: expo-image-picker. Galeri iOS 14+ PHPicker / Android 13+ fotoğraf seçicisiyle İZİNSİZ açılır (sınırlı
 *    kitaplık erişimi de sorun değil: yalnızca seçilen fotoğraf gelir). Kamera izni istenir; reddedilmiş ve tekrar
 *    sorulamıyorsa `denied` + `canAskAgain: false` → arayüz "Ayarları aç" (Linking.openSettings).
 *    `allowsEditing` + `aspect: [1, 1]`: sistem kırpıcısı kare kırpar (iOS her zaman kare; Android oranı uygular).
 *  - Sıkıştırma: expo-image-manipulator (yeni bağlamsal API) kare kırp → 512 / 160 px → JPEG. Yeniden kodlama EXIF'i
 *    (GPS dahil) atar. Bayt ölçümü expo-file-system `File.size`.
 *  - Yükleme: @react-native-firebase/storage `putFile` (contentType image/jpeg, uzun önbellek; adres sürümlü olduğu
 *    için değişmez) → `getDownloadURL` (indirme token'lı adres; Storage okuma kuralı kapalı, Faz 1 tasarımı).
 */
import { getStorage, getDownloadURL, putFile, ref } from '@react-native-firebase/storage';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Linking } from 'react-native';
import { ensureFirebase } from '../firebase/init';
import type { AvatarPlatform, AvatarSource, CropRect, EncodedImage, PickResult, SourceImage } from './avatarPipeline';

const PICKER_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  allowsEditing: true,
  aspect: [1, 1],
  // Sistem seçicisinin kendi sıkıştırması: asıl boyutlandırma / kodlama manipulator'da.
  quality: 0.9,
  exif: false,
  base64: false,
  // iOS: HEIC fotoğraflar seçicide JPEG'e çevrilir (manipulator yine de HEIC çözebilir; uyumlu biçim en güvenlisi).
  preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};

async function ensureCameraPermission(): Promise<{ ok: true } | { ok: false; canAskAgain: boolean }> {
  const cur = await ImagePicker.getCameraPermissionsAsync();
  if (cur.granted) return { ok: true };
  if (!cur.canAskAgain) return { ok: false, canAskAgain: false };
  const r = await ImagePicker.requestCameraPermissionsAsync();
  return r.granted ? { ok: true } : { ok: false, canAskAgain: r.canAskAgain };
}

export async function pickAvatarImage(source: AvatarSource): Promise<PickResult> {
  try {
    if (source === 'camera') {
      const perm = await ensureCameraPermission();
      if (!perm.ok) return { kind: 'denied', source, canAskAgain: perm.canAskAgain };
    }
    const res = source === 'camera' ? await ImagePicker.launchCameraAsync(PICKER_OPTIONS) : await ImagePicker.launchImageLibraryAsync(PICKER_OPTIONS);
    if (res.canceled || !res.assets?.[0]) return { kind: 'cancelled' };
    const a = res.assets[0];
    return { kind: 'picked', image: { uri: a.uri, width: a.width || 0, height: a.height || 0 } };
  } catch (e) {
    // Eski Android / iOS kitaplık izni reddi seçici açılırken hata olarak gelebilir.
    const msg = String((e as { message?: unknown })?.message ?? '');
    if (/permission/i.test(msg)) return { kind: 'denied', source, canAskAgain: false };
    return { kind: 'unavailable', source };
  }
}

function fileBytes(uri: string): number | null {
  try {
    const f = new File(uri);
    return f.exists ? f.size : null;
  } catch {
    return null;
  }
}

async function encode(src: SourceImage, px: number, quality: number, crop: CropRect | null): Promise<EncodedImage> {
  try {
    return await encodeOnce(src, px, quality, crop);
  } catch (e) {
    // Seçicinin bildirdiği boyut (EXIF yönü / kırpma sonrası) gerçek görüntüyle uyuşmazsa kırpma dikdörtgeni taşar
    // ve manipulator hata verir: kırpmasız yeniden dene (seçici `allowsEditing` ile zaten kare kırptı).
    if (crop) return encodeOnce(src, px, quality, null);
    throw e;
  }
}

async function encodeOnce(src: SourceImage, px: number, quality: number, crop: CropRect | null): Promise<EncodedImage> {
  // Büyük kamera fotoğrafı belleğe tam çözülmesin (kırpma yoksa çözümleme sınırı).
  const ctx = ImageManipulator.manipulate(src.uri);
  if (crop) ctx.crop(crop);
  ctx.resize({ width: px, height: px });
  const img = await ctx.renderAsync();
  try {
    const out = await img.saveAsync({ compress: quality, format: SaveFormat.JPEG });
    return { uri: out.uri, width: out.width, height: out.height, bytes: fileBytes(out.uri) };
  } finally {
    img.release();
    ctx.release();
  }
}

async function upload(objectPath: string, file: EncodedImage): Promise<string> {
  await ensureFirebase();
  const r = ref(getStorage(), objectPath);
  await putFile(r, file.uri, { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' });
  return getDownloadURL(r);
}

export const avatarPlatform: AvatarPlatform = {
  pick: pickAvatarImage,
  deps: { encode, upload, now: () => Date.now() },
  openSettings: () => Linking.openSettings().catch(() => undefined),
  cameraAvailable: true,
};
