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
