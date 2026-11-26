/**
 * Faz 7: kamera ve fotoğraf izinleri (expo-image-picker). Yalnızca profil fotoğrafı için; iOS 14+ sistem seçicisi
 * (PHPicker) ve Android 13+ fotoğraf seçici izinsiz de çalışır, bu yüzden izin isteği isteğe bağlıdır.
 */
import type { MediaPermState, PermState } from '@konum/core';
import * as ImagePicker from 'expo-image-picker';

export interface MediaPermissions {
  camera: PermState;
  cameraCanAskAgain: boolean;
  photos: MediaPermState;
  photosCanAskAgain: boolean;
}

const toState = (r: { granted?: boolean; status?: string }): PermState =>
  r.granted || r.status === 'granted' ? 'granted' : r.status === 'denied' ? 'denied' : 'undetermined';

const photosOf = (r: ImagePicker.MediaLibraryPermissionResponse): MediaPermState => (r.accessPrivileges === 'limited' ? 'limited' : toState(r));

export async function readMediaPermissions(): Promise<MediaPermissions> {
  try {
    const [cam, lib] = await Promise.all([ImagePicker.getCameraPermissionsAsync(), ImagePicker.getMediaLibraryPermissionsAsync()]);
    return { camera: toState(cam), cameraCanAskAgain: cam.canAskAgain, photos: photosOf(lib), photosCanAskAgain: lib.canAskAgain };
  } catch {
    return { camera: 'undetermined', cameraCanAskAgain: true, photos: 'undetermined', photosCanAskAgain: true };
  }
}

export async function requestCameraPermission(): Promise<PermState> {
  try {
    return toState(await ImagePicker.requestCameraPermissionsAsync());
  } catch {
    return 'denied';
  }
}

export async function requestPhotosPermission(): Promise<MediaPermState> {
  try {
    return photosOf(await ImagePicker.requestMediaLibraryPermissionsAsync());
  } catch {
    return 'denied';
  }
}
