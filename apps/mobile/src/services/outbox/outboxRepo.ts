/**
 * Faz 3: çevrimdışı kuyruk deposu (kalıcı, kilitli) ve boşaltıcı (core `planFlush`).
 *
 * Ne zaman kuyruğa girer (pipeline):
 *  - `shouldPublish` "gönder" dedi ama RTDB bağlantısı yok (tünel, bodrum, kırsal yol),
 *  - ya da yazma başarısız / zaman aşımı (`failed`).
 * Ne zaman boşalır:
 *  - RTDB `.info/connected` true olduğunda (sharingCoordinator), her konum görevi uyanışında (çevrimiçiyse,
 *    taze yayından ÖNCE: kuyruktaki eski nokta canlı düğümdeki yeni noktayı ezemez) ve ön plana dönüşte.
 * Nasıl:
 *  1. Bitmiş / durdurulmuş / süresi dolmuş hedeflerin noktaları ve bitişten sonra kaydedilenler YAZILMADAN silinir.
 *  2. Hedef başına en yeni nokta canlı düğüme `q: 1` + `recorded_at` ile (arkadaşlar ve bağlantılar AYRI yazma);
 *     alıcıda son doğrulanmış konum anında düzelir. Bilinen son canlı yazmadan (`lastLiveTs`) eski olan yazılmaz.
 *  3. Tüm noktalar `live_trail/{alıcı}/{share_id}/{point_id}` iz düğümüne ≤ 200 yollu partilerle (bağlantılara iz yok).
 *     Parti başarılıysa noktaları kuyruktan silinir (idempotent: aynı yol üstüne yazılır).
 *  4. Bekleyen callable'lar (düşük pil bildirimi) aynı op_id ile.
 *  5. Hata → üstel geri çekilme (`flushBackoffMs`); `force` (bağlantı yeni geldi) beklemeyi atlar.
 * Kesme anahtarı (`isAllowed`) HER yazmadan hemen önce sorulur: "Durdur" sonrası kuyruktan veri gitmez.
 */
import {
  ackOutbox,
  enqueueOutbox,
  flushBackoffMs,
  linkLivePath,
  livePath,
  outboxTargetId,
  planFlush,
  toQueuedDeliveredWrite,
  toQueuedLinkWrite,
  trailBatchUpdate,
  type EpochMs,
  type OutboxSample,
  type OutboxState,
  type OutboxTarget,
  type UserId,
} from '@konum/core';
import { emptyPersisted, getOutboxStore, type OutboxStore, type PendingCall, type PersistedOutbox } from './outboxStore';

export type ShareOutboxTarget = Extract<OutboxTarget, { kind: 'share' }>;
export type LinkOutboxTarget = Extract<OutboxTarget, { kind: 'link' }>;

export interface FlushDeps {
  uid: UserId;
  now: EpochMs;
  /** Sunucunun hâlâ etkin dediği hedefler (süresi dolmuş/durdurulmuş olanlar çıkarılmış). */
  targets: readonly OutboxTarget[];
  /** Kesme anahtarı: yazmadan hemen önce. */
  isAllowed: (t: OutboxTarget) => boolean;
  /** Tek atomik çok yollu RTDB yazması (liveRepo.writeFanout). */
  write: (map: Record<string, unknown>) => Promise<void>;
  /** Bekleyen callable çağrısı: 'retry' kalır (deneme sayısı artar), 'drop' kalıcı hata (atılır). */
  call?: (c: PendingCall) => Promise<'ok' | 'retry' | 'drop'>;
  /** Alıcı canlı düğümündeki en yeni bilinen nokta (taze yayının timestamp'i). */
  lastLiveTs?: EpochMs | null;
  /** Geri çekilme beklemesini atla (bağlantı yeni geldi). */
  force?: boolean;
  rand?: () => number;
}

export type FlushResult =
  | { status: 'empty' | 'backoff'; synced: 0; dropped: number; pending: number }
  | { status: 'ok' | 'partial'; synced: number; dropped: number; pending: number; liveTs: EpochMs | null; error?: unknown };

