/**
 * Faz 3: `battery_low_notify` — paylaşan cihazın pili %15'in altına indiğinde oturumun alıcılarına BİR KEZ bildirim.
 *
 * İlke: istemci kendi core `lowBatteryTrigger` durumu değiştiğinde (bildirim ya da yeniden kurma) çağırır; sunucu
 * AYNI saf fonksiyonu kendi durum belgesiyle (`battery_alerts/{uid}_{session_id}`) yeniden uygular. Böylece istemci
 * yeniden kurulsa, iki cihaz aynı oturumu yayınlasa ya da çağrı tekrarlansa bile bildirim düşüş başına bir kez gider:
 *  - ≤ %15 ve şarjda değil + kurulu → bildirim, durum `armed: false`;
 *  - ≥ %20 ya da şarjda → yeniden kurulur (bildirim yok);
 *  - iki bildirim arasında en az 30 dk (core `LOW_BATTERY_MIN_REFIRE_MS`, tak-çıkar), oturum başına 24 saatte en çok
 *    `LIMITS.batteryAlertsPerSessionPerDay` (kötü niyetli istemci tavanı).
 *  - Yedek yeniden kurma: istemci yeniden kurma çağrısını kaçırdıysa, son bildirimden SONRA yayınlanmış bir canlı
 *    paket `battery_pct ≥ 20` ya da `is_charging: true` taşıyorsa durum kurulmuş sayılır (RTDB'den okunur).
 *
 * Doğrulama: çağıran, `session_id` oturumunun GÖNDERENİ olmalı ve oturumda süresi dolmamış en az bir aktif paylaşım
 * bulunmalı (yoksa `share_not_active`). `op_id` tekrarı saklanan yanıtı döndürür ve bildirimi yeniden göndermez.
 * Bildirim koordinat İÇERMEZ (bkz. push.ts `buildBatteryLowPush`). Bağlantı (QR) izleyicilerine push yoktur.
 */
import {
  CALLABLES,
  DAY,
  HOUR,
  LOW_BATTERY_PCT,
  type LowBatteryState,
  LOW_BATTERY_REARM_PCT,
  type EpochMs,
  livePath,
  lowBatteryTrigger,
} from '@konum/core';
import { Timestamp } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { db, rtdb } from '../admin';
import type { CallCtx } from '../callable';
import { LIMITS } from '../config';
import { type BatteryAlertDoc, COL, type ShareDoc, type UserDoc, refs } from '../docs';
import { fail } from '../errors';
import { readRateLimit, runOp, writeRateLimit } from '../ops';
import { type PushSender, buildBatteryLowPush, sendPushToUser } from '../push';
import type { BatteryLowNotifyResponse, BatteryLowNotifySchema } from '../schemas';

export interface BatteryDeps {
  /** Testler sahte gönderici verir; varsayılan FCM (`sendPushToUser`). */
  send?: PushSender;
}

const isLive = (s: ShareDoc, now: EpochMs) => s.status === 'active' && (s.expires_at === null || s.expires_at > now);

/** Son canlı paketlerde yeniden kurma kanıtı: en yeni `server_ts` (pil ≥ %20 ya da şarjda), yoksa 0. */
async function rearmEvidenceTs(shares: readonly ShareDoc[]): Promise<EpochMs> {
  const vals = await Promise.all(
    shares.map(async (s) => {
      try {
        const v = (await rtdb().ref(livePath(s.receiver_id, s.share_id)).once('value')).val() as Record<string, unknown> | null;
        if (!v || typeof v.server_ts !== 'number') return 0;
        const pct = typeof v.battery_pct === 'number' ? v.battery_pct : null;
        return v.is_charging === true || (pct !== null && pct >= LOW_BATTERY_REARM_PCT) ? v.server_ts : 0;
      } catch {
        return 0;
      }
    }),
  );
  return Math.max(0, ...vals);
}

