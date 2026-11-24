/**
 * Web demo kimlik adaptörü (Firebase Phone Auth yerine). Her TR cep numarası kabul edilir,
 * SMS kodu her zaman 123456; oturum demo kullanıcısına (Deniz Kaya) açılır ve sayfa yenilense de kalır.
 * Native `authClient.ts` ile aynı dışa aktarımlar ve tipler.
 */
import { demoCurrentUser, demoSendCode, demoSignOut, onDemoAuthChanged } from '../../demo/web/session';
import { ensureFirebase } from './init';

export interface AuthUser {
  uid: string;
  phoneNumber: string | null;
}

export interface PhoneConfirmation {
  confirm(code: string): Promise<unknown>;
}

export function currentAuthUser(): AuthUser | null {
  return demoCurrentUser();
}

export function listenAuthUser(cb: (user: AuthUser | null) => void): () => void {
  return onDemoAuthChanged(cb);
}

export async function startPhoneSignIn(e164: string): Promise<PhoneConfirmation> {
  await ensureFirebase();
  return demoSendCode(e164);
}

export function signOutAuth(): Promise<void> {
  return demoSignOut();
}
