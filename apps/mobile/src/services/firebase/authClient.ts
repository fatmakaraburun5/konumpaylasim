/**
 * Kimlik doğrulama adaptörü (Firebase Phone Auth).
 *
 * authStore ve konum hattı Firebase Auth'a doğrudan değil bu dar arayüz üzerinden erişir; web demo
 * derlemesi aynı adla `authClient.web.ts` sağlar (bellek içi sahte oturum). Native davranış birebir
 * önceki doğrudan çağrılarla aynıdır.
 */
import {
  getAuth,
  onAuthStateChanged,
  getIdTokenResult,
  signInWithCustomToken as fbSignInWithCustomToken,
  signInWithPhoneNumber,
  signOut as fbSignOut,
} from '@react-native-firebase/auth';
import { ensureFirebase } from './init';

export interface AuthUser {
  uid: string;
  phoneNumber: string | null;
}

/** SMS doğrulama oturumu: kod onaylanınca oturum açılır (sonuç `onAuthUserChanged` ile gelir). */
export interface PhoneConfirmation {
  confirm(code: string): Promise<unknown>;
}

/** Mevcut kullanıcı (eşzamanlı). Çağırmadan önce `ensureFirebase()` tamamlanmış olmalı. */
export function currentAuthUser(): AuthUser | null {
  const u = getAuth().currentUser;
  return u ? { uid: u.uid, phoneNumber: u.phoneNumber } : null;
}

/**
 * Oturum değişikliklerini dinler (Firebase davranışı: kayıtta mevcut durum hemen bildirilir).
 * Çağırmadan önce `ensureFirebase()` tamamlanmış olmalı. Dönen fonksiyon aboneliği kapatır.
 */
export function listenAuthUser(cb: (user: AuthUser | null) => void): () => void {
  return onAuthStateChanged(getAuth(), (u) => cb(u ? { uid: u.uid, phoneNumber: u.phoneNumber } : null));
}

export async function startPhoneSignIn(e164: string): Promise<PhoneConfirmation> {
  await ensureFirebase();
  // [Varsayım: doğrulanmalı] Android'de Play Integrity, iOS'ta sessiz APNs; olmazsa reCAPTCHA yedeği.
  return signInWithPhoneNumber(getAuth(), e164);
}

export function signOutAuth(): Promise<void> {
  return fbSignOut(getAuth());
}

/** Faz 10: `device_register` / ikinci aşamanın custom token'ı (`dsid` iddialı). Aynı uid: oturum el değiştirir. */
export async function signInWithCustomToken(token: string): Promise<void> {
  await ensureFirebase();
  await fbSignInWithCustomToken(getAuth(), token);
}

/** Faz 10: mevcut ID token'ın cihaz oturumu (`dsid` iddiası). Telefonla yeni girişte null. */
export async function currentDsid(): Promise<string | null> {
  const u = getAuth().currentUser;
  if (!u) return null;
  try {
    const r = await getIdTokenResult(u);
    const v = (r.claims as Record<string, unknown>).dsid;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}
