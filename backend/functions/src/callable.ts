/**
 * Callable sarmalayıcısı: kimlik kontrolü → zod doğrulaması → Faz 8 onay ön kapısı → işleyici → hata eşleme.
 * İşleyiciler (handlers/*) saf `(ctx, data)` fonksiyonlarıdır; testler onları doğrudan da çağırabilir.
 */
import { DEVICE_GATE_EXEMPT, DSID_RE, type EpochMs, PATHS, type UserId, consentExemptCall, revokedDeviceKey } from '@konum/core';
import { onCall, type CallableRequest } from 'firebase-functions/https';
import type { SecretParam } from 'firebase-functions/params';
import type { z } from 'zod';
import { CALLABLE_SECRETS, ENFORCE_APP_CHECK, MAX_INSTANCES, REGION } from './config';
import { db } from './admin';
import { type UserDoc, isUsableProfile, refs } from './docs';
import { fail, toHttpsError } from './errors';
import { assertConsent, needsProfile } from './graph';
import { isServerUid } from './util';

export interface CallCtx {
  uid: UserId;
  /** Kimlik belirtecindeki telefon (yalnızca telefonla girişte). */
  phone_e164: string | null;
  /** Sunucu saati: tek istek boyunca sabit (`Date.now()`). */
  now: EpochMs;
  /** Belirtecin `auth_time` değeri (epoch ms): son SMS doğrulaması. Doğrudan çağrılan testlerde yok. */
  auth_time?: EpochMs | null;
  /** Faz 10: cihaz oturumu (custom token iddiası `dsid`); telefonla yeni girişte / eski belirteçte null. */
  dsid?: string | null;
}

/** Kimliksiz çağrıyı reddeder. Sunucu uid biçimine (`_` yok) uymayan kimlikler de reddedilir. */
export function requireAuth(req: Pick<CallableRequest<unknown>, 'auth'>, now: EpochMs = Date.now()): CallCtx {
  const auth = req.auth;
  if (!auth?.uid) throw fail('unauthenticated');
  if (!isServerUid(auth.uid)) throw fail('unauthenticated', { message: 'Desteklenmeyen hesap kimliği' });
  const phone = auth.token?.phone_number;
  const authTime = auth.token?.auth_time;
  const dsid = (auth.token as Record<string, unknown> | undefined)?.dsid;
  return {
    uid: auth.uid,
    phone_e164: typeof phone === 'string' ? phone : null,
    now,
    auth_time: typeof authTime === 'number' ? authTime * 1000 : null,
    dsid: typeof dsid === 'string' && DSID_RE.test(dsid) ? dsid : null,
  };
}

/** Girdiyi şemayla doğrular; hata ayrıntısı alan yollarını taşır (değerleri değil). */
export function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw ?? {});
  if (r.success) return r.data;
  const issues = r.error.issues.slice(0, 10).map((i) => ({
    path: i.path.map((p) => String(p)).join('.'),
    message: i.message,
  }));
  throw fail('invalid_argument', { extra: { issues } });
}

/**
 * Faz 8 onay ön kapısı (KVKK): güncel `CONSENT_VERSION` onaylanmadan veri işleyen callable `consent_required` döner.
 * Koruyucu işlemler (core `consentExemptCall`: durdurma / geri alma / engelleme / silme / görünmez olma / onay) ve
 * `user_bootstrap` muaftır. Profil yoksa ya da hesap siliniyorsa `needsProfile` (failed-precondition).
 * Transaction DIŞI tek okuma; paylaşım / izin açan işleyiciler aynı denetimi transaction içinde `readCaller` ile yineler.
 */
export async function consentGate(name: string, ctx: Pick<CallCtx, 'uid'>, data: unknown): Promise<void> {
  if (consentExemptCall(name, data)) return;
  const u = (await refs.user(ctx.uid).get()).data() as UserDoc | undefined;
  if (!isUsableProfile(u)) throw needsProfile();
  assertConsent(u);
}

/**
 * Faz 10 cihaz kapısı: iptal edilen cihazın (`revoked_devices/{uid}_{dsid}`) ya da ilk cihaz kaydından sonra
 * `dsid`'siz belirtecin (`{uid}_legacy`) çağrısı reddedilir. Yeni cihazın kayıt / ikinci aşama çağrıları muaftır.
 * Tek nokta okuma; önbellek YOK (iptal anında geçerli olmalı).
 */
export async function deviceGate(name: string, ctx: Pick<CallCtx, 'uid' | 'dsid'>): Promise<void> {
  if ((DEVICE_GATE_EXEMPT as readonly string[]).includes(name)) return;
  const snap = await db().doc(PATHS.revokedDevice(revokedDeviceKey(ctx.uid, ctx.dsid))).get();
  if (snap.exists) throw fail(ctx.dsid ? 'session_revoked' : 'device_registration_required');
}

export type Handler<I, R> = (ctx: CallCtx, data: I) => Promise<R>;

export interface CallableOptions {
  /** Ek secret'lar (ör. Faz 2 Maps anahtarı). Emülatörde boş verilir (Secret Manager'a gidilmez). */
  secrets?: readonly (string | SecretParam)[];
}

export function callable<S extends z.ZodType, R>(name: string, schema: S, handler: Handler<z.output<S>, R>, opts: CallableOptions = {}) {
  return onCall(
    {
      region: REGION,
      enforceAppCheck: ENFORCE_APP_CHECK,
      maxInstances: MAX_INSTANCES,
      secrets: [...CALLABLE_SECRETS, ...(opts.secrets ?? [])],
    },
    async (req: CallableRequest<unknown>): Promise<R> => {
      try {
        const ctx = requireAuth(req);
        const data = parseInput(schema, req.data);
        await deviceGate(name, ctx);
        await consentGate(name, ctx, data);
        return await handler(ctx, data);
      } catch (err) {
        throw toHttpsError(err, name);
      }
    },
  );
}

/**
 * Faz 6: OTURUMSUZ ve App Check'siz callable (yalnızca `widget_quick_share`). Widget uzantısı / AppWidget alıcısı
 * Firebase Auth ve App Check'e erişemez; yetki istekteki widget token'ıdır ve işleyici onu doğrular. Gövde
 * protokolü aynıdır (`POST {data}` → `{result}` | `{error}`), hata eşlemesi aynıdır. İstekte `Authorization`
 * başlığı olsa bile kimlik KULLANILMAZ (token sahibinin uid'i esas). Secret bildirilmez (telefon biberi gerekmez).
 */
export function tokenCallable<S extends z.ZodType, R>(name: string, schema: S, handler: (data: z.output<S>) => Promise<R>) {
  return onCall(
    { region: REGION, enforceAppCheck: false, maxInstances: MAX_INSTANCES },
    async (req: CallableRequest<unknown>): Promise<R> => {
      try {
        const data = parseInput(schema, req.data);
        return await handler(data);
      } catch (err) {
        throw toHttpsError(err, name);
      }
    },
  );
}
