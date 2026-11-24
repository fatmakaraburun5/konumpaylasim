/**
 * Web demo oturumu (Firebase Auth yerine). Firebase gibi oturum cihazda kalıcıdır: sayfa yenilense de
 * giriş açık kalır. Her Türkiye cep numarası kabul edilir, SMS kodu her zaman `DEMO_OTP` (123456),
 * oturum her zaman demo kullanıcısına (Deniz Kaya) açılır.
 */
import { ALLOWED_SMS_RE } from '@konum/core';
import { DEMO_ME, DEMO_OTP } from '../server/world';
import { safeStorage } from '../server/storage';

export const DEMO_AUTH_KEY = 'konum.demo.auth.v1';

export interface DemoAuthUser {
  uid: string;
  phoneNumber: string | null;
}

type Listener = (u: DemoAuthUser | null) => void;
const listeners = new Set<Listener>();

function load(): DemoAuthUser | null {
  const raw = safeStorage.get(DEMO_AUTH_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DemoAuthUser>;
    return typeof v.uid === 'string' && v.uid ? { uid: v.uid, phoneNumber: typeof v.phoneNumber === 'string' ? v.phoneNumber : null } : null;
  } catch {
    return null;
  }
}

let current: DemoAuthUser | null = load();

function setCurrent(next: DemoAuthUser | null): void {
  current = next;
  if (next) safeStorage.set(DEMO_AUTH_KEY, JSON.stringify(next));
  else safeStorage.remove(DEMO_AUTH_KEY);
  for (const l of [...listeners]) l(next ? { ...next } : null);
}

export function demoCurrentUser(): DemoAuthUser | null {
  return current ? { ...current } : null;
}

export function demoCurrentUid(): string | null {
  return current?.uid ?? null;
}

/** Firebase `onAuthStateChanged` gibi: kayıttan hemen sonra (eşzamansız) mevcut durum bildirilir. */
export function onDemoAuthChanged(l: Listener): () => void {
  listeners.add(l);
  let live = true;
  const t = setTimeout(() => {
    if (live) l(demoCurrentUser());
  }, 0);
  return () => {
    live = false;
    clearTimeout(t);
    listeners.delete(l);
  };
}

const delay = (lo: number, hi: number) => new Promise<void>((r) => setTimeout(r, lo + Math.random() * (hi - lo)));

/** Firebase Auth hata biçimi (`auth/...`): authStore aynı Türkçe metinleri gösterir. */
class DemoAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DemoAuthError';
  }
}

export async function demoSendCode(e164: string): Promise<{ confirm(code: string): Promise<unknown> }> {
  await delay(450, 800); // "SMS gönderiliyor"
  if (!ALLOWED_SMS_RE.test(e164)) throw new DemoAuthError('auth/invalid-phone-number');
  return {
    confirm: async (code: string) => {
      await delay(300, 600);
      if (code.trim() !== DEMO_OTP) throw new DemoAuthError('auth/invalid-verification-code');
      setCurrent({ uid: DEMO_ME, phoneNumber: e164 });
      return { user: demoCurrentUser() };
    },
  };
}

export async function demoSignOut(): Promise<void> {
  await delay(80, 160);
  setCurrent(null);
}
