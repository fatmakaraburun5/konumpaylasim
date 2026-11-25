/**
 * Kimlik: Firebase Phone Auth (SMS) → `user_bootstrap` (idempotent profil + davet kodu) → `users/{uid}` dinleyicisi.
 *
 * Durumlar:
 *   initializing  → oturum durumu henüz bilinmiyor (açılış ekranı)
 *   signedOut     → telefon / SMS kodu ekranları
 *   bootstrapping → giriş yapıldı, profil bekleniyor (user_bootstrap)
 *   needsProfile  → profil yok (Faz 6: sunucu `gender_required` döndü) ya da görünen ad boş (ad + cinsiyet ekranı)
 *   ready         → ana uygulama (Faz 6: `profile.gender == null` ise (main) yerleşimi engelleyici GenderGate gösterir)
 *
 * Faz 6: profil OLUŞTURMA artık cinsiyet ister. Girişte ad/cinsiyet olmadan yapılan `user_bootstrap` yeni hesapta
 * `gender_required` ile reddedilir → `needsProfile`; ad ekranı ad + cinsiyetle profili oluşturur. Mevcut hesapta
 * çağrı her zamanki gibi idempotent kalp atışıdır.
 */
import { type Gender, type UserId, type UserProfile } from '@konum/core';
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
  /** Faz 6: ad + cinsiyet (yeni hesapta ikisi de zorunlu). */
  completeProfile: (displayName: string, gender: Gender) => Promise<boolean>;
  /** Faz 6: profil alanlarını günceller (ad, cinsiyet, fotoğraf); verilmeyen alan değişmez. */
  updateProfile: (patch: ProfilePatch) => Promise<{ ok: true } | { ok: false; message: string; code: string }>;
  retryBootstrap: () => Promise<void>;
  signOut: () => Promise<void>;
}

export interface ProfilePatch {
  display_name?: string;
  gender?: Gender;
  /** `null` fotoğrafı kaldırır (küçük boy da). */
  avatar_url?: string | null;
  avatar_thumb_url?: string | null;
}

type SignOutListener = () => void | Promise<void>;
const signOutListeners = new Set<SignOutListener>();

/** Çıkışta (kullanıcı ya da sunucu kaynaklı) çalışacak temizlik: takip durdurma, kalıcı veriyi silme. */
export function onSignedOut(l: SignOutListener): () => void {
  signOutListeners.add(l);
  return () => signOutListeners.delete(l);
}

let profileUnsub: (() => void) | null = null;
/** Faz 6: sunucu profili oluşturmak için cinsiyet istedi; profil dinleyicisinin `null`'u ad ekranını geri almasın. */
let awaitingCreate = false;

type BeforeSignOutListener = () => void | Promise<void>;
const beforeSignOutListeners = new Set<BeforeSignOutListener>();
/** [Varsayım] Çıkış öncesi işlerin (widget token iptali) toplam bekleme sınırı; çevrimdışı çıkışı engellemez. */
const BEFORE_SIGN_OUT_TIMEOUT_MS = 5_000;

/** Faz 6: oturum HÂLÂ açıkken çalışacak çıkış öncesi işler (ör. `widget_token_revoke` kimlik ister). */
export function onBeforeSignOut(l: BeforeSignOutListener): () => void {
  beforeSignOutListeners.add(l);
  return () => beforeSignOutListeners.delete(l);
}

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
  async function bootstrap(fields: ProfilePatch = {}): Promise<{ ok: true } | { ok: false; message: string; code: string }> {
    try {
      const res = await userBootstrap({ time_zone: deviceTimeZone(), ...fields });
      const p = res.profile ?? res.user;
      if (p) applyProfile(p);
      return { ok: true };
    } catch (e) {
      const err = toKonumError(e);
      if (err.code === 'gender_required' && !get().profile) {
        // Yeni hesap: profil ad + cinsiyetle ad ekranında oluşturulur (hata metni gösterilmez).
        awaitingCreate = true;
        if (get().uid) set({ status: 'needsProfile', error: null });
        return { ok: false, message: err.message, code: err.code };
      }
      set({ error: err.message });
      return { ok: false, message: err.message, code: err.code };
    }
  }

  function applyProfile(p: UserProfile | null) {
    if (!get().uid) return;
    if (!p) {
      if (awaitingCreate) return;
      if (get().status !== 'bootstrapping') set({ status: 'bootstrapping' });
      return;
    }
    awaitingCreate = false;
    set({ profile: p, status: p.display_name.trim() ? 'ready' : 'needsProfile', error: null });
  }

  async function handleUser(user: { uid: string; phoneNumber: string | null } | null) {
    profileUnsub?.();
    profileUnsub = null;
    awaitingCreate = false;
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

    completeProfile: async (displayName, gender) => {
      set({ busy: true, error: null });
      const r = await bootstrap({ display_name: displayName.trim(), gender });
      // Yeni hesapta yine gender_required dönerse (ör. eski sunucu) hata metni gösterilsin.
      if (!r.ok && r.code === 'gender_required') set({ error: r.message });
      set({ busy: false });
      return r.ok;
    },

    updateProfile: async (patch) => {
      const fields: ProfilePatch = { ...patch };
      if (fields.display_name !== undefined) fields.display_name = fields.display_name.trim();
      const r = await bootstrap(fields);
      // Profil ekranı hatayı kendi gösterir: genel (ad ekranı) hata alanı kirlenmesin.
      if (!r.ok && get().status === 'ready') set({ error: null });
      return r;
    },

    retryBootstrap: async () => {
      set({ error: null });
      await bootstrap();
    },

    signOut: async () => {
      // Oturum hâlâ açıkken: bu cihazın push token'ı hesaptan kaldırılır (çıkış yapan cihaz bildirim almasın).
      const uid = get().uid;
      if (uid) {
        // Faz 6: widget token'ı iptal (kimlik ister). Zaman aşımı / hata çıkışı engellemez.
        const before = Promise.all([...beforeSignOutListeners].map((l) => Promise.resolve().then(l).catch(() => undefined)));
        await Promise.race([before, new Promise<void>((r) => setTimeout(r, BEFORE_SIGN_OUT_TIMEOUT_MS))]);
        await unregisterPushToken(uid);
      }
      await signOutAuth();
    },
  };
});

export function useAuthStore<T>(selector: (s: AuthState) => T): T {
  return useStore(authStore, selector);
}
