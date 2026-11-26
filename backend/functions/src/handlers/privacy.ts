/**
 * Faz 7: İzin & Gizlilik Merkezi sunucu tarafı — `privacy_settings_set` ve `movement_report` ("yola çıktı").
 *
 * `privacy_settings_set`: `users/{uid}.privacy` + RTDB aynası `privacy/{uid}` (kurallar `battery_pct` / `is_charging`
 * yazımını `privacy/{auth.uid}/battery_share === true` şartına bağlar → pil bilgisi sunucu tarafında zorlanır).
 * Sıra (core `privacy.ts`): pil paylaşımını AÇARKEN önce ayna sonra Firestore; KAPATIRKEN önce Firestore (istemci
 * hemen bırakır) sonra ayna. Ayna yazılamazsa `unavailable` (istemci aynı op_id ile yineler; Firestore yazımı
 * idempotent). Kapatmak onaysız da yapılabilir (core `consentExemptCall`).
 *
 * `movement_report`: paylaşım sürerken gönderenin hareket makinesi "sabit ≥ 10 dk → hareket" geçişi yaptıysa
 * (core `shouldReportDeparture`). Alıcılar = o an ETKİN paylaşımlarımın alıcıları (canlı konumu zaten görüyorlar) ve
 * `privacy.movement_alerts` kapalı olmayanlar. Görünmezken (`invisible`), geç rapor (`stale`), soğuma (`cooldown`)
 * ya da alıcı yoksa bildirim gitmez. Koordinat yok. Gönderen başına `MOVEMENT_LIMITS.cooldownMs`.
 */
import {
  CALLABLES,
  HOUR,
  MOVEMENT_LIMITS,
  type MovementReportRequestSchema,
  type MovementReportResponse,
  type PrivacySettings,
  type PrivacySettingsResponse,
  type PrivacySettingsSetRequestSchema,
  type UserId,
  isInvisible,
  parsePrivacy,
} from '@konum/core';
import { Timestamp } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { db, rtdb } from '../admin';
import type { CallCtx } from '../callable';
import { COL, type ShareDoc, type UserDoc, isUsableProfile, refs } from '../docs';
import { fail } from '../errors';
import { needsProfile, readCaller } from '../graph';
import { readRateLimit, runOp, writeRateLimit } from '../ops';
import { type PushSender, buildMovementPush, sendPushToUser } from '../push';

/** RTDB aynası: yalnızca istemcinin kural için gereksindiği alan. */
export const privacyMirrorPath = (uid: UserId) => `privacy/${uid}`;

async function writeMirror(uid: UserId, p: PrivacySettings): Promise<void> {
  try {
    await rtdb().ref(privacyMirrorPath(uid)).set({ battery_share: p.battery_share, updated_at: p.updated_at });
  } catch (err) {
    logger.error('gizlilik aynası yazılamadı', { err: String(err) });
    throw fail('unavailable');
  }
}

export async function privacySettingsSet(ctx: CallCtx, data: z.output<typeof PrivacySettingsSetRequestSchema>): Promise<PrivacySettingsResponse> {
  const now = ctx.now;
  const ref = refs.user(ctx.uid);
  const u = (await ref.get()).data() as UserDoc | undefined;
  if (!isUsableProfile(u)) throw needsProfile();
  const prev = parsePrivacy(u.privacy);
  const next: PrivacySettings = {
    battery_share: data.battery_share ?? prev.battery_share,
    movement_alerts: data.movement_alerts ?? prev.movement_alerts,
    updated_at: now,
  };
  const enablingBattery = next.battery_share && !prev.battery_share;
  // Açarken: önce ayna (kural izin verir), sonra Firestore (istemci yayına başlar).
  if (enablingBattery) await writeMirror(ctx.uid, next);
  const res = await runOp(ctx, data.op_id, CALLABLES.privacySettingsSet, data, async (tx) => {
    await readCaller(tx, ctx.uid, { consent: false });
    const rate = await readRateLimit(tx, ctx.uid, 'privacy_set', 60, HOUR, now);
    tx.update(ref, { privacy: next });
    writeRateLimit(tx, rate, HOUR);
    return { response: { privacy: next, server_now: now } satisfies PrivacySettingsResponse };
  });
  // Kapatırken (ya da değişmediyse eşitlemek için): Firestore'dan sonra ayna.
  if (!enablingBattery) await writeMirror(ctx.uid, next);
  return res;
}

export interface MovementDeps {
  send?: PushSender;
}

export async function movementReport(ctx: CallCtx, data: z.output<typeof MovementReportRequestSchema>, deps: MovementDeps = {}): Promise<MovementReportResponse> {
  const send = deps.send ?? sendPushToUser;
  const now = ctx.now;
  const done = (status: MovementReportResponse['status'], n = 0): MovementReportResponse => ({ status, notified_count: n, server_now: now });
  return runOp(ctx, data.op_id, CALLABLES.movementReport, data, async (tx) => {
    const me = await readCaller(tx, ctx.uid);
    const rate = await readRateLimit(tx, ctx.uid, 'movement_report', 12, HOUR, now);
    const coolRef = refs.movementCooldown(ctx.uid);
    const coolSnap = await tx.get(coolRef);
    const shares = await tx.get(db().collection(COL.shares).where('sender_id', '==', ctx.uid).where('status', '==', 'active'));
    const live = shares.docs.map((d) => d.data() as ShareDoc).filter((s) => s.expires_at === null || s.expires_at > now);
    const receivers = [...new Set(live.map((s) => s.receiver_id))];
    const recvSnaps = receivers.length ? await tx.getAll(...receivers.map((u) => refs.user(u))) : [];
    writeRateLimit(tx, rate, HOUR);

    if (isInvisible(me)) return { response: done('invisible') };
    if (now - data.at > MOVEMENT_LIMITS.maxReportAgeMs || data.at > now + MOVEMENT_LIMITS.maxReportAgeMs) return { response: done('stale') };
    const last = (coolSnap.data() as { last_at?: number } | undefined)?.last_at ?? null;
    if (last !== null && now - last < MOVEMENT_LIMITS.cooldownMs) return { response: done('cooldown') };
    const to = receivers.filter((_, i) => parsePrivacy((recvSnaps[i]?.data() as UserDoc | undefined)?.privacy).movement_alerts);
    if (to.length === 0) return { response: done('no_recipients') };

    tx.set(coolRef, { uid: ctx.uid, last_at: now, purge_at: Timestamp.fromMillis(now + MOVEMENT_LIMITS.cooldownMs + HOUR) });
    const msg = buildMovementPush(me.display_name ?? '', ctx.uid, data.kind, now);
    return {
      response: done('sent', to.length),
      after: async () => {
        const res = await Promise.allSettled(to.map((u) => send(u, msg)));
        const failed = res.filter((r) => r.status === 'rejected').length;
        if (failed) logger.warn('hareket bildirimi: bazı alıcılara gönderilemedi', { failed, total: res.length });
      },
    };
  });
}
