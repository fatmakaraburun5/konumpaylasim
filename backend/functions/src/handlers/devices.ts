/**
 * Faz 10: cihaz oturumları, iki aşamalı hesap kurtarma (SMS + e-posta / Gmail) ve eski cihazı kapatma
 * (docs/PHASE10.md §3, core `accountSecurity.ts`).
 *
 * Callable'lar:
 *  - `device_register` (cihaz kapısından ve onaydan muaf): telefonla girişten hemen sonra. Aynı kurulum (install_id
 *    özeti) etkin oturumu varsa onu tazeler; yoksa yeni `dsid`. Kurtarma e-postası doğrulanmışsa yeni kurulum
 *    `pending` kalır ve e-postaya kod gider (2. aşama); değilse hemen `active`. Etkinleşince `dsid` iddialı custom token
 *    döner ve hesabın `dsid`'siz belirteçleri `legacy` kara listesiyle kapanır. Diğer etkin cihazlara "yeni cihaz" push'u.
 *  - `device_second_factor_send` / `device_second_factor_verify`: bekleyen cihazın e-posta kodu.
 *  - `device_heartbeat`: son görülme + arka plan konum yayını durumu (en sık 5 dk, durum değişince hemen).
 *  - `device_revoke` (onaydan muaf): "Eski Cihazdaki Oturumu ve Konum Yayınını Kapat" / "Diğer tüm cihazlardan çık".
 *    Kara liste (Firestore + RTDB) ANINDA; o cihazın token'larına sessiz `session_revoked`, sonra token'lar silinir.
 *    `stop_shares` ile açık paylaşımlar da biter (Faz 8 görünmez mod yolu: `stopped_by_sender`).
 *  - `device_sign_out` (onaydan muaf): bu cihazın oturumu kapanır (belirteç yeniden kullanılamaz).
 *  - `recovery_channel_start` / `recovery_channel_verify` / `recovery_channel_remove`: kurtarma kanalları.
 *  - `account_migration_manifest`: yeni cihazın eksiksizlik denetimi (sayı + özet).
 *
 * Kodlar: 6 hane (`crypto.randomInt`), 10 dk, 5 deneme, 60 sn yeniden gönderme, kayıt başına 3 gönderim; günlük
 * `otpSendsPerDay`, saatlik `otpFailuresPerHour`. Yalnızca HMAC-SHA256(biber, `otp:{id}:{kod}`) saklanır.
 */
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import {
  CALLABLES,
  type ChallengeRecord,
  type ChallengeResponse,
  DAY,
  type DeviceActivatedResponse,
  type DeviceHeartbeatResponse,
  type DeviceHeartbeatRequestSchema,
  type DeviceRegisterRequestSchema,
  type DeviceRegisterResponse,
  type DeviceRevokeRequestSchema,
  type DeviceRevokeResponse,
  type DeviceSecondFactorSendRequestSchema,
  type DeviceSecondFactorVerifyRequestSchema,
  type DeviceSessionDoc,
  type DeviceSignOutRequestSchema,
  DSID_CLAIM,
  type EpochMs,
  HOUR,
  LEGACY_DSID,
  type MigrationManifestResponse,
  PATHS,
  type RecoveryChannelRemoveRequestSchema,
  type RecoveryChannelStartRequestSchema,
  type RecoveryChannelVerifyRequestSchema,
  type RecoveryResponse,
  type RecoverySummary,
  SECURITY_LIMITS,
  type UserId,
  type VerificationChannel,
  type VerificationPurpose,
  challengeView,
  checkOtp,
  cleanDeviceModel,
  deviceView,
  formatOtp,
  isGmail,
  maskEmail,
  maskPhone,
  migrationDigest,
  migrationKeys,
  needsSecondFactor,
  normalizeEmail,
  orderedDigest,
  revokedDeviceKey,
  verificationEmail,
  verificationSmsText,
} from '@konum/core';
import { type Transaction, Timestamp } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { adminAuth, db, rtdb } from '../admin';
import type { CallCtx } from '../callable';
import { phonePepper } from '../config';
import { COL, type UserDoc, refs } from '../docs';
import { fail } from '../errors';
import { readRateLimit, runOp, writeRateLimit } from '../ops';
import { type PushSender, buildNewDeviceSigninPush, buildSessionRevokedPush, sendPushToDevice, sendPushToUser } from '../push';
import { sha256Hex } from '../util';
import { DEV_ECHO_CODES, verificationProvider } from '../verification/providers';
import { applyEndedLinks, endOutgoing, readOutgoingActive } from './access';
import type { AuthVerificationProvider } from '@konum/core';

