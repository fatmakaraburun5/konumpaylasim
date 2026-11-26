/**
 * Kimlik: Firebase Phone Auth (SMS) → `user_bootstrap` (idempotent profil + davet kodu) → `users/{uid}` dinleyicisi.
 *
 * Durumlar:
 *   initializing  → oturum durumu henüz bilinmiyor (açılış ekranı)
 *   signedOut     → telefon / SMS kodu ekranları
 *   bootstrapping → giriş yapıldı, profil bekleniyor (user_bootstrap)
 *   needsProfile  → profil yok (Faz 6: sunucu `gender_required` döndü) ya da görünen ad boş (ad + cinsiyet ekranı)
 *   needsSecondFactor → Faz 10: yeni telefon; kurtarma e-postasına giden 6 haneli kod bekleniyor (SMS 1. aşamaydı)
 *   ready         → ana uygulama (Faz 6: `profile.gender == null` ise (main) yerleşimi engelleyici GenderGate gösterir)
 *
 * Faz 8: `profile.consent` güncel sürüm değilse (`selectNeedsConsent`) (main) yerleşimi onay kapısını gösterir ve
 * oturum servislerini başlatmaz; `patchProfileLocal` callable yanıtını dinleyici yetişmeden profile işler.
 *
 * Faz 6: profil OLUŞTURMA artık cinsiyet ister. Girişte ad/cinsiyet olmadan yapılan `user_bootstrap` yeni hesapta
 * `gender_required` ile reddedilir → `needsProfile`; ad ekranı ad + cinsiyetle profili oluşturur. Mevcut hesapta
 * çağrı her zamanki gibi idempotent kalp atışıdır.
 */
import { clientConsentRequired, type ChallengeView, type Gender, type UserId, type UserProfile } from '@konum/core';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { toKonumError } from '../lib/errors';
import { deviceTimeZone } from '../lib/timeZone';
import { listenAuthUser, signInWithCustomToken, signOutAuth, startPhoneSignIn, type PhoneConfirmation } from '../services/firebase/authClient';
import { deviceSecondFactorSend, deviceSecondFactorVerify, userBootstrap } from '../services/firebase/callables';
import { ensureDeviceSession } from '../services/security/deviceSession';
import { ensureFirebase } from '../services/firebase/init';
import { listenProfile } from '../services/firebase/profileRepo';
import { unregisterPushToken } from '../services/notifications/push';

export type AuthStatus = 'initializing' | 'signedOut' | 'bootstrapping' | 'needsSecondFactor' | 'needsProfile' | 'ready';

/** Faz 10: yeni cihazın bekleyen ikinci aşaması (e-posta kodu). */
export interface SecondFactorState {
  dsid: string;
  model: string;
  challenge: ChallengeView;
}

