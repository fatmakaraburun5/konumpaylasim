/**
 * Faz 7: İzin & Gizlilik Merkezi'nin hesap tercihleri (core `privacy.ts`): pil paylaşımı (varsayılan KAPALI) ve
 * "yola çıktı" uyarıları (varsayılan açık). Kaynak: profil (`users/{ben}.privacy`), komut: `privacy_settings_set`.
 *
 * Pil paylaşımını KAPATIRKEN cihazdaki başsız kopya (`persist.savePrivacy`) sunucu yanıtı BEKLENMEDEN kapatılır:
 * konum hattı bir sonraki pakette pil alanlarını göndermez. AÇARKEN kopya ancak sunucu onayladıktan sonra açılır
 * (RTDB kuralı aynayı görmeden gelen pil alanlarını reddederdi).
 */
import { parsePrivacy, type PrivacySettings, type SharingError } from '@konum/core';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { toKonumError } from '../lib/errors';
import { privacyApi, type PrivacyApi } from '../services/firebase/callables';
import { savePrivacy } from './persist';
import { authStore, type AuthState } from './authStore';

export type PrivacyPatch = Partial<Pick<PrivacySettings, 'battery_share' | 'movement_alerts'>>;

export interface PrivacyState {
  /** Gönderilmekte olan değişiklik (anahtar hemen yeni değeri gösterir). */
  pending: PrivacyPatch;
  error: SharingError | null;
  set(patch: PrivacyPatch): Promise<{ ok: true } | { ok: false; error: SharingError }>;
  clearError(): void;
  reset(): void;
}

export const selectPrivacy = (s: Pick<AuthState, 'profile'>): PrivacySettings => parsePrivacy(s.profile?.privacy);

export interface PrivacyStoreDeps {
  api: PrivacyApi;
  auth: Pick<StoreApi<AuthState>, 'getState'>;
  persist: typeof savePrivacy;
}

export function createPrivacyStore(deps: PrivacyStoreDeps = { api: privacyApi, auth: authStore, persist: savePrivacy }): StoreApi<PrivacyState> {
  return createStore<PrivacyState>()((set, get) => ({
    pending: {},
    error: null,

    set: async (patch) => {
      const auth = deps.auth.getState();
      const uid = auth.uid;
      if (!uid) return { ok: false, error: { code: 'unauthenticated', message: 'Oturum açık değil' } };
      const cur = selectPrivacy(auth);
      set({ pending: { ...get().pending, ...patch }, error: null });
      // Kapatma: istemci hemen bırakır.
      if (patch.battery_share === false) await deps.persist({ uid, battery_share: false, movement_alerts: patch.movement_alerts ?? cur.movement_alerts });
      try {
        const res = await deps.api.privacySettingsSet(patch);
        deps.auth.getState().patchProfileLocal({ privacy: res.privacy });
        await deps.persist({ uid, battery_share: res.privacy.battery_share, movement_alerts: res.privacy.movement_alerts });
        set((s) => {
          const pending = { ...s.pending };
          for (const k of Object.keys(patch) as (keyof PrivacyPatch)[]) if (pending[k] === patch[k]) delete pending[k];
          return { pending };
        });
        return { ok: true };
      } catch (e) {
        const error = toKonumError(e).toSharingError();
        set((s) => {
          const pending = { ...s.pending };
          for (const k of Object.keys(patch) as (keyof PrivacyPatch)[]) delete pending[k];
          return { pending, error };
        });
        return { ok: false, error };
      }
    },

    clearError: () => set({ error: null }),
    reset: () => set({ pending: {}, error: null }),
  }));
}

export const privacyStore = createPrivacyStore();

export function usePrivacyStore<T>(selector: (s: PrivacyState) => T): T {
  return useStore(privacyStore, selector);
}

/** Ekranda gösterilecek değer: gönderilen değişiklik varsa o, yoksa profil. */
export function effectivePrivacy(profile: PrivacySettings, pending: PrivacyPatch): PrivacySettings {
  return { ...profile, ...pending };
}
