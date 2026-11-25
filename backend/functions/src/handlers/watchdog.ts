/**
 * Faz 3: uzun paylaşımlar için duraksama bekçisi (stall watchdog) + `live_trail` budaması.
 *
 * Kapsam: aktif ve süresi dolmamış paylaşımlardan haftalık / süresiz olanlar ve 8 saatten uzun sürenler
 * (core `LONG_SHARE_MIN_MS`). Her ~15 dk'da bir (`share_stall_watchdog`):
 *  1. Paylaşımın alıcıdaki canlı düğümünden `server_ts` ve `hb` okunur (paket yoksa `started_at`).
 *  2. `now - server_ts > max(4 · hb, 45 dk)` ise paylaşım DURAKSAMIŞTIR (hb yoksa core `DEFAULT_RECEIVER_HB_MS`).
 *  3. Dürtme merdiveni (dönem = aynı `last_seen_ts`; yeni paket dönemi kapatır):
 *       1. kaçırma → gönderenin cihazlarına YALNIZCA veri `resume_tracking` (sessiz, yüksek öncelik);
 *       2. kaçırma (≥ 30 dk sonra hâlâ duraksamış) → ayrıca görünür "Konum paylaşımın duraksadı. Devam etmek için dokun.";
 *       sonrası en erken 6 saatte bir, dönem başına en çok 4 dürtme. Kayıt `location_shares/{id}.stall_nudges`.
 *     Aynı gönderenin birden çok alıcısı varsa tek push gider (oturum kimlikleri birleştirilir).
 *  4. Aynı turda `live_trail/{receiver}/{share_id}` içindeki 24 saatten eski noktalar budanır (anahtarın ilk 13
 *     hanesi zaman: `orderByKey().endAt(...)`). Kısa paylaşımların izi bitişte zaten silinir.
 *
 * Maliyet: tur başına uzun paylaşım başına 1 Firestore okuması + 2 RTDB okuması; yazma yalnızca dürtmede.
 * [Varsayım] Push'un cihazı gerçekten uyandırıp uyandırmadığı platforma bağlıdır (bkz. push.ts `buildResumeTrackingPush`):
 * zorla durdurulmuş (Android) ya da kaydırılarak kapatılmış (iOS) uygulamaya hiçbir push ulaşmaz; görünür bildirim bu
 * durumda kullanıcının tek yoludur. Bu modül firebase-functions tetikleyicisine bağlı değildir (testler doğrudan çağırır).
 */
