/**
 * Callable sarmalayıcısı: kimlik kontrolü → zod doğrulaması → işleyici → hata eşleme.
 * İşleyiciler (handlers/*) saf `(ctx, data)` fonksiyonlarıdır; testler onları doğrudan da çağırabilir.
 */
import type { EpochMs, UserId } from '@konum/core';
import { onCall, type CallableRequest } from 'firebase-functions/https';
import type { SecretParam } from 'firebase-functions/params';
import type { z } from 'zod';
import { CALLABLE_SECRETS, ENFORCE_APP_CHECK, MAX_INSTANCES, REGION } from './config';
import { fail, toHttpsError } from './errors';
import { isServerUid } from './util';

export interface CallCtx {
  uid: UserId;
  /** Kimlik belirtecindeki telefon (yalnızca telefonla girişte). */
  phone_e164: string | null;
  /** Sunucu saati: tek istek boyunca sabit (`Date.now()`). */
  now: EpochMs;
  /** Belirtecin `auth_time` değeri (epoch ms): son SMS doğrulaması. Doğrudan çağrılan testlerde yok. */
  auth_time?: EpochMs | null;
}

/** Kimliksiz çağrıyı reddeder. Sunucu uid biçimine (`_` yok) uymayan kimlikler de reddedilir. */
export function requireAuth(req: Pick<CallableRequest<unknown>, 'auth'>, now: EpochMs = Date.now()): CallCtx {
  const auth = req.auth;
  if (!auth?.uid) throw fail('unauthenticated');
  if (!isServerUid(auth.uid)) throw fail('unauthenticated', { message: 'Desteklenmeyen hesap kimliği' });
  const phone = auth.token?.phone_number;
  const authTime = auth.token?.auth_time;
  return {
    uid: auth.uid,
    phone_e164: typeof phone === 'string' ? phone : null,
    now,
    auth_time: typeof authTime === 'number' ? authTime * 1000 : null,
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