export async function batteryLowNotify(
  ctx: CallCtx,
  data: z.output<typeof BatteryLowNotifySchema>,
  deps: BatteryDeps = {},
): Promise<BatteryLowNotifyResponse> {
  const send = deps.send ?? sendPushToUser;
  const now = ctx.now;
  const pct = data.battery_pct;
  const charging = data.is_charging ?? null;
  const sessionQuery = db().collection(COL.shares).where('sender_id', '==', ctx.uid).where('session_id', '==', data.session_id);

  // Transaction dışı (yan etkisiz) ön okuma: RTDB kanıtı için oturumun alıcıları.
  const pre = (await sessionQuery.get()).docs.map((d) => d.data() as ShareDoc).filter((s) => isLive(s, now));
  const evidenceTs = pre.length > 0 && pct <= LOW_BATTERY_PCT && charging !== true ? await rearmEvidenceTs(pre) : 0;

  return runOp(ctx, data.op_id, CALLABLES.batteryLowNotify, data, async (tx) => {
    const rate = await readRateLimit(tx, ctx.uid, 'battery_low', LIMITS.batteryCallsPerHour, HOUR, now);
    const snap = await tx.get(sessionQuery);
    const active = snap.docs.map((d) => d.data() as ShareDoc).filter((s) => isLive(s, now));
    if (active.length === 0) throw fail('share_not_active');
    const stateRef = refs.batteryAlert(ctx.uid, data.session_id);
    const [stateSnap, userSnap] = await tx.getAll(stateRef, refs.user(ctx.uid));
    const doc = stateSnap?.data() as BatteryAlertDoc | undefined;
    const name = (userSnap?.data() as UserDoc | undefined)?.display_name ?? '';

    let prev: LowBatteryState | null = doc
      ? { armed: doc.armed, firedAt: doc.fired_at, fired: doc.fired ?? 0, lastPct: doc.last_pct }
      : null;
    // Yedek yeniden kurma: son bildirimden sonra yüksek pil / şarj gösteren canlı paket.
    if (prev && !prev.armed && prev.firedAt !== null && evidenceTs > prev.firedAt) prev = { ...prev, armed: true };

    const decision = lowBatteryTrigger(prev, pct, charging, now);
    let state = decision.state;
    let fire = decision.fire;
    const recent = (doc?.recent_fired_at ?? []).filter((t) => typeof t === 'number' && now - t < DAY);
    if (fire && recent.length >= LIMITS.batteryAlertsPerSessionPerDay) {
      // Günlük tavan: bu düşüş tüketilir, bildirim gitmez.
      fire = false;
      state = { ...state, firedAt: prev?.firedAt ?? null, fired: prev?.fired ?? 0, armed: false };
    }
    if (fire) recent.push(now);

    const wasArmed = prev?.armed ?? true;
    const status: BatteryLowNotifyResponse['status'] = fire
      ? 'notified'
      : state.armed && !wasArmed
        ? 'rearmed'
        : pct <= LOW_BATTERY_PCT && charging !== true
          ? 'suppressed'
          : 'noop';

    writeRateLimit(tx, rate, HOUR);
    tx.set(stateRef, {
      uid: ctx.uid,
      session_id: data.session_id,
      armed: state.armed,
      fired_at: state.firedAt,
      fired: state.fired,
      last_pct: state.lastPct,
      recent_fired_at: recent.slice(-LIMITS.batteryAlertsPerSessionPerDay),
      updated_at: now,
      purge_at: Timestamp.fromMillis(now + LIMITS.batteryAlertTtlMs),
    } satisfies BatteryAlertDoc);

    const response: BatteryLowNotifyResponse = {
      status,
      armed: state.armed,
      receivers: fire ? active.length : 0,
      server_now: now,
    };
    return {
      response,
      after: fire
        ? async () => {
            const res = await Promise.allSettled(active.map((s) => send(s.receiver_id, buildBatteryLowPush(name, pct, s.share_id))));
            const failed = res.filter((r) => r.status === 'rejected').length;
            if (failed) logger.warn('düşük pil bildirimi: bazı alıcılara gönderilemedi', { failed, total: res.length });
          }
        : undefined,
    };
  });
}