export interface DevicesDeps {
  send?: PushSender;
  /** Yalnızca belirli cihaza (testler sahte verir). */
  sendToDevice?: (uid: UserId, dsid: string, msg: ReturnType<typeof buildSessionRevokedPush>) => Promise<unknown>;
  providers?: Partial<Record<VerificationChannel, AuthVerificationProvider>>;
  /** Custom token üretici (testler / emülatör dışı ortam için). */
  mintToken?: (uid: UserId, dsid: string) => Promise<string>;
  /** Deterministik test kodu. */
  code?: () => string;
}

// --- yardımcılar --------------------------------------------------------------------------------

const newId = (): string => randomBytes(15).toString('base64url');
const installHash = (uid: UserId, installId: string): string => sha256Hex(`install:${uid}:${installId}`).slice(0, 40);
const emailHash = (email: string): string => sha256Hex(`email:${email}`).slice(0, 40);
const codeHash = (challengeId: string, code: string): string => createHmac('sha256', phonePepper()).update(`otp:${challengeId}:${code}`).digest('hex');
const purge = (at: EpochMs): Timestamp => Timestamp.fromMillis(at);

const mint = (deps: DevicesDeps, uid: UserId, dsid: string): Promise<string> =>
  deps.mintToken ? deps.mintToken(uid, dsid) : adminAuth().createCustomToken(uid, { [DSID_CLAIM]: dsid });

interface StoredDevice extends DeviceSessionDoc {
  purge_at: Timestamp | null;
}

interface StoredChallenge extends ChallengeRecord {
  purge_at: Timestamp;
}

interface RecoveryChannelsDoc {
  email: string | null;
  email_verified_at: EpochMs | null;
  phone_e164: string | null;
  sms_verified_at: EpochMs | null;
  updated_at: EpochMs;
}

function summaryOf(c: RecoveryChannelsDoc | undefined, now: EpochMs): RecoverySummary {
  const sms = c?.phone_e164 ? { masked: maskPhone(c.phone_e164), verified_at: c.sms_verified_at ?? null } : null;
  const email = c?.email ? { masked: maskEmail(c.email), verified_at: c.email_verified_at ?? null, gmail: isGmail(c.email) } : null;
  return { sms, email, two_step: !!(sms?.verified_at && email?.verified_at), updated_at: now };
}

async function readDevices(tx: Transaction, uid: UserId): Promise<StoredDevice[]> {
  const snap = await tx.get(refs.deviceSessionsOf(uid));
  return snap.docs.map((d) => d.data() as StoredDevice).filter((d) => d.owner_id === uid);
}

function newChallenge(i: {
  uid: UserId;
  channel: VerificationChannel;
  purpose: VerificationPurpose;
  to: string;
  dsid: string | null;
  now: EpochMs;
  code: string;
}): StoredChallenge {
  const challenge_id = newId();
  return {
    challenge_id,
    owner_id: i.uid,
    channel: i.channel,
    purpose: i.purpose,
    to: i.to,
    to_masked: i.channel === 'sms' ? maskPhone(i.to) : maskEmail(i.to),
    code_hash: codeHash(challenge_id, i.code),
    attempts: 0,
    sends: 1,
    state: 'pending',
    created_at: i.now,
    expires_at: i.now + SECURITY_LIMITS.otpTtlMs,
    resend_at: i.now + SECURITY_LIMITS.otpResendMs,
    dsid: i.dsid,
    purge_at: purge(i.now + SECURITY_LIMITS.otpRetentionMs),
  };
}

const makeCode = (deps: DevicesDeps): string => (deps.code ? deps.code() : formatOtp(randomInt(0, 10 ** SECURITY_LIMITS.otpDigits)));

