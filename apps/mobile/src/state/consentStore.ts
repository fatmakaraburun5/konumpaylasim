/**
 * Faz 8: Güvenlik Sözleşmesi / KVKK onayı. Kapı kararı profilden: `selectNeedsConsent` (authStore; core
 * `consentRequired`). Onay kapısı açıkken oturum servisleri başlamaz ve `publishHold` yayını keser.
 *
 *  - `accept(platform?, appVersion?)`: `consent_accept` güncel sürüm (`CONSENT_VERSION`) + metin özeti
 *    (`CONSENT_TEXT_SHA256`) + `scrolled_to_bottom: true` ile. Düğme yalnızca metin sonuna kadar kaydırılınca
 *    açılır (core `isScrolledToBottom`, arayüz). Başarılı olunca profil yerelde hemen güncellenir.
 *    Sunucu `consent_required` ile daha yeni bir güncel sürüm bildirirse (`details.current_version`) eski metin
 *    onaylanamaz: "uygulamayı güncelle" denir.
 *  - `withdraw()`: `consent_withdraw` → sunucu giden paylaşımları ve bağlantıları bitirir, süren SOS'u kapatır, yer
 *    notlarını siler, önerdiğim buluşmaları iptal eder; kapı yeniden açılır.
 */
import {
  CONSENT_TEXT_SHA256,
  CONSENT_UI_TEXT,
  CONSENT_VERSION,
  uuidV4,
  type ConsentPlatform,
  type ProfileConsent,
} from '@konum/core';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { toKonumError } from '../lib/errors';
import { consentApi, type ConsentApi } from '../services/firebase/callables';
import { authStore } from './authStore';

export type ConsentWithdrawResult =
  | { ok: true; sharesEnded: number; linksEnded: number }
  | { ok: false; code: string; message: string };

export interface ConsentStoreDeps {
  api: ConsentApi;
  newOpId: () => string;
  platform: () => ConsentPlatform;
  appVersion: () => string;
  patchProfile: (consent: ProfileConsent | null) => void;
}

export interface ConsentStoreState {
  busy: boolean;
  error: string | null;
  accept: (platform?: ConsentPlatform, appVersion?: string) => Promise<boolean>;
  withdraw: () => Promise<ConsentWithdrawResult>;
  reset: () => void;
}

function defaultPlatform(): ConsentPlatform {
  return Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
}

function defaultAppVersion(): string {
  try {
    const v = Constants.expoConfig?.version;
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 32);
  } catch {
    // yapılandırma okunamadı
  }
  return '0.1.0';
}

export function createConsentStore(overrides: Partial<ConsentStoreDeps> = {}): StoreApi<ConsentStoreState> {
  const deps: ConsentStoreDeps = {
    api: consentApi,
    newOpId: uuidV4,
    platform: defaultPlatform,
    appVersion: defaultAppVersion,
    patchProfile: (consent) => authStore.getState().patchProfileLocal({ consent }),
    ...overrides,
  };
  let inflight: Promise<unknown> | null = null;

  return createStore<ConsentStoreState>()((set) => ({
    busy: false,
    error: null,

    accept: (platform, appVersion) => {
      if (inflight) return inflight as Promise<boolean>;
      const p = (async () => {
        set({ busy: true, error: null });
        try {
          const res = await deps.api.consentAccept({
            op_id: deps.newOpId(),
            version: CONSENT_VERSION,
            text_sha256: CONSENT_TEXT_SHA256,
            scrolled_to_bottom: true,
            platform: platform ?? deps.platform(),
            app_version: appVersion ?? deps.appVersion(),
          });
          deps.patchProfile(res.consent);
          set({ busy: false });
          return true;
        } catch (e) {
          const err = toKonumError(e);
          // Sunucunun güncel sürümü bu uygulamanınkinden yeni: eski metin hiçbir zaman onaylanamaz.
          const current = err.code === 'consent_required' ? err.extra.current_version : undefined;
          set({ busy: false, error: typeof current === 'string' && current > CONSENT_VERSION ? CONSENT_UI_TEXT.updateAppToAccept : err.message });
          return false;
        }
      })().finally(() => {
        inflight = null;
      });
      inflight = p;
      return p;
    },

    withdraw: () => {
      if (inflight) return inflight as Promise<ConsentWithdrawResult>;
      const p = (async (): Promise<ConsentWithdrawResult> => {
        set({ busy: true, error: null });
        try {
          const res = await deps.api.consentWithdraw({ op_id: deps.newOpId() });
          deps.patchProfile(null);
          set({ busy: false });
          return { ok: true, sharesEnded: res.shares_ended, linksEnded: res.links_ended };
        } catch (e) {
          const err = toKonumError(e);
          set({ busy: false, error: err.message });
          return { ok: false, code: err.code, message: err.message };
        }
      })().finally(() => {
        inflight = null;
      });
      inflight = p;
      return p;
    },

    reset: () => {
      inflight = null;
      set({ busy: false, error: null });
    },
  }));
}

export const consentStore = createConsentStore();

export function useConsentStore<T>(selector: (s: ConsentStoreState) => T): T {
  return useStore(consentStore, selector);
}

export { selectNeedsConsent, useNeedsConsent } from './authStore';
