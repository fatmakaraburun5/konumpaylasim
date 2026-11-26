/**
 * Web demo: kamera / fotoğraf izni simüle edilir (demo bir iPhone'u taklit eder). Durum demo deposunda kalır, sayfa
 * yenilenince de İzin & Gizlilik Merkezi aynı durumu gösterir ("Tüm demo verilerini sıfırla" siler).
 */
import type { MediaPermState, PermState } from '@konum/core';
import { safeStorage } from '../../demo/server/storage';

export interface MediaPermissions {
  camera: PermState;
  cameraCanAskAgain: boolean;
  photos: MediaPermState;
  photosCanAskAgain: boolean;
}

const KEY = 'konum.demo.media.v1';

function load(): { camera: PermState; photos: MediaPermState } {
  try {
    const raw = safeStorage.get(KEY);
    const v = raw ? (JSON.parse(raw) as { camera?: unknown; photos?: unknown }) : {};
    return { camera: v.camera === 'granted' ? 'granted' : 'undetermined', photos: v.photos === 'granted' ? 'granted' : 'undetermined' };
  } catch {
    return { camera: 'undetermined', photos: 'undetermined' };
  }
}

let state = load();

const save = () => safeStorage.set(KEY, JSON.stringify(state));

export async function readMediaPermissions(): Promise<MediaPermissions> {
  return { camera: state.camera, cameraCanAskAgain: state.camera === 'undetermined', photos: state.photos, photosCanAskAgain: state.photos === 'undetermined' };
}

export async function requestCameraPermission(): Promise<PermState> {
  state = { ...state, camera: 'granted' };
  save();
  return state.camera;
}

export async function requestPhotosPermission(): Promise<MediaPermState> {
  state = { ...state, photos: 'granted' };
  save();
  return state.photos;
}