/** Kodu sağlayıcıyla gönderir (commit SONRASI). Gönderilemezse kayıt iptal edilir ve hata döner. */
async function deliver(deps: DevicesDeps, rec: StoredChallenge, code: string, model: string | null): Promise<void> {
  const provider = deps.providers?.[rec.channel] ?? verificationProvider(rec.channel);
  const mail = verificationEmail(code, rec.purpose, model);
  const text = rec.channel === 'sms' ? verificationSmsText(code, rec.purpose) : mail.text;
  const r = await provider.send({ to: rec.to, code, purpose: rec.purpose, text, subject: rec.channel === 'email' ? mail.subject : undefined });
  if (!r.ok) {
    await refs.verificationChallenge(rec.challenge_id).update({ state: 'failed' }).catch(() => undefined);
    logger.warn('doğrulama kodu gönderilemedi', { channel: rec.channel, reason: r.reason });
    throw fail('verification_unavailable');
  }
}

const viewOf = (rec: ChallengeRecord, code: string) => challengeView(rec, DEV_ECHO_CODES ? code : undefined);

/** Kara listeyi RTDB'ye yansıtır (Firestore kaydı transaction'da yazıldı). Hata: yeniden denenir, sonra loglanır. */
async function mirrorRevoked(uid: UserId, dsids: readonly string[]): Promise<void> {
  if (dsids.length === 0) return;
  const updates: Record<string, true> = {};
  for (const d of dsids) updates[PATHS.revokedDeviceMirror(uid, d)] = true;
  for (let i = 0; i < 3; i++) {
    try {
      await rtdb().ref().update(updates);
      return;
    } catch (err) {
      if (i === 2) logger.error('revoked_devices RTDB aynası yazılamadı', { uid, err: String(err) });
    }
  }
}

function writeRevoked(tx: Transaction, uid: UserId, dsid: string, now: EpochMs, reason: string): void {
  tx.set(refs.revokedDevice(revokedDeviceKey(uid, dsid)), { uid, dsid, reason, revoked_at: now });
}

/** İptal edilen cihaza sessiz push + o cihazın token kayıtlarını siler (en iyi çabayla). */
async function killDevice(deps: DevicesDeps, uid: UserId, dsid: string): Promise<void> {
  try {
    if (deps.sendToDevice) await deps.sendToDevice(uid, dsid, buildSessionRevokedPush(dsid));
    const r = await sendPushToDevice(uid, dsid, buildSessionRevokedPush(dsid));
    await Promise.all(r.tokens.map((t) => t.delete().catch(() => undefined)));
  } catch (err) {
    logger.warn('session_revoked push gönderilemedi', { uid, err: String(err) });
  }
}

async function notifyOthers(deps: DevicesDeps, uid: UserId, newDsid: string, model: string, others: readonly string[]): Promise<void> {
  if (others.length === 0) return;
  try {
    const msg = buildNewDeviceSigninPush(newDsid, model);
    if (deps.send) await deps.send(uid, msg);
    else await sendPushToUser(uid, msg);
  } catch (err) {
    logger.warn('device_new_signin push gönderilemedi', { uid, err: String(err) });
  }
}

/** Etkin cihaz sınırını aşanlar (en eski görülen) `limit` ile kapanır. */
function overLimit(devices: readonly StoredDevice[], keep: string): StoredDevice[] {
  const active = devices.filter((d) => d.status === 'active' && d.dsid !== keep).sort((a, b) => b.last_seen_at - a.last_seen_at);
  return active.slice(SECURITY_LIMITS.maxActiveDevices - 1);
}

function activate(tx: Transaction, d: StoredDevice, now: EpochMs, via: VerificationChannel[], devices: readonly StoredDevice[], uid: UserId): string[] {
  const next: StoredDevice = { ...d, status: 'active', activated_at: now, last_seen_at: now, verified_by: via, purge_at: null };
  tx.set(refs.deviceSession(d.dsid), next);
  // İlk cihaz kaydından sonra dsid'siz belirteçler kapanır (yeni girişler önce device_register çağırır).
  writeRevoked(tx, uid, LEGACY_DSID, now, 'enforced');
  const revoked: string[] = [LEGACY_DSID];
  for (const o of overLimit(devices, d.dsid)) {
    tx.update(refs.deviceSession(o.dsid), { status: 'revoked', revoked_at: now, revoke_reason: 'limit', revoked_by: d.dsid, purge_at: purge(now + SECURITY_LIMITS.retentionMs) });
    writeRevoked(tx, uid, o.dsid, now, 'limit');
    revoked.push(o.dsid);
  }
  Object.assign(d, next);
  return revoked;
}

// --- device_register ----------------------------------------------------------------------------

