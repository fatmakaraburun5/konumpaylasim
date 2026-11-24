/**
 * Kimlik: Firebase Phone Auth (SMS) → `user_bootstrap` (idempotent profil + davet kodu) → `users/{uid}` dinleyicisi.
 *
 * Durumlar:
 *   initializing  → oturum durumu henüz bilinmiyor (açılış ekranı)
 *   signedOut     → telefon / SMS kodu ekranları
 *   bootstrapping → giriş yapıldı, profil bekleniyor (user_bootstrap)
 *   needsProfile  → profil var ama görünen ad boş (ad ekranı)
 *   ready         → ana uygulama
 */
import { type UserId, type UserProfile } from '@konum/core';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { toKonumError } from '../lib/errors';
import { deviceTimeZone } from '../lib/timeZone';
import { listenAuthUser, signOutAuth, startPhoneSignIn, type PhoneConfirmation } from '../services/firebase/authClient';
import { userBootstrap } from '../services/firebase/callables';
import { ensureFirebase } from '../services/firebase/init';
import { listenProfile } from '../services/firebase/profileRepo';
import { unregisterPushToken } from '../services/notifications/push';

export type AuthStatus = 'initializing' | 'signedOut' | 'bootstrapping' | 'needsProfile' | 'ready';

interface AuthState {
  status: AuthStatus;
  uid: UserId | null;
  phoneE164: string | null;
  profile: UserProfile | null;
  /** SMS doğrulama oturumu (bellekte; kalıcılaştırılmaz). */
  confirmation: PhoneConfirmation | null;
  pendingPhone: string | null;
  busy: boolean;
  error: string | null;
  init: () => () => void;
  sendCode: (e164: string) => Promise<boolean>;
  confirmCode: (code: string) => Promise<boolean>;
  completeProfile: (displayName: string) => Promise<boolean>;
  retryBootstrap: () => Promise<void>;
  signOut: () => Promise<void>;
}

type SignOutListener = () => void | Promise<void>;
const signOutListeners = new Set<SignOutListener>();

/** Çıkışta (kullanıcı ya da sunucu kaynaklı) çalışacak temizlik: takip durdurma, kalıcı veriyi silme. */
export function onSignedOut(l: SignOutListener): () => void {
  signOutListeners.add(l);
  return () => signOutListeners.delete(l);
}

let profileUnsub: (() => void) | null = null;

const authErrorText = (e: unknown): string => {
  const code = (e as { code?: string })?.code ?? '';
  if (code.includes('invalid-verification-code')) return 'Kod hatalı. Lütfen tekrar deneyin.';
  if (code.includes('session-expired') || code.includes('code-expired')) return 'Kodun süresi doldu. Yeni kod isteyin.';
  if (code.includes('too-many-requests') || code.includes('quota-exceeded')) return 'Çok fazla deneme yapıldı. Biraz sonra tekrar deneyin.';
  if (code.includes('invalid-phone-number')) return 'Telefon numarası geçersiz.';
  if (code.includes('network')) return 'Bağlantı yok. İnternetini kontrol et.';
  return 'Bir şeyler ters gitti. Tekrar deneyin.';
};

export const authStore = createStore<AuthState>()((set, get) => {
  async function bootstrap(displayName?: string): Promise<boolean> {
    try {
      const res = await userBootstrap({ time_zone: deviceTimeZone(), ...(displayName ? { display_name: displayName } : {}) });
      if (res.profile) applyProfile(res.profile);
      return true;
    } catch (e) {
      set({ error: toKonumError(e).message });
      return false;
    }
  }

  function applyProfile(p: UserProfile | null) {
    if (!get().uid) return;
    if (!p) {
      if (get().status !== 'bootstrapping') set({ status: 'bootstrapping' });
      return;
    }
    set({ profile: p, status: p.display_name.trim() ? 'ready' : 'needsProfile', error: null });
  }

  async function handleUser(user: { uid: string; phoneNumber: string | null } | null) {
    profileUnsub?.();
    profileUnsub = null;
    if (!user) {
      const wasSignedIn = get().uid !== null;
      set({ status: 'signedOut', uid: null, phoneE164: null, profile: null, busy: false });
      if (wasSignedIn) for (const l of signOutListeners) await Promise.resolve(l()).catch(() => undefined);
      return;
    }
    set({ uid: user.uid, phoneE164: user.phoneNumber, status: 'bootstrapping', confirmation: null, pendingPhone: null });
    profileUnsub = listenProfile(user.uid, applyProfile, () => undefined);
    void bootstrap();
  }

  return {
    status: 'initializing',
    uid: null,
    phoneE164: null,
    profile: null,
    confirmation: null,
    pendingPhone: null,
    busy: false,
    error: null,

    init: () => {
      let unsub: (() => void) | null = null;
      let cancelled = false;
      void ensureFirebase().then(() => {
        if (cancelled) return;
        unsub = listenAuthUser((u) => void handleUser(u));
      });
      return () => {
        cancelled = true;
        unsub?.();
        profileUnsub?.();
      };
    },

    sendCode: async (e164) => {
      set({ busy: true, error: null });
      try {
        const confirmation = await startPhoneSignIn(e164);
        set({ confirmation, pendingPhone: e164, busy: false });
        return true;
      } catch (e) {
        set({ busy: false, error: authErrorText(e) });
        return false;
      }
    },

    confirmCode: async (code) => {
      const c = get().confirmation;
      if (!c) {
        set({ error: 'Doğrulama oturumu bulunamadı. Yeni kod isteyin.' });
        return false;
      }
      set({ busy: true, error: null });
      try {
        await c.confirm(code);
        // onAuthStateChanged durumu ilerletir.
        set({ busy: false });
        return true;
      } catch (e) {
        set({ busy: false, error: authErrorText(e) });
        return false;
      }
    },

    completeProfile: async (displayName) => {
      set({ busy: true, error: null });
      const ok = await bootstrap(displayName.trim());
      set({ busy: false });
      return ok;
    },

    retryBootstrap: async () => {
      set({ error: null });
      await bootstrap();
    },

    signOut: async () => {
      // Oturum hâlâ açıkken: bu cihazın push token'ı hesaptan kaldırılır (çıkış yapan cihaz bildirim almasın).
      const uid = get().uid;
      if (uid) await unregisterPushToken(uid);
      await signOutAuth();
    },
  };
});

export function useAuthStore<T>(selector: (s: AuthState) => T): T {
  return useStore(authStore, selector);
}