export interface OutboxRepo {
  enqueue: (uid: UserId, sample: OutboxSample, targets: readonly OutboxTarget[], now: EpochMs) => Promise<number>;
  queueCall: (uid: UserId, call: Omit<PendingCall, 'attempts'>) => Promise<void>;
  flush: (deps: FlushDeps) => Promise<FlushResult>;
  /** Belirli hedeflerin noktalarını hemen sil (Durdur); hedefi kalmayan nokta da silinir. */
  dropTargets: (targetIds: readonly string[]) => Promise<number>;
  /** Tüm kuyruk (çıkış / paylaşım bitti). */
  purge: () => Promise<void>;
  pendingCount: () => Promise<number>;
  load: () => Promise<PersistedOutbox>;
}

/** [Varsayım] Bekleyen callable en çok bu kadar yaşar (ör. düşük pil bildirimi 6 sa sonra anlamsız). */
export const PENDING_CALL_MAX_AGE_MS = 6 * 60 * 60_000;
export const PENDING_CALL_MAX_ATTEMPTS = 20;

export function createOutboxRepo(storeFn: () => OutboxStore = getOutboxStore): OutboxRepo {
  let lock: Promise<unknown> = Promise.resolve();
  /** Son bilinen bekleyen iş sayısı (nokta + callable; null = bilinmiyor → depodan oku). */
  let cachedCount: number | null = null;
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };

  const loadFor = async (store: OutboxStore, uid: UserId | null): Promise<{ prev: PersistedOutbox; cur: PersistedOutbox }> => {
    const prev = await store.load();
    // Başka hesabın kuyruğu: hiçbir şey göndermeden sil.
    if (uid !== null && prev.meta.uid !== null && prev.meta.uid !== uid) {
      await store.clear();
      const fresh = emptyPersisted();
      return { prev: fresh, cur: { ...fresh, meta: { ...fresh.meta, uid } } };
    }
    return { prev, cur: { ...prev, meta: { ...prev.meta, uid: uid ?? prev.meta.uid } } };
  };

  const commit = async (store: OutboxStore, prev: PersistedOutbox, next: PersistedOutbox) => {
    await store.save(prev, next);
    cachedCount = next.state.points.length + next.meta.calls.length;
  };

  return {
    load: () => locked(() => storeFn().load()),

    enqueue: (uid, sample, targets, now) =>
      locked(async () => {
        const store = storeFn();
        const { prev, cur } = await loadFor(store, uid);
        const state = enqueueOutbox(cur.state, sample, targets, now);
        await commit(store, prev, { ...cur, state });
        return state.points.length;
      }),

    queueCall: (uid, call) =>
      locked(async () => {
        const store = storeFn();
        const { prev, cur } = await loadFor(store, uid);
        if (cur.meta.calls.some((c) => c.op_id === call.op_id)) return;
        await commit(store, prev, { ...cur, meta: { ...cur.meta, calls: [...cur.meta.calls, { ...call, attempts: 0 }] } });
      }),

    dropTargets: (targetIds) =>
      locked(async () => {
        if (targetIds.length === 0) return 0;
        const store = storeFn();
        const prev = await store.load();
        const drop = new Set(targetIds);
        let removed = 0;
        const points = [];
        for (const p of prev.state.points) {
          const keep = p.target_ids.filter((id) => !drop.has(id));
          if (keep.length === 0) {
            removed++;
            continue;
          }
          points.push(keep.length === p.target_ids.length ? p : { ...p, target_ids: keep });
        }
        if (removed === 0 && points.every((p, i) => p === prev.state.points[i])) return 0;
        await commit(store, prev, { ...prev, state: { ...prev.state, points } });
        return removed;
      }),

    purge: () =>
      locked(async () => {
        await storeFn().clear();
        cachedCount = 0;
      }),

    pendingCount: () =>
      locked(async () => {
        if (cachedCount !== null) return cachedCount;
        const loaded = await storeFn().load();
        cachedCount = loaded.state.points.length + loaded.meta.calls.length;
        return cachedCount;
      }),

    flush: (deps) =>
      locked(async () => {
        const store = storeFn();
        const { prev, cur } = await loadFor(store, deps.uid);
        const freshCalls = cur.meta.calls.filter((c) => deps.now - c.created_at <= PENDING_CALL_MAX_AGE_MS && c.attempts < PENDING_CALL_MAX_ATTEMPTS);
        if (cur.state.points.length === 0 && freshCalls.length === 0) {
          if (cur.meta.calls.length || cur.meta.attempt) await commit(store, prev, { ...cur, meta: { ...cur.meta, calls: [], attempt: 0, nextAttemptAt: null } });
          return { status: 'empty', synced: 0, dropped: 0, pending: 0 };
        }
        if (!deps.force && cur.meta.nextAttemptAt !== null && deps.now < cur.meta.nextAttemptAt) {
          return { status: 'backoff', synced: 0, dropped: 0, pending: cur.state.points.length };
        }

        const lastLive = deps.lastLiveTs ?? null;
        const active = deps.targets.filter(deps.isAllowed).map((t) => ({ ...t, last_live_ts: lastLive ?? t.last_live_ts ?? null }));
        const plan = planFlush(cur.state, active, deps.now);
        let state: OutboxState = ackOutbox(cur.state, plan.drop);
        let failed = false;
        let error: unknown;
        let synced = 0;
        let liveTs: EpochMs | null = null;

        // 2) Canlı düğümler: arkadaşlar ve bağlantılar ayrı (birinin reddi diğerini düşürmesin).
        const friendLive: Record<string, unknown> = {};
        const linkLive: Record<string, unknown> = {};
        let friendLiveTs = -Infinity;
        let linkLiveTs = -Infinity;
        for (const w of plan.liveWrites) {
          if (!deps.isAllowed(w.target)) continue;
          if (w.target.kind === 'share') {
            friendLive[livePath(w.target.receiver_id, w.target.share_id)] = toQueuedDeliveredWrite(w.point, w.target, deps.uid);
            friendLiveTs = Math.max(friendLiveTs, w.point.timestamp);
          } else {
            linkLive[linkLivePath(w.target.token_hash)] = toQueuedLinkWrite(w.point, w.target);
            linkLiveTs = Math.max(linkLiveTs, w.point.timestamp);
          }
        }
        const tryWrite = async (map: Record<string, unknown>): Promise<boolean> => {
          if (Object.keys(map).length === 0) return true;
          try {
            await deps.write(map);
            return true;
          } catch (e) {
            failed = true;
            error = e;
            return false;
          }
        };
        if (await tryWrite(friendLive)) {
          if (Number.isFinite(friendLiveTs)) liveTs = friendLiveTs;
        }
        if (await tryWrite(linkLive)) {
          if (Number.isFinite(linkLiveTs)) liveTs = Math.max(liveTs ?? -Infinity, linkLiveTs);
          // Yalnızca bağlantı hedefli noktaların işi canlı yazmayla biter (bağlantılara iz yok).
          state = ackOutbox(state, plan.liveOnlyPointIds);
        }

        // 3) İz partileri (sırayla; ilk hatada dur, kalan sonraki boşaltmaya).
        for (const batch of plan.trailBatches) {
          const allowed = batch.writes.filter((w) => deps.isAllowed(w.target));
          if (allowed.length === 0) {
            state = ackOutbox(state, batch.pointIds);
            continue;
          }
          const map = trailBatchUpdate({ writes: allowed, pointIds: batch.pointIds });
          try {
            await deps.write(map);
            state = ackOutbox(state, batch.pointIds);
            synced += batch.pointIds.length;
          } catch (e) {
            failed = true;
            error = e;
            // Kural reddi (paylaşım bitti / ACL aynası gecikti) ya da ağ hatası: kalan partiler sonraki boşaltmada
            // yeniden planlanır (bitmiş hedefin noktaları o zaman `drop` olur).
            break;
          }
        }

        // 4) Bekleyen callable'lar.
        const calls: PendingCall[] = [];
        for (const c of freshCalls) {
          if (!deps.call) {
            calls.push(c);
            continue;
          }
          let r: 'ok' | 'retry' | 'drop';
          try {
            r = await deps.call(c);
          } catch {
            r = 'retry';
          }
          if (r === 'retry') {
            failed = true;
            calls.push({ ...c, attempts: c.attempts + 1 });
          }
        }

        const attempt = failed ? cur.meta.attempt + 1 : 0;
        const next: PersistedOutbox = {
          state,
          meta: {
            ...cur.meta,
            calls,
            attempt,
            nextAttemptAt: failed ? deps.now + flushBackoffMs(attempt - 1, deps.rand) : null,
            synced: cur.meta.synced + synced,
          },
        };
        await commit(store, prev, next);
        return {
          status: failed ? 'partial' : 'ok',
          synced,
          dropped: plan.drop.length,
          pending: state.points.length,
          liveTs,
          ...(failed ? { error } : {}),
        };
      }),
  };
}

/** Uygulama genelinde tek kuyruk (konum hattı, koordinatör, çıkış temizliği). */
export const outboxRepo: OutboxRepo = createOutboxRepo();

export { outboxTargetId };