export async function deviceRegister(ctx: CallCtx, data: z.output<typeof DeviceRegisterRequestSchema>, deps: DevicesDeps = {}): Promise<DeviceRegisterResponse> {
  const now = ctx.now;
  const ih = installHash(ctx.uid, data.device.install_id);
  const model = cleanDeviceModel(data.device.model);
  const code = makeCode(deps);
  const out = await db().runTransaction(async (tx) => {
    const devices = await readDevices(tx, ctx.uid);
    const chSnap = await tx.get(refs.recoveryChannels(ctx.uid));
    const ch = chSnap.data() as RecoveryChannelsDoc | undefined;
    const rate = await readRateLimit(tx, ctx.uid, 'device_register', 30, DAY, now);
    const same = devices.filter((d) => d.install_hash === ih && d.status !== 'revoked').sort((a, b) => b.created_at - a.created_at)[0];
    const migrated = devices.some((d) => d.install_hash !== ih);
    writeRateLimit(tx, rate, DAY);
    // SMS ile giriş numaranın sahipliğini kanıtlar: kurtarma kanalında telefon "doğrulandı" sayılır.
    if (ctx.phone_e164 && !(ch?.phone_e164 === ctx.phone_e164 && ch.sms_verified_at)) {
      tx.set(refs.recoveryChannels(ctx.uid), { phone_e164: ctx.phone_e164, sms_verified_at: now, updated_at: now }, { merge: true });
    }
    if (same?.status === 'active') {
      // Bilinen kurulum: tazele (yeniden giriş, token yenileme).
      tx.update(refs.deviceSession(same.dsid), {
        last_seen_at: now,
        platform: data.device.platform,
        model,
        os_version: data.device.os_version,
        app_version: data.device.app_version,
      });
      return { status: 'active' as const, device: { ...same, last_seen_at: now, model }, challenge: null, migrated, revoked: [] as string[], others: [] as string[] };
    }
    const base: StoredDevice = same ?? {
      dsid: newId(),
      owner_id: ctx.uid,
      install_hash: ih,
      platform: data.device.platform,
      model,
      os_version: data.device.os_version,
      app_version: data.device.app_version,
      status: 'pending',
      created_at: now,
      activated_at: null,
      last_seen_at: now,
      publishing: false,
      publishing_at: null,
      verified_by: [],
      revoked_at: null,
      revoke_reason: null,
      revoked_by: null,
      purge_at: purge(now + SECURITY_LIMITS.retentionMs),
    };
    const others = devices.filter((d) => d.status === 'active' && d.dsid !== base.dsid).map((d) => d.dsid);
    const need = needsSecondFactor({ emailVerified: !!(ch?.email && ch.email_verified_at), knownInstall: false });
    if (need === 'none') {
      const revoked = activate(tx, base, now, ['sms'], devices, ctx.uid);
      return { status: 'active' as const, device: base, challenge: null, migrated, revoked, others };
    }
    tx.set(refs.deviceSession(base.dsid), { ...base, last_seen_at: now });
    const rec = newChallenge({ uid: ctx.uid, channel: 'email', purpose: 'device_second_factor', to: ch!.email!, dsid: base.dsid, now, code });
    tx.set(refs.verificationChallenge(rec.challenge_id), rec);
    return { status: 'needs_second_factor' as const, device: base, challenge: rec, migrated, revoked: [] as string[], others };
  });
  if (out.challenge) await deliver(deps, out.challenge, code, model);
  await mirrorRevoked(ctx.uid, out.revoked);
  for (const d of out.revoked.filter((x) => x !== LEGACY_DSID)) await killDevice(deps, ctx.uid, d);
  if (out.status === 'active' && out.others.length) await notifyOthers(deps, ctx.uid, out.device.dsid, out.device.model, out.others);
  return {
    status: out.status,
    device: deviceView(out.device),
    custom_token: out.status === 'active' ? await mint(deps, ctx.uid, out.device.dsid) : null,
    challenge: out.challenge ? viewOf(out.challenge, code) : null,
    migrated: out.migrated,
    server_now: now,
  };
}

// --- ikinci aşama ------------------------------------------------------------------------------

