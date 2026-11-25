/**
 * Emülatör yardımcıları: kural test ortamı, istemci (kullanıcı kimliğiyle) RTDB/Firestore,
 * Auth emülatöründe telefonla giriş ve callable çağrısı.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { type RulesTestEnvironment, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  CONSENT_TEXT_SHA256,
  CONSENT_VERSION,
  type CallableName,
  type DeviceStatus,
  type EpochMs,
  type NormalizedSample,
  type ShareMode,
  buildPackets,
  shareId,
  toFanoutUpdate,
} from '@konum/core';
import { DB_HOST, FUNCTIONS_URL, HOST, PROJECT_ID, RTDB_NS, RTDB_URL } from './env';

const root = new URL('../../', import.meta.url);
export const FIRESTORE_RULES = readFileSync(new URL('firestore.rules', root), 'utf8');
export const DATABASE_RULES = readFileSync(new URL('database.rules.json', root), 'utf8');
/** Faz 6: Storage kuralları (avatarlar). */
export const STORAGE_RULES = readFileSync(new URL('storage.rules', root), 'utf8');

let env: RulesTestEnvironment | undefined;

/** Kural test ortamı. Firestore kuralları dosyadan yüklenir; RTDB kuralları `loadDatabaseRules` ile. */
export async function rulesEnv(): Promise<RulesTestEnvironment> {
  env ??= await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: HOST, port: 8080, rules: FIRESTORE_RULES },
    database: { host: HOST, port: 9000 },
  });
  return env;
}

export async function cleanupRulesEnv(): Promise<void> {
  await env?.cleanup();
  env = undefined;
}