import { DEFAULT_RECEIVER_HB_MS, type EpochMs, LONG_SHARE_MIN_MS, PACKET_LIMITS, livePath } from '@konum/core';
import type { DocumentSnapshot, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { trailPath } from '../acl';
import { db, rtdb } from '../admin';
import { LIMITS } from '../config';
import { COL, type ShareDoc, type StallNudges } from '../docs';
import { type PushSender, buildResumeTrackingPush, buildTrackingStalledPush, sendPushToUser } from '../push';
import { chunk } from '../util';

export interface StallSweepOptions {
  now?: EpochMs;
  send?: PushSender;
  pageSize?: number;
  maxPages?: number;
  /** 24 saatten eski iz noktalarını buda (varsayılan açık). */
  pruneTrails?: boolean;
}

export interface StallSweepResult {
  checked: number;
  /** Duraksamış paylaşımlar (dürtme gönderilsin ya da gönderilmesin). */
  stalled: string[];
  /** Bu turda dürtme kaydı yazılan paylaşımlar. */
  nudged: string[];
  /** Sessiz / görünür push gönderilen göndericiler. */
  silent_senders: string[];
  visible_senders: string[];
  /** Yeniden yayınlamaya başlayan (dönemi kapanan) paylaşımlar. */
  recovered: string[];
  pruned_trail_points: number;
}

/** 1 = sessiz uyandırma, 2 = sessiz + görünür. */
export type NudgeLevel = 0 | 1 | 2;

/** Saf karar: duraksama eşiği. hb sınır dışıysa varsayılan. */
export function stallThresholdMs(hb: unknown): number {
  const h =
    typeof hb === 'number' && Number.isFinite(hb) && hb >= PACKET_LIMITS.minHeartbeatMs && hb <= PACKET_LIMITS.maxHeartbeatMs
      ? hb
      : DEFAULT_RECEIVER_HB_MS;
  return Math.max(LIMITS.stallHbFactor * h, LIMITS.stallMinMs);
}

/** Uzun paylaşım mı (haftalık, süresiz ya da 8 saatten uzun süren)? */
export const isLongShare = (s: Pick<ShareDoc, 'share_mode' | 'started_at'>, now: EpochMs): boolean =>
  s.share_mode === 'weekly' || s.share_mode === 'indefinite' || now - s.started_at >= LONG_SHARE_MIN_MS;

export interface NudgeDecision {
  stalled: boolean;
  level: NudgeLevel;
  /** Yazılacak yeni kayıt (değişiklik yoksa undefined). */
  next?: StallNudges;
  recovered?: boolean;
}

/** Saf karar fonksiyonu (birim testlenebilir): son paket anı, hb ve mevcut kayıt → dürtme düzeyi. */
export function decideNudge(lastSeenTs: EpochMs, hb: unknown, prev: StallNudges | null | undefined, now: EpochMs): NudgeDecision {
  const stalled = now - lastSeenTs > stallThresholdMs(hb);
  const open = Boolean(prev && prev.last_seen_ts === lastSeenTs && !prev.recovered_at);
  if (!stalled) {
    // Yeni paket geldi: açık dönem kapanır (yalnızca kayıt varsa yazılır).
    if (prev && !prev.recovered_at && prev.last_seen_ts !== lastSeenTs) {
      return { stalled, level: 0, recovered: true, next: { ...prev, recovered_at: now } };
    }
    return { stalled, level: 0 };
  }
  if (!open || !prev) {
    return { stalled, level: 1, next: { count: 1, visible: 0, first_at: now, last_at: now, last_seen_ts: lastSeenTs, recovered_at: null } };
  }
  if (prev.count >= LIMITS.stallMaxNudgesPerEpisode) return { stalled, level: 0 };
  const since = now - prev.last_at;
  const due = prev.visible === 0 ? since >= LIMITS.stallVisibleAfterMs : since >= LIMITS.stallRepeatMs;
  if (!due) return { stalled, level: 0 };
  return { stalled, level: 2, next: { ...prev, count: prev.count + 1, visible: prev.visible + 1, last_at: now } };
}

/** Sorguyu sayfa sayfa okur (belge kimliğine göre sıralı). */
async function pagedDocs(base: Query, pageSize: number, maxPages: number, orderField: string): Promise<QueryDocumentSnapshot[]> {
  const out: QueryDocumentSnapshot[] = [];
  let last: DocumentSnapshot | undefined;
  for (let page = 0; page < maxPages; page++) {
    let q = base.orderBy(orderField).limit(pageSize);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    out.push(...snap.docs);
    if (snap.size < pageSize) break;
    last = snap.docs[snap.docs.length - 1];
  }
  return out;
}

/** 13 haneli zaman önekli iz anahtarı için "bu ana kadar" üst sınırı. */
const trailCutoffKey = (ts: EpochMs): string => `${String(Math.max(0, Math.floor(ts))).padStart(13, '0')}-999`;

async function pruneTrail(receiverId: string, shareId: string, now: EpochMs): Promise<number> {
  const ref = rtdb().ref(trailPath(receiverId, shareId));
  const snap = await ref.orderByKey().endAt(trailCutoffKey(now - LIMITS.trailMaxAgeMs)).limitToFirst(500).once('value');
  const update: Record<string, null> = {};
  snap.forEach((c) => {
    if (c.key) update[c.key] = null;
  });
  const n = Object.keys(update).length;
  if (n > 0) await ref.update(update);
  return n;
}

export async function sweepStalls(opts: StallSweepOptions = {}): Promise<StallSweepResult> {
  const now = opts.now ?? Date.now();
  const send = opts.send ?? sendPushToUser;
  const pageSize = opts.pageSize ?? LIMITS.stallPageSize;
  const maxPages = opts.maxPages ?? LIMITS.stallMaxPages;
  const result: StallSweepResult = {
    checked: 0,
    stalled: [],
    nudged: [],
    silent_senders: [],
    visible_senders: [],
    recovered: [],
    pruned_trail_points: 0,
  };

  // --- adaylar: (status, share_mode ∈ {weekly, indefinite}) ∪ (status, started_at ≤ now - 8 sa) ---
  const shares = db().collection(COL.shares);
  const [byMode, byAge] = await Promise.all([
    pagedDocs(shares.where('status', '==', 'active').where('share_mode', 'in', ['weekly', 'indefinite']), pageSize, maxPages, 'started_at'),
    pagedDocs(shares.where('status', '==', 'active').where('started_at', '<=', now - LONG_SHARE_MIN_MS), pageSize, maxPages, 'started_at'),
  ]);
  const cands = new Map<string, QueryDocumentSnapshot>();
  for (const d of [...byMode, ...byAge]) {
    const s = d.data() as ShareDoc;
    if (s.status !== 'active' || (s.expires_at !== null && s.expires_at <= now) || !isLongShare(s, now)) continue;
    cands.set(d.id, d);
  }

  // --- gönderen başına toplanan push kararları ---
  const perSender = new Map<string, { level: NudgeLevel; sessions: Set<string> }>();

  for (const part of chunk([...cands.values()], 50)) {
    await Promise.all(
      part.map(async (d) => {
        const s = d.data() as ShareDoc;
        result.checked++;
        try {
          const live = (await rtdb().ref(livePath(s.receiver_id, s.share_id)).once('value')).val() as Record<string, unknown> | null;
          const lastSeen = typeof live?.server_ts === 'number' ? live.server_ts : s.started_at;
          const decision = decideNudge(lastSeen, live?.hb, s.stall_nudges ?? null, now);
          if (decision.stalled) result.stalled.push(s.share_id);
          if (decision.next) {
            try {
              // Önkoşul: sorgudan beri belge değişmediyse (ör. arada bitirildiyse yazma düşer, push da gitmez).
              await d.ref.update({ stall_nudges: decision.next }, { lastUpdateTime: d.updateTime });
            } catch (err) {
              logger.debug('bekçi: dürtme kaydı yazılamadı (belge değişti)', { share_id: s.share_id, err: String(err) });
              return;
            }
            if (decision.recovered) result.recovered.push(s.share_id);
            if (decision.level > 0) {
              result.nudged.push(s.share_id);
              const cur = perSender.get(s.sender_id) ?? { level: 0 as NudgeLevel, sessions: new Set<string>() };
              cur.level = Math.max(cur.level, decision.level) as NudgeLevel;
              cur.sessions.add(s.session_id);
              perSender.set(s.sender_id, cur);
            }
          }
          if (opts.pruneTrails ?? true) {
            // Önce bekle, sonra topla: `x += await f()` eşzamanlı görevlerde x'i await'ten ÖNCE okur (kayıp güncelleme).
            const pruned = await pruneTrail(s.receiver_id, s.share_id, now);
            result.pruned_trail_points += pruned;
          }
        } catch (err) {
          logger.error('bekçi: paylaşım denetlenemedi', { share_id: s.share_id, err: String(err) });
        }
      }),
    );
  }

  // --- push (en iyi çaba; kayıt önce yazıldığı için hata tekrar yağmuru yaratmaz) ---
  for (const part of chunk([...perSender.entries()], 20)) {
    await Promise.all(
      part.map(async ([uid, p]) => {
        const sessions = [...p.sessions].sort();
        try {
          await send(uid, buildResumeTrackingPush(sessions, p.level, now));
          result.silent_senders.push(uid);
          if (p.level >= 2) {
            await send(uid, buildTrackingStalledPush(sessions));
            result.visible_senders.push(uid);
          }
        } catch (err) {
          logger.warn('bekçi: push gönderilemedi', { err: String(err) });
        }
      }),
    );
  }
  return result;
}