export async function deviceSecondFactorSend(
  ctx: CallCtx,
  data: z.output<typeof DeviceSecondFactorSendRequestSchema>,
  deps: DevicesDeps = {},
): Promise<ChallengeResponse> {
  const now = ctx.now;
  const code = makeCode(deps);
  const rec = await db().runTransaction(async (tx) => {
    const ds = await tx.get(refs.deviceSession(data.dsid));
    const d = ds.data() as StoredDevice | undefined;
    if (!d || d.owner_id !== ctx.uid || d.status !== 'pending') throw fail('device_not_found');
    const ch = (await tx.get(refs.recoveryChannels(ctx.uid))).data() as RecoveryChannelsDoc | undefined;
    if (!ch?.email || !ch.email_verified_at) throw fail('device_not_found');
    const prev = await tx.get(db().collection(COL.verificationChallenges).where('owner_id', '==', ctx.uid).where('dsid', '==', data.dsid));
    const latest = prev.docs.map((x) => x.data() as StoredChallenge).sort((a, b) => b.created_at - a.created_at)[0];
    if (latest && latest.state === 'pending' && now < latest.resend_at) throw fail('otp_resend_wait', { extra: { retry_after_ms: latest.resend_at - now } });
    const rate = await readRateLimit(tx, ctx.uid, 'otp_send', SECURITY_LIMITS.otpSendsPerDay, DAY, now);
    writeRateLimit(tx, rate, DAY);
    if (latest?.state === 'pending') tx.update(refs.verificationChallenge(latest.challenge_id), { state: 'expired' });
    const r = newChallenge({ uid: ctx.uid, channel: 'email', purpose: 'device_second_factor', to: ch.email, dsid: data.dsid, now, code });
    tx.set(refs.verificationChallenge(r.challenge_id), r);
    return { r, model: d.model };
  });
  await deliver(deps, rec.r, code, rec.model);
  return { challenge: viewOf(rec.r, code), server_now: now };
}

/** Kod denetimi transaction'ı: yanlış denemeler de yazılır, hata commit SONRASI fırlatılır. */
async function verifyChallenge(
  tx: Transaction,
  ctx: CallCtx,
  challengeId: string,
  code: string,
  purposes: readonly VerificationPurpose[],
): Promise<{ ok: true; rec: StoredChallenge; commit: () => void } | { ok: false; code: 'otp_invalid' | 'otp_expired' | 'otp_locked' }> {
  const cs = await tx.get(refs.verificationChallenge(challengeId));
  const rec = cs.data() as StoredChallenge | undefined;
  if (!rec || rec.owner_id !== ctx.uid || !purposes.includes(rec.purpose)) return { ok: false, code: 'otp_expired' };
  const fails = await readRateLimit(tx, ctx.uid, 'otp_fail', SECURITY_LIMITS.otpFailuresPerHour, HOUR, ctx.now);
  const r = checkOtp(rec, code, (c) => codeHash(rec.challenge_id, c), ctx.now);
  const write = () => tx.update(cs.ref, { attempts: r.record.attempts, state: r.record.state });
  if (!r.ok) {
    write();
    writeRateLimit(tx, fails, HOUR);
    return { ok: false, code: r.code };
  }
  // Başarı: yazım çağıranın kalan okumalarından SONRA (`commit`; Firestore: önce tüm okumalar).
  return { ok: true, rec: { ...rec, ...r.record }, commit: write };
}

export async function deviceSecondFactorVerify(
  ctx: CallCtx,
  data: z.output<typeof DeviceSecondFactorVerifyRequestSchema>,
  deps: DevicesDeps = {},
): Promise<DeviceActivatedResponse> {
  const now = ctx.now;
  const out = await db().runTransaction(async (tx) => {
    const ds = await tx.get(refs.deviceSession(data.dsid));
    const d = ds.data() as StoredDevice | undefined;
    const devices = await readDevices(tx, ctx.uid);
    const v = await verifyChallenge(tx, ctx, data.challenge_id, data.code, ['device_second_factor']);
    if (!v.ok) return { error: v.code };
    if (!d || d.owner_id !== ctx.uid || d.status !== 'pending' || v.rec.dsid !== d.dsid) return { error: 'device_not_found' as const };
    v.commit();
    const others = devices.filter((x) => x.status === 'active' && x.dsid !== d.dsid).map((x) => x.dsid);
    const revoked = activate(tx, d, now, ['sms', 'email'], devices, ctx.uid);
    return { device: d, revoked, others, migrated: devices.some((x) => x.dsid !== d.dsid) };
  });
  if ('error' in out) throw fail(out.error as 'otp_invalid');
  await mirrorRevoked(ctx.uid, out.revoked);
  for (const x of out.revoked.filter((r) => r !== LEGACY_DSID)) await killDevice(deps, ctx.uid, x);
  await notifyOthers(deps, ctx.uid, out.device.dsid, out.device.model, out.others);
  return { device: deviceView(out.device), custom_token: await mint(deps, ctx.uid, out.device.dsid), migrated: out.migrated, server_now: now };
}