export interface AuthState {
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
  /** Faz 10: yeni cihaz ikinci aşaması. */
  secondFactor: SecondFactorState | null;
  /** Faz 10: hesap bu telefona taşındı (ikinci aşamadan sonra Aktif Cihazlar ekranı bir kez açılır). */
  migratedPending: boolean;
  verifySecondFactor: (code: string) => Promise<boolean>;
  resendSecondFactor: () => Promise<boolean>;
  clearMigrated: () => void;
  /** Faz 10: `device_registration_required` sonrası yeniden kayıt (ör. çevrimdışı girişten sonra). */
  reRegisterDevice: () => Promise<void>;
  /** Faz 8: callable yanıtını (görünmez / onay) dinleyici yetişmeden profile işler; sonraki anlık görüntü doğrudur. */
  patchProfileLocal: (patch: Partial<Pick<UserProfile, 'invisible' | 'consent' | 'privacy'>>) => void;
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
/** Faz 10: cihaz oturumu akışı bu uid için başladı (aynı uid'in yeniden bildirimi yok sayılır). */
let deviceFlowUid: string | null = null;
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
    // Faz 10: aynı hesap yeniden bildirildi (custom token ile oturum el değiştirdi): akış zaten sürüyor.
    if (user && user.uid === deviceFlowUid && get().uid === user.uid && get().status !== 'signedOut') return;
    if (!user) deviceFlowUid = null;
    profileUnsub?.();
    profileUnsub = null;
    awaitingCreate = false;
    if (!user) {
      const wasSignedIn = get().uid !== null;
      set({ status: 'signedOut', uid: null, phoneE164: null, profile: null, busy: false });
      if (wasSignedIn) for (const l of signOutListeners) await Promise.resolve(l()).catch(() => undefined);
      return;
    }
    set({ uid: user.uid, phoneE164: user.phoneNumber, status: 'bootstrapping', confirmation: null, pendingPhone: null, secondFactor: null });
    // Faz 10: cihaz oturumu (custom token el değiştirmesi aynı uid'i yeniden bildirir: `deviceFlowUid` tekrarı keser).
    deviceFlowUid = user.uid;
    const dev = await ensureDeviceSession();
    if (get().uid !== user.uid) return;
    if (dev.kind === 'revoked') {
      await signOutAuth().catch(() => undefined);
      return;
    }
    if (dev.kind === 'second_factor') {
      set({ status: 'needsSecondFactor', secondFactor: { dsid: dev.dsid, model: dev.model, challenge: dev.challenge } });
      return;
    }
    startProfile(user.uid);
  }

  function startProfile(uid: UserId) {
    profileUnsub?.();
    profileUnsub = listenProfile(uid, applyProfile, () => undefined);
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

    secondFactor: null,
    migratedPending: false,

    verifySecondFactor: async (code) => {
      const sf = get().secondFactor;
      const uid = get().uid;
      if (!sf || !uid) return false;
      set({ busy: true, error: null });
      try {
        const r = await deviceSecondFactorVerify({ dsid: sf.dsid, challenge_id: sf.challenge.challenge_id, code: code.trim() });
        await signInWithCustomToken(r.custom_token);
        if (get().uid !== uid) return false;
        set({ busy: false, secondFactor: null, status: 'bootstrapping', migratedPending: r.migrated });
        startProfile(uid);
        return true;
      } catch (e) {
        const err = toKonumError(e);
        set({ busy: false, error: err.message });
        return false;
      }
    },

    resendSecondFactor: async () => {
      const sf = get().secondFactor;
      if (!sf) return false;
      set({ busy: true, error: null });
      try {
        const r = await deviceSecondFactorSend({ dsid: sf.dsid });
        set({ busy: false, secondFactor: { ...sf, challenge: r.challenge } });
        return true;
      } catch (e) {
        set({ busy: false, error: toKonumError(e).message });
        return false;
      }
    },

    clearMigrated: () => set({ migratedPending: false }),

    reRegisterDevice: async () => {
      const uid = get().uid;
      if (!uid || get().status !== 'ready') return;
      const dev = await ensureDeviceSession();
      if (get().uid !== uid) return;
      if (dev.kind === 'revoked') await signOutAuth().catch(() => undefined);
      else if (dev.kind === 'second_factor') set({ status: 'needsSecondFactor', secondFactor: { dsid: dev.dsid, model: dev.model, challenge: dev.challenge } });
    },

    patchProfileLocal: (patch) => {
      const p = get().profile;
      if (!p || !get().uid) return;
      set({ profile: { ...p, ...patch } });
    },
  };
});

/** Faz 8: güncel Güvenlik Sözleşmesi / KVKK onayı yok → onay kapısı (oturum servisleri başlamaz). */
export function selectNeedsConsent(s: Pick<AuthState, 'status' | 'profile'>): boolean {
  return s.status === 'ready' && !!s.profile && clientConsentRequired(s.profile.consent);
}

export function useNeedsConsent(): boolean {
  return useStore(authStore, selectNeedsConsent);
}

export function useAuthStore<T>(selector: (s: AuthState) => T): T {
  return useStore(authStore, selector);
}
