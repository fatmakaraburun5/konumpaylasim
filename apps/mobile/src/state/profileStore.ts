/**
 * Faz 6: profil fotoğrafı durumu (iyimser arayüz + yeniden deneme).
 *
 *   changePhoto(kaynak) → seç → [önizleme = seçilen yerel dosya] → sıkıştır (512 + 160) → Storage'a yükle
 *   → `user_bootstrap { avatar_url, avatar_thumb_url }` → profil dinleyicisi yeni adresi getirir.
 *
 *  - Önizleme hemen görünür (iyimser); hata olursa önizleme kalır, "Tekrar dene" kaldığı adımdan sürer:
 *    yükleme bittiyse yalnızca profil çağrısı yinelenir (aynı adresler), sıkıştırma bittiyse yeniden kodlanmaz.
 *  - İzin reddi `denied` alanında: `canAskAgain: false` → arayüz "Ayarları aç".
 *  - Fotoğrafı kaldır: `avatar_url: null` (sunucu küçük boyu da siler, eski nesneler en iyi çabayla silinir).
 */
import type { UserId } from '@konum/core';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { avatarPlatform } from '../services/profile/avatarUpload';
import {
  AvatarError,
  prepareAvatar,
  uploadPreparedAvatar,
  type AvatarPlatform,
  type AvatarSource,
  type EncodedImage,
  type UploadedAvatar,
} from '../services/profile/avatarPipeline';
import { authStore, type ProfilePatch } from './authStore';

export type PhotoPhase = 'idle' | 'processing' | 'uploading' | 'saving' | 'error';

export interface ProfileStoreState {
  phase: PhotoPhase;
  /** İyimser önizleme (yerel dosya / data: URI); null = profildeki fotoğraf. */
  previewUri: string | null;
  error: string | null;
  /** Son izin reddi (arayüz "Ayarları aç" gösterir). */
  denied: { source: AvatarSource; canAskAgain: boolean } | null;
  changePhoto: (source: AvatarSource) => Promise<boolean>;
  retryPhoto: () => Promise<boolean>;
  removePhoto: () => Promise<boolean>;
  clearDenied: () => void;
  reset: () => void;
}

export interface ProfileStoreDeps {
  platform: AvatarPlatform;
  uid: () => UserId | null;
  save: (patch: ProfilePatch) => Promise<{ ok: true } | { ok: false; message: string }>;
}

const UNAVAILABLE_TEXT: Record<AvatarSource, string> = {
  camera: 'Kamera açılamadı. Galeriden seçmeyi dene.',
  library: 'Galeri açılamadı. Tekrar dene.',
};

export function createProfileStore(overrides: Partial<ProfileStoreDeps> = {}): StoreApi<ProfileStoreState> {
  const deps: ProfileStoreDeps = {
    platform: avatarPlatform,
    uid: () => authStore.getState().uid,
    save: (patch) => authStore.getState().updateProfile(patch),
    ...overrides,
  };
  /** Yeniden deneme için ara sonuçlar. */
  let prepared: { main: EncodedImage; thumb: EncodedImage } | null = null;
  let uploaded: UploadedAvatar | null = null;
  let running: Promise<boolean> | null = null;

  /** Seçilen görüntünün boyutu (kare kırpma kararı). */
  let pendingSize = { w: 0, h: 0 };

  return createStore<ProfileStoreState>()((set, get) => {
    async function runFrom(): Promise<boolean> {
      const uid = deps.uid();
      if (!uid) return false;
      try {
        if (!uploaded) {
          if (!prepared) {
            set({ phase: 'processing', error: null });
            const src = get().previewUri;
            if (!src) return false;
            prepared = await prepareAvatar({ uri: src, width: pendingSize.w, height: pendingSize.h }, deps.platform.deps);
          }
          set({ phase: 'uploading', error: null });
          uploaded = await uploadPreparedAvatar(uid, prepared, deps.platform.deps);
        }
        set({ phase: 'saving', error: null });
        const r = await deps.save({ avatar_url: uploaded.avatar_url, avatar_thumb_url: uploaded.avatar_thumb_url });
        if (!r.ok) {
          set({ phase: 'error', error: r.message });
          return false;
        }
        prepared = null;
        uploaded = null;
        set({ phase: 'idle', previewUri: null, error: null });
        return true;
      } catch (e) {
        const message = e instanceof AvatarError ? e.message : 'Fotoğraf yüklenemedi. Tekrar dene.';
        set({ phase: 'error', error: message });
        return false;
      }
    }

    const once = (fn: () => Promise<boolean>): Promise<boolean> => {
      if (running) return running;
      running = fn().finally(() => (running = null));
      return running;
    };

    return {
      phase: 'idle',
      previewUri: null,
      error: null,
      denied: null,

      changePhoto: (source) =>
        once(async () => {
          set({ denied: null, error: null });
          const r = await deps.platform.pick(source);
          if (r.kind === 'cancelled') return false;
          if (r.kind === 'denied') {
            set({ denied: { source: r.source, canAskAgain: r.canAskAgain } });
            return false;
          }
          if (r.kind === 'unavailable') {
            set({ phase: 'error', error: UNAVAILABLE_TEXT[r.source] });
            return false;
          }
          prepared = null;
          uploaded = null;
          pendingSize = { w: r.image.width, h: r.image.height };
          set({ previewUri: r.image.uri, phase: 'processing' });
          return runFrom();
        }),

      retryPhoto: () => once(() => (get().previewUri ? runFrom() : Promise.resolve(false))),

      removePhoto: () =>
        once(async () => {
          prepared = null;
          uploaded = null;
          set({ phase: 'saving', previewUri: null, error: null });
          const r = await deps.save({ avatar_url: null, avatar_thumb_url: null });
          set(r.ok ? { phase: 'idle' } : { phase: 'error', error: r.message });
          return r.ok;
        }),

      clearDenied: () => set({ denied: null }),

      reset: () => {
        prepared = null;
        uploaded = null;
        set({ phase: 'idle', previewUri: null, error: null, denied: null });
      },
    };
  });
}

export const profileStore = createProfileStore();

export function useProfileStore<T>(selector: (s: ProfileStoreState) => T): T {
  return useStore(profileStore, selector);
}