// --- heartbeat / iptal / çıkış -----------------------------------------------------------------

export async function deviceHeartbeat(ctx: CallCtx, data: z.output<typeof DeviceHeartbeatRequestSchema>): Promise<DeviceHeartbeatResponse> {
  if (!ctx.dsid) throw fail('device_registration_required');
  const ref = refs.deviceSession(ctx.dsid);
  const snap = await ref.get();
  const d = snap.data() as StoredDevice | undefined;
  if (!d || d.owner_id !== ctx.uid) throw fail('device_not_found');
  if (d.status === 'revoked') throw fail('session_revoked');
  const due = ctx.now - d.last_seen_at >= SECURITY_LIMITS.heartbeatMinIntervalMs;
  const changed = d.publishing !== data.publishing || (data.app_version !== null && data.app_version !== d.app_version);
  if (!due && !changed) return { device: deviceView(d), written: false, server_now: ctx.now };
  const patch = {
    last_seen_at: ctx.now,
    publishing: data.publishing,
    publishing_at: d.publishing !== data.publishing ? ctx.now : d.publishing_at,
    app_version: data.app_version ?? d.app_version,
  };
  await ref.update(patch);
  return { device: deviceView({ ...d, ...patch }), written: true, server_now: ctx.now };
}

export async function deviceRevoke(ctx: CallCtx, data: z.output<typeof DeviceRevokeRequestSchema>, deps: DevicesDeps = {}): Promise<DeviceRevokeResponse> {
  if (!ctx.dsid) throw fail('device_registration_required');
  if (data.dsid === ctx.dsid) throw fail('device_is_current');
  const now = ctx.now;
  let links: Parameters<typeof applyEndedLinks>[1] = [];
  const res = await runOp(ctx, data.op_id, CALLABLES.deviceRevoke, data, async (tx) => {
    const devices = await readDevices(tx, ctx.uid);
    const me = devices.find((d) => d.dsid === ctx.dsid);
    if (!me || me.status !== 'active') throw fail('session_revoked');
    const targets = data.all_others ? devices.filter((d) => d.dsid !== ctx.dsid && d.status !== 'revoked') : devices.filter((d) => d.dsid === data.dsid && d.status !== 'revoked');
    if (!data.all_others && targets.length === 0) throw fail('device_not_found');
    const outgoing = data.stop_shares ? await readOutgoingActive(tx, ctx.uid) : null;
    for (const t of targets) {
      tx.update(refs.deviceSession(t.dsid), {
        status: 'revoked',
        publishing: false,
        revoked_at: now,
        revoke_reason: data.all_others ? 'all_others' : 'remote',
        revoked_by: ctx.dsid,
        purge_at: purge(now + SECURITY_LIMITS.retentionMs),
      });
      writeRevoked(tx, ctx.uid, t.dsid, now, data.all_others ? 'all_others' : 'remote');
    }
    const ended = outgoing ? endOutgoing(tx, outgoing, now) : { shares: [], links: [] };
    links = ended.links;
    const response: DeviceRevokeResponse = { revoked: targets.map((t) => t.dsid), stopped_shares: ended.shares.length + ended.links.length, server_now: now };
    return {
      response,
      shareEffects: ended.shares,
      after: async () => {
        await mirrorRevoked(ctx.uid, response.revoked);
        for (const t of response.revoked) await killDevice(deps, ctx.uid, t);
      },
    };
  });
  await applyEndedLinks('device_revoke', links);
  // Yinelenen op_id'de `after` çalışmaz: kara liste aynasını yine de garanti et (idempotent).
  await mirrorRevoked(ctx.uid, res.revoked);
  return res;
}

