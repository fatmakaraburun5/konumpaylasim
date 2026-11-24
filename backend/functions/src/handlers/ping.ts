/**
 * Faz 4: `ping_send` — tek dokunuşla "Buradayım / Yoldayım".
 *
 * Akış: Firestore transaction'ında arkadaşlık (kabul edilmiş + iki yönde engel yok) ve hız sınırları doğrulanır,
 * op kaydı yazılır → commit sonrası RTDB'ye çok yollu tek yazma: alıcının kutusu `ping_inbox/{to}/{ping_id}` (yalnızca
 * alıcı okur ve siler) + sunucu dizini `ping_expiry/{ping_id}` (süpürücü) → alıcıya görünür push (koordinat YOK).
 *
 *  - Arkadaş değil, engelli ya da kendisi: hepsi AYNI `not_friends` (hedefin varlığı / engel bilgisi sızmaz).
 *  - Soğuma: aynı alıcıya `PING_LIMITS.perPairCooldownMs` içinde ikinci ping ve saatte `perUserPerHour` üstü →
 *    `rate_limited` (`retry_after_ms` ile).
 *  - Konum `maxLocationAgeMs`'den eskiyse hata değil: ping konumsuz gider. Gelecekteki zaman damgası sunucu saatine
 *    kırpılır. `eta_s` yalnızca "Yoldayım"da anlamlıdır ([Varsayım] "Buradayım"da atılır).
 *  - `ping_id` = sha256(uid | op_id): aynı op_id tekrarında (yanıt kaybolduysa) RTDB'ye AYNI kayıt yeniden yazılır
 *    (idempotent; ilk yazma kaybolduysa onarır), push yalnızca ilk çalıştırmada gider. [Varsayım] Alıcı bu arada
 *    kaydı sildiyse tekrar (yalnızca istemci yeniden denemesinde) onu geri getirir; süre en çok 15 dk.
 *  - Push başarısızlığı callable'ı bozmaz.
 */
import { CALLABLES, HOUR, PING_LIMITS, type Ping, type PingSendRequestSchema, type PingSendResponse, type EpochMs } from '@konum/core';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { rtdb } from '../admin';
import type { CallCtx } from '../callable';
import { LIMITS } from '../config';
import { RTDB_F4, type PingExpiryEntry } from '../docs';
import { fail } from '../errors';
import { canShare, readCaller, readPairStates } from '../graph';
import { readRateLimit, runOp, writeRateLimit } from '../ops';
import { type PushSender, buildPingPush, sendPushToUser } from '../push';
import { assertUid, isServerUid, sha256Hex } from '../util';

export interface PingDeps {
  send?: PushSender;
}

type PingInput = z.output<typeof PingSendRequestSchema>;

/** Kayıt (null alanlar yazılmaz: RTDB null saklamaz, okuyucu `parsePing` eksikleri null yapar). */
export function pingRecord(uid: string, data: PingInput, pingId: string, sentAt: EpochMs): Ping {
  let location = data.location ?? null;
  if (location) {
    const ts = Math.min(location.timestamp, sentAt);
    location = sentAt - ts > PING_LIMITS.maxLocationAgeMs ? null : { ...location, timestamp: ts };
  }
  return {
    ping_id: pingId,
    from: uid,
    kind: data.kind,
    sent_at: sentAt,
    expires_at: sentAt + PING_LIMITS.ttlMs,
    location,
    eta_s: data.kind === 'on_way' ? (data.eta_s ?? null) : null,
  };
}

const withoutNulls = (p: Ping): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (v !== null && v !== undefined) out[k] = v;
  return out;
};

