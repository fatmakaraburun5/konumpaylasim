/**
 * Faz 9: 200 m yaklaşma — "Neredeyse vardım (1 dk)" (docs/PHASE9.md §2, core `approach.ts`).
 *
 * `approach_report`: algılama cihazdadır (`approachReduce`); cihaz tek seferlik tetikte etkin paylaşım oturumlarını,
 * koordinatsız hedef anahtarını (`dest_key`) ve ADINI bildirir. Sunucu:
 *  - Onay kapısı (callable + `readCaller`), saatte `APPROACH_LIMITS.perHour` rapor (`rate_limited`).
 *  - Görünmezken `invisible`, 2 dk'dan eski (ya da ileri tarihli) rapor `stale` (push yok, kayıt yok).
 *  - TEK SEFER: her oturum için `approach_marks/{uid}_{session}_{dest_key}` transaction'da `create` (48 sa TTL). Yalnızca
 *    YENİ işaretlenen ve gönderenin şu an etkin (süresi dolmamış) paylaşımı olan oturumların alıcılarına push gider;
 *    hepsi zaten işaretliyse `already_sent`. Etkin paylaşımı olmayan oturum işaretlenmez (yok sayılır).
 *  - Alıcılar: o oturumların etkin paylaşım alıcıları (canlı konumu zaten görüyorlar) ve `privacy.movement_alerts`
 *    tercihini kapatmamış olanlar; hiç kalmazsa `no_recipients` (işaret yine yazılır: harita durumu paketten güncellenir).
 *  - Push: core `approachPushText`, Faz 7 `movement` kanalı, TTL 5 dk; koordinat YOK (yalnızca hedef adı ve ETA).
 */
import {
  APPROACH_LIMITS,
  type ApproachReportRequestSchema,
  type ApproachReportResponse,
  CALLABLES,
  HOUR,
  type UserId,
  isInvisible,
  parsePrivacy,
  sanitizeDestName,
} from '@konum/core';
import { Timestamp } from 'firebase-admin/firestore';
import type { z } from 'zod';
import { db } from '../admin';
import type { CallCtx } from '../callable';
import { type ApproachMarkDoc, COL, type ShareDoc, type UserDoc, refs } from '../docs';
import { readCaller } from '../graph';
import { readRateLimit, runOp, writeRateLimit } from '../ops';
import { type PushSender, buildApproachPush, sendPushToUser } from '../push';
import { assertDocId, unique } from '../util';
import { pushAll } from './sos';

export interface ApproachDeps {
  send?: PushSender;
}

export async function approachReport(ctx: CallCtx, data: z.output<typeof ApproachReportRequestSchema>, deps: ApproachDeps = {}): Promise<ApproachReportResponse> {
  const send = deps.send ?? sendPushToUser;
  const now = ctx.now;
  const sessions = unique(data.session_ids);
  for (const sid of sessions) assertDocId(sid, 'session_ids');
  const destName = sanitizeDestName(data.dest_name);
  const done = (status: ApproachReportResponse['status'], n = 0): ApproachReportResponse => ({ status, notified_count: n, server_now: now });

  return runOp(ctx, data.op_id, CALLABLES.approachReport, data, async (tx) => {
    const me = await readCaller(tx, ctx.uid);
    const rate = await readRateLimit(tx, ctx.uid, 'approach_report', APPROACH_LIMITS.perHour, HOUR, now);
    const markRefs = sessions.map((sid) => refs.approachMark(ctx.uid, sid, data.dest_key));
    const marks = await tx.getAll(...markRefs);
    const sharesSnap = await tx.get(db().collection(COL.shares).where('sender_id', '==', ctx.uid).where('status', '==', 'active'));
    const live = sharesSnap.docs
      .map((d) => d.data() as ShareDoc)
      .filter((s) => s.sender_id === ctx.uid && s.status === 'active' && (s.expires_at === null || s.expires_at > now) && sessions.includes(s.session_id));
    const fresh = sessions.filter((sid, i) => !marks[i]?.exists && live.some((s) => s.session_id === sid));
    const receivers = unique(live.filter((s) => fresh.includes(s.session_id)).map((s) => s.receiver_id));
    const recvSnaps = receivers.length ? await tx.getAll(...receivers.map((u) => refs.user(u))) : [];
    // --- yazmalar ---
    writeRateLimit(tx, rate, HOUR);

    if (isInvisible(me)) return { response: done('invisible') };
    if (now - data.at > APPROACH_LIMITS.maxReportAgeMs || data.at > now + APPROACH_LIMITS.maxReportAgeMs) return { response: done('stale') };
    if (fresh.length === 0) return { response: done(marks.some((m) => m.exists) ? 'already_sent' : 'no_recipients') };

    for (const sid of fresh) {
      const mark: ApproachMarkDoc = {
        uid: ctx.uid,
        session_id: sid,
        dest_key: data.dest_key,
        created_at: now,
        purge_at: Timestamp.fromMillis(now + APPROACH_LIMITS.markTtlMs),
      };
      tx.create(refs.approachMark(ctx.uid, sid, data.dest_key), mark);
    }
    const to: UserId[] = receivers.filter((_, i) => parsePrivacy((recvSnaps[i]?.data() as UserDoc | undefined)?.privacy).movement_alerts);
    if (to.length === 0) return { response: done('no_recipients') };
    const msg = buildApproachPush(me.display_name ?? '', ctx.uid, destName, data.eta_min, data.distance_m, now);
    return { response: done('sent', to.length), after: () => pushAll(to, msg, send, 'approach_report') };
  });
}

/** Hesap silme: kullanıcının tek sefer kayıtları (`uid` alanı; tek alanlı otomatik dizin). */
export async function deleteApproachMarksOf(uid: UserId): Promise<number> {
  const snap = await db().collection(COL.approachMarks).where('uid', '==', uid).get();
  if (snap.empty) return 0;
  const writer = db().bulkWriter();
  for (const d of snap.docs) void writer.delete(d.ref);
  await writer.close();
  return snap.size;
}