export async function deviceSignOut(ctx: CallCtx, _data: z.output<typeof DeviceSignOutRequestSchema>, deps: DevicesDeps = {}): Promise<{ signed_out: boolean; server_now: EpochMs }> {
  if (!ctx.dsid) return { signed_out: false, server_now: ctx.now };
  const dsid = ctx.dsid;
  const done = await db().runTransaction(async (tx) => {
    const s = await tx.get(refs.deviceSession(dsid));
    const d = s.data() as StoredDevice | undefined;
    if (!d || d.owner_id !== ctx.uid || d.status === 'revoked') return false;
    tx.update(s.ref, { status: 'revoked', publishing: false, revoked_at: ctx.now, revoke_reason: 'signed_out', revoked_by: dsid, purge_at: purge(ctx.now + SECURITY_LIMITS.retentionMs) });
    writeRevoked(tx, ctx.uid, dsid, ctx.now, 'signed_out');
    return true;
  });
  await mirrorRevoked(ctx.uid, [dsid]);
  if (done) {
    const toks = await refs.deviceTokens(ctx.uid).where('dsid', '==', dsid).get();
    await Promise.all(toks.docs.map((t) => t.ref.delete().catch(() => undefined)));
  }
  void deps;
  return { signed_out: done, server_now: ctx.now };
}

// --- kurtarma kanalları --------------------------------------------------------------------------

export async function recoveryChannelStart(
  ctx: CallCtx,
  data: z.output<typeof RecoveryChannelStartRequestSchema>,
  deps: DevicesDeps = {},
): Promise<ChallengeResponse> {
  const now = ctx.now;
  const code = makeCode(deps);
  const email = data.channel === 'email' ? normalizeEmail(data.email ?? '') : null;
  if (data.channel === 'email' && !email) throw fail('email_invalid');
  const rec = await db().runTransaction(async (tx) => {
    const priv = (await tx.get(refs.userPrivate(ctx.uid))).data() as { phone_e164?: string } | undefined;
    const phone = priv?.phone_e164 ?? ctx.phone_e164;
    if (data.channel === 'sms' && !phone) throw fail('verification_unavailable');
    if (email) {
      const idx = (await tx.get(refs.recoveryEmail(emailHash(email)))).data() as { uid?: string } | undefined;
      if (idx?.uid && idx.uid !== ctx.uid) throw fail('email_in_use');
    }
    const rate = await readRateLimit(tx, ctx.uid, 'otp_send', SECURITY_LIMITS.otpSendsPerDay, DAY, now);
    writeRateLimit(tx, rate, DAY);
    const r = newChallenge({
      uid: ctx.uid,
      channel: data.channel,
      purpose: data.channel === 'email' ? 'link_email' : 'verify_phone',
      to: email ?? phone!,
      dsid: ctx.dsid ?? null,
      now,
      code,
    });
    tx.set(refs.verificationChallenge(r.challenge_id), r);
    return r;
  });
  await deliver(deps, rec, code, null);
  return { challenge: viewOf(rec, code), server_now: now };
}

export async function recoveryChannelVerify(ctx: CallCtx, data: z.output<typeof RecoveryChannelVerifyRequestSchema>): Promise<RecoveryResponse> {
  const now = ctx.now;
  const out = await db().runTransaction(async (tx) => {
    const chRef = refs.recoveryChannels(ctx.uid);
    const ch = (await tx.get(chRef)).data() as RecoveryChannelsDoc | undefined;
    const v = await verifyChallenge(tx, ctx, data.challenge_id, data.code, ['link_email', 'verify_phone']);
    if (!v.ok) return { error: v.code };
    let next: RecoveryChannelsDoc = { email: null, email_verified_at: null, phone_e164: null, sms_verified_at: null, ...ch, updated_at: now };
    if (v.rec.purpose === 'link_email') {
      const hash = emailHash(v.rec.to);
      const idx = (await tx.get(refs.recoveryEmail(hash))).data() as { uid?: string } | undefined;
      if (idx?.uid && idx.uid !== ctx.uid) return { error: 'email_in_use' as const };
      v.commit();
      if (ch?.email && ch.email !== v.rec.to) tx.delete(refs.recoveryEmail(emailHash(ch.email)));
      tx.set(refs.recoveryEmail(hash), { uid: ctx.uid, created_at: now });
      next = { ...next, email: v.rec.to, email_verified_at: now };
    } else {
      v.commit();
      next = { ...next, phone_e164: v.rec.to, sms_verified_at: now };
    }
    tx.set(chRef, next);
    const summary = summaryOf(next, now);
    tx.set(refs.recoverySummary(ctx.uid), summary);
    return { summary };
  });
  if ('error' in out) throw fail(out.error as 'otp_invalid');
  return { recovery: out.summary, server_now: now };
}