export async function pingSend(ctx: CallCtx, data: PingInput, deps: PingDeps = {}): Promise<PingSendResponse> {
  const send = deps.send ?? sendPushToUser;
  assertUid(data.to, 'to');
  const pingId = sha256Hex(`ping|${ctx.uid}|${data.op_id}`).slice(0, 24);
  let fresh: { name: string } | null = null;

  const response = await runOp(ctx, data.op_id, CALLABLES.pingSend, data, async (tx) => {
    fresh = null;
    const me = await readCaller(tx, ctx.uid);
    if (data.to === ctx.uid) throw fail('not_friends');
    const [pair] = await readPairStates(tx, ctx.uid, [data.to]);
    if (!pair || !canShare(pair)) throw fail('not_friends');
    const pairRate = await readRateLimit(tx, ctx.uid, `ping_${data.to}`, 1, PING_LIMITS.perPairCooldownMs, ctx.now);
    const hourRate = await readRateLimit(tx, ctx.uid, 'ping', PING_LIMITS.perUserPerHour, HOUR, ctx.now);
    writeRateLimit(tx, pairRate, PING_LIMITS.perPairCooldownMs);
    writeRateLimit(tx, hourRate, HOUR);
    fresh = { name: me.display_name ?? '' };
    const r: PingSendResponse = { ping_id: pingId, expires_at: ctx.now + PING_LIMITS.ttlMs, server_now: ctx.now };
    return { response: r };
  });

  // Commit sonrası (ilk çalıştırma ve tekrar): kayıt aynı yola yazılır. Süresi geçmişse yazılmaz.
  const rec = pingRecord(ctx.uid, data, response.ping_id, response.server_now);
  if (rec.expires_at > Date.now()) {
    try {
      await rtdb()
        .ref()
        .update({
          [RTDB_F4.ping(data.to, rec.ping_id)]: withoutNulls(rec),
          [RTDB_F4.pingExpiry(rec.ping_id)]: { to: data.to, from: ctx.uid, expires_at: rec.expires_at } satisfies PingExpiryEntry,
        });
    } catch (err) {
      // Op kaydı yazıldı; istemci aynı op_id ile tekrar denerse kayıt yeniden yazılır.
      logger.error('ping_send: RTDB yazılamadı', { err: String(err) });
      throw fail('unavailable');
    }
  }

  const first = fresh as { name: string } | null;
  if (first) {
    try {
      await send(data.to, buildPingPush(first.name, rec, ctx.now));
    } catch (err) {
      logger.warn('ping_send: push gönderilemedi', { err: String(err) });
    }
  }
  return response;
}

// ---------------------------------------------------------------------------
// Bakım: süresi geçen pingler ve hesap silme
// ---------------------------------------------------------------------------

/** Süresi geçen pingleri alıcı kutusundan ve dizinden siler (`ping_expiry` `.indexOn: expires_at`). */
export async function sweepExpiredPings(now: EpochMs, max: number = LIMITS.f4SweepMax): Promise<number> {
  const snap = await rtdb().ref(RTDB_F4.pingExpiryRoot).orderByChild('expires_at').endAt(now).limitToFirst(max).once('value');
  const update: Record<string, null> = {};
  let n = 0;
  snap.forEach((c) => {
    const v = c.val() as Partial<PingExpiryEntry> | null;
    if (!c.key) return;
    update[RTDB_F4.pingExpiry(c.key)] = null;
    if (v && typeof v.to === 'string' && isServerUid(v.to)) update[RTDB_F4.ping(v.to, c.key)] = null;
    n++;
  });
  if (n > 0) await rtdb().ref().update(update);
  return n;
}

/** Hesap silme: kullanıcının ping kutusu ve GÖNDERDİĞİ (henüz süresi geçmemiş) pingler silinir. */
export async function deletePingsOf(uid: string): Promise<void> {
  const sent = await rtdb().ref(RTDB_F4.pingExpiryRoot).orderByChild('from').equalTo(uid).once('value');
  const update: Record<string, null> = { [RTDB_F4.pingInbox(uid)]: null };
  sent.forEach((c) => {
    const v = c.val() as Partial<PingExpiryEntry> | null;
    if (!c.key) return;
    update[RTDB_F4.pingExpiry(c.key)] = null;
    if (v && typeof v.to === 'string' && isServerUid(v.to)) update[RTDB_F4.ping(v.to, c.key)] = null;
  });
  await rtdb().ref().update(update);
}