/** database.rules.json'u Functions'ın kullandığı ad alanına yükler (firebase.json ile aynı dosya). */
export async function loadDatabaseRules(): Promise<void> {
  const res = await fetch(`http://${DB_HOST}/.settings/rules.json?ns=${RTDB_NS}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer owner' },
    body: DATABASE_RULES,
  });
  if (!res.ok) throw new Error(`RTDB kuralları yüklenemedi: ${res.status} ${await res.text()}`);
}

/** `uid` kimliğiyle istemci RTDB (compat). */
export async function clientDb(uid: string) {
  return (await rulesEnv()).authenticatedContext(uid).database(RTDB_URL);
}

export async function anonDb() {
  return (await rulesEnv()).unauthenticatedContext().database(RTDB_URL);
}

export async function clientFirestore(uid: string) {
  return (await rulesEnv()).authenticatedContext(uid).firestore();
}

// ---------------------------------------------------------------------------
// Konum paketleri (core üretir, testler yalnızca alanları bozar)
// ---------------------------------------------------------------------------

export interface LiveTarget {
  sender_id: string;
  receiver_id: string;
  share_mode: ShareMode;
  expires_at: EpochMs | null;
}

export const SAMPLE_DEVICE: DeviceStatus = { batteryLevel: 0.81, isCharging: false };

export function sampleAt(ts: EpochMs = Date.now()): NormalizedSample {
  return { lat: 41.008238, lng: 28.978359, accuracy: 12.5, speed_mps: 1.3, heading: 87.5, timestamp: ts, mocked: false };
}

/** core `buildPackets` + `toFanoutUpdate` ile tek alıcılık geçerli kopya. */
export function deliveredFor(t: LiveTarget, ts: EpochMs = Date.now()): Record<string, unknown> {
  const update = fanoutFor(t.sender_id, [t], ts);
  const value = Object.values(update)[0];
  if (!value) throw new Error('paket üretilemedi');
  return { ...value };
}

export function fanoutFor(senderId: string, targets: LiveTarget[], ts: EpochMs = Date.now()): Record<string, Record<string, unknown>> {
  const packets = buildPackets(
    sampleAt(ts),
    SAMPLE_DEVICE,
    senderId,
    targets.map((t) => ({ share_id: shareId(t.sender_id, t.receiver_id), receiver_id: t.receiver_id, share_mode: t.share_mode, expires_at: t.expires_at })),
    ts,
  );
  return toFanoutUpdate(packets) as Record<string, Record<string, unknown>>;
}

export const livePathOf = (t: Pick<LiveTarget, 'sender_id' | 'receiver_id'>) =>
  `live_locations/${t.receiver_id}/${shareId(t.sender_id, t.receiver_id)}`;

// ---------------------------------------------------------------------------
// Auth emülatörü: telefonla giriş (gerçek akışla aynı: kod gönder → kodu oku → giriş)
// ---------------------------------------------------------------------------

const AUTH_BASE = `http://${HOST}:9099`;

async function authPost<T>(method: string, body: unknown): Promise<T> {
  const res = await fetch(`${AUTH_BASE}/identitytoolkit.googleapis.com/v1/${method}?key=fake-api-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok || json.error) throw new Error(`auth ${method}: ${JSON.stringify(json.error ?? json)}`);
  return json;
}

export interface TestUser {
  uid: string;
  idToken: string;
  phone: string;
  invite_code: string;
  display_name: string;
}

export const randomPhone = (): string => `+90555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

export async function signInWithPhone(phone: string): Promise<{ uid: string; idToken: string }> {
  const { sessionInfo } = await authPost<{ sessionInfo: string }>('accounts:sendVerificationCode', {
    phoneNumber: phone,
    recaptchaToken: 'emulator',
  });
  const codesRes = await fetch(`${AUTH_BASE}/emulator/v1/projects/${PROJECT_ID}/verificationCodes`);
  const codes = (await codesRes.json()) as { verificationCodes: { sessionInfo: string; code: string }[] };
  const code = codes.verificationCodes.find((c) => c.sessionInfo === sessionInfo)?.code;
  if (!code) throw new Error('doğrulama kodu bulunamadı');
  const r = await authPost<{ localId: string; idToken: string }>('accounts:signInWithPhoneNumber', { sessionInfo, code });
  return { uid: r.localId, idToken: r.idToken };
}

/**
 * Telefonla giriş + user_bootstrap. Faz 6: profil oluşturulurken cinsiyet zorunlu (varsayılan 'female').
 * Faz 8: varsayılan olarak güncel Güvenlik Sözleşmesi / KVKK sürümü de onaylanır (`consent_accept`); onay kapısını
 * sınayan testler `{ consent: false }` verir.
 */
export async function newUser(
  displayName = 'Test',
  gender: 'female' | 'male' = 'female',
  opts: { consent?: boolean } = {},
): Promise<TestUser> {
  const phone = randomPhone();
  const auth = await signInWithPhone(phone);
  const boot = await call<{ user: { invite_code: string } }>('user_bootstrap', { display_name: displayName, gender }, auth);
  if (opts.consent !== false) await acceptConsent(auth);
  return { ...auth, phone, invite_code: boot.user.invite_code, display_name: displayName };
}

/** Faz 8: güncel sürümü core özetiyle onaylar (metin sonuna kadar kaydırılmış). */
export async function acceptConsent(user: { idToken: string }, over: Record<string, unknown> = {}) {
  return call(
    'consent_accept',
    { op_id: opId(), version: CONSENT_VERSION, text_sha256: CONSENT_TEXT_SHA256, scrolled_to_bottom: true, platform: 'ios', app_version: 'test', ...over },
    user,
  );
}

// ---------------------------------------------------------------------------
// Callable protokolü (POST {data} → {result} | {error})
// ---------------------------------------------------------------------------

export class CallError extends Error {
  constructor(
    public readonly status: string,
    message: string,
    public readonly details: Record<string, unknown> | undefined,
  ) {
    super(`${status}: ${message}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function call<T = any>(name: CallableName, data: unknown, user: { idToken: string } | null): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (user) headers.authorization = `Bearer ${user.idToken}`;
  const res = await fetch(`${FUNCTIONS_URL}/${name}`, { method: 'POST', headers, body: JSON.stringify({ data }) });
  const body = (await res.json()) as { result?: T; error?: { status: string; message: string; details?: Record<string, unknown> } };
  if (body.error) throw new CallError(body.error.status, body.error.message, body.error.details);
  return body.result as T;
}

export async function callError(name: CallableName, data: unknown, user: { idToken: string } | null): Promise<CallError> {
  try {
    await call(name, data, user);
  } catch (err) {
    if (err instanceof CallError) return err;
    throw err;
  }
  throw new Error(`${name} hata vermeliydi`);
}

export const opId = (): string => randomUUID();

/** Koşul sağlanana kadar bekle (tetikleyiciler eşzamansızdır). */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor zaman aşımı');
    await new Promise((r) => setTimeout(r, 150));
  }
}