export async function recoveryChannelRemove(ctx: CallCtx, _data: z.output<typeof RecoveryChannelRemoveRequestSchema>): Promise<RecoveryResponse> {
  const now = ctx.now;
  const summary = await db().runTransaction(async (tx) => {
    const chRef = refs.recoveryChannels(ctx.uid);
    const ch = (await tx.get(chRef)).data() as RecoveryChannelsDoc | undefined;
    if (ch?.email) tx.delete(refs.recoveryEmail(emailHash(ch.email)));
    const next: RecoveryChannelsDoc = { phone_e164: ch?.phone_e164 ?? null, sms_verified_at: ch?.sms_verified_at ?? null, email: null, email_verified_at: null, updated_at: now };
    tx.set(chRef, next);
    const s = summaryOf(next, now);
    tx.set(refs.recoverySummary(ctx.uid), s);
    return s;
  });
  return { recovery: summary, server_now: now };
}

// --- taşıma bildirimi ----------------------------------------------------------------------------

export async function accountMigrationManifest(ctx: CallCtx): Promise<MigrationManifestResponse> {
  const uid = ctx.uid;
  const [fr, given, received, user, zones] = await Promise.all([
    db().collection(COL.friendships).where('member_ids', 'array-contains', uid).where('status', '==', 'accepted').get(),
    db().collection(COL.permissionGrants).where('granter_id', '==', uid).get(),
    db().collection(COL.permissionGrants).where('grantee_id', '==', uid).get(),
    refs.user(uid).get(),
    refs.zones(uid).get(),
  ]);
  const friendKeys = fr.docs.map((d) => ((d.get('member_ids') as string[]) ?? []).find((m) => m !== uid)).filter((x): x is string => !!x).map(migrationKeys.friendship);
  const grantKeys = [...given.docs, ...received.docs].map((d) => {
    const g = d.data() as { granter_id: string; grantee_id: string; scopes?: Record<string, unknown> };
    const scopes = Object.entries(g.scopes ?? {}).filter(([, v]) => v != null).map(([k]) => k);
    return migrationKeys.grant(g.granter_id, g.grantee_id, scopes);
  }).filter((k) => !k.endsWith(':'));
  const u = user.data() as UserDoc | undefined;
  const consent = u?.consent ? [migrationKeys.consent(u.consent.version, u.consent.accepted_at ?? null)] : [];
  return {
    manifest: {
      generated_at: ctx.now,
      items: {
        friendships: migrationDigest(friendKeys),
        permission_grants: migrationDigest(grantKeys),
        favorites: orderedDigest((u?.favorite_ids ?? []) as string[]),
        zones: migrationDigest(zones.docs.map((z) => migrationKeys.zone(z.id))),
        consents: migrationDigest(consent),
      },
    },
    server_now: ctx.now,
  };
}

/** Hesap silme: tüm cihaz kayıtları, kara liste, kurtarma kanalları ve kodlar. */
export async function deleteSecurityOf(uid: UserId): Promise<void> {
  const [devs, chal, ch] = await Promise.all([
    refs.deviceSessionsOf(uid).get(),
    db().collection(COL.verificationChallenges).where('owner_id', '==', uid).get(),
    refs.recoveryChannels(uid).get(),
  ]);
  const email = (ch.data() as RecoveryChannelsDoc | undefined)?.email;
  await Promise.all([
    ...devs.docs.map((d) => d.ref.delete()),
    ...devs.docs.map((d) => refs.revokedDevice(revokedDeviceKey(uid, d.id)).delete()),
    refs.revokedDevice(revokedDeviceKey(uid, LEGACY_DSID)).delete(),
    ...chal.docs.map((d) => d.ref.delete()),
    ch.ref.delete(),
    refs.recoverySummary(uid).delete(),
    rtdb().ref(`revoked_devices/${uid}`).remove(),
    ...(email ? [refs.recoveryEmail(emailHash(email)).delete()] : []),
  ]);
  await rtdb().ref(`revoked_devices/${uid}`).remove().catch(() => undefined);
}
