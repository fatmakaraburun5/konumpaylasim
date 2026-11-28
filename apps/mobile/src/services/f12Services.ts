/**
 * Faz 12 oturum servisleri (sharingCoordinator `startSessionServices` içinden):
 *
 *   sharingStore (onaylı giden paylaşımlar)        → shareHistoryStore.record (cihazdaki sık kişiler geçmişi)
 *   sharingStore + breakStore + görünmez + ETA      → kilit ekranı canlı sayacı (core `planLiveActivity` → liveSink)
 *   30 sn'lik nabız                                  → son 5 dk geçişi, "sona erdi" kartının kalkması, mola bitişi
 *   Görünmez Ol / tüm paylaşımlar bitti / yeni paylaşım başladı → mola biter
 *   çıkış                                            → canlı sayaç HEMEN kalkar, mola + geçmiş bellekten silinir
 *
 * Kilit ekranı kartı, kitapçıktaki öndeki kartla aynı kişiyi gösterir (en kısa süresi kalan paylaşım).
 */
import {
  applyLiveOp,
  buildLiveShareContent,
  endReasonOf,
  isOnBreak,
  MINUTE,
  planLiveActivity,
  selectSessions,
  uuidV4,
  type LiveEndReason,
  type LiveRuntime,
  type LiveShareSession,
  type ShareHistoryEntry,
  type UserId,
} from '@konum/core';
import { now as serverClockNow } from '../lib/clock';
import { breakStore, setBreakResumeHook } from '../state/breakStore';
import { friendsStore, selectFriends } from '../state/friendsStore';
import { invisibleStore, selectIsInvisible } from '../state/invisibleStore';
import { liveEtaStore } from '../state/liveEtaStore';
import { shareHistoryStore } from '../state/shareHistoryStore';
import { sharingStore } from '../state/sharingStore';
import { liveSink } from './live/liveActivityBridge';
import { saveAvatar } from './widgets/widgetBridge';
import { downloadWidgetAvatar } from './widgets/widgetAvatarFiles';

const LIVE_RUNNING = new Set(['active', 'expiring_soon', 'extending']);
const PULSE_MS = 30_000;

export interface F12Deps {
  /** Mola bitince hemen bir paket (koordinatörün tek ölçüm + yayın kancası). */
  publishNow: () => void;
}

/** Onaylı, süren arkadaş paylaşım oturumları (canlı sayaç girdisi). Saf okuma. */
export function liveSessionsNow(): LiveShareSession[] {
  return selectSessions(sharingStore.getState().state)
    .filter((s) => s.confirmed && LIVE_RUNNING.has(s.phase) && s.active_receiver_ids.length > 0)
    .map((s) => ({ session_id: s.session_id, started_at: s.started_at, expires_at: s.expires_at, receiver_ids: [...s.active_receiver_ids] }));
}

/** Giden paylaşımlar → geçmiş kayıtları (alıcı başına, `share_id` tekil). */
export function historyEntriesFrom(shares: Record<string, { share_id: string; receiver_id: UserId; status: string; started_at: number; expires_at: number | null }>): ShareHistoryEntry[] {
  return Object.values(shares)
    .filter((s) => s.status === 'active')
    .map((s) => ({
      share_id: s.share_id,
      receiver_id: s.receiver_id,
      started_at: s.started_at,
      minutes: s.expires_at === null ? null : Math.max(1, Math.round((s.expires_at - s.started_at) / MINUTE)),
    }));
}

// --- canlı sayaç durumu (modül düzeyi: çıkışta da kapatılabilsin) ----------------------------------------------

let rt: LiveRuntime = { active: null, dismiss_at: null };
let lastSessions: LiveShareSession[] = [];
let queue: Promise<unknown> = Promise.resolve();
const avatarReady = new Map<UserId, string | null>();

export function liveRuntime(): LiveRuntime {
  return rt;
}

function avatarKeyFor(uid: UserId, url: string | null): string | null {
  if (!url) return null;
  const have = avatarReady.get(uid);
  if (have !== undefined) return have;
  avatarReady.set(uid, null);
  void (async () => {
    const local = await downloadWidgetAvatar(`live_${uid}`, url);
    const saved = local ? await saveAvatar(`live_${uid}`, local).catch(() => null) : null;
    avatarReady.set(uid, saved ? `live_${uid}` : null);
    if (saved) syncLiveActivity();
  })().catch(() => undefined);
  return null;
}

/** Durum → yerel çağrı (sıralı; çift başlatma olmaz). */
export function syncLiveActivity(forced: LiveEndReason | null = null): Promise<unknown> {
  const run = queue.then(async () => {
    const now = serverClockNow();
    const invisible = selectIsInvisible(invisibleStore.getState());
    const brk = breakStore.getState().brk;
    const sessions = forced ? [] : liveSessionsNow();
    const byId = new Map(selectFriends(friendsStore.getState()).map((f) => [f.uid, f]));
    const next = forced
      ? null
      : buildLiveShareContent({
          sessions,
          people: (uid) => {
            const f = byId.get(uid);
            return f ? { name: f.displayName, gender: f.gender, avatar_key: avatarKeyFor(uid, f.avatarThumbUrl ?? f.avatarUrl) } : null;
          },
          breakUntil: isOnBreak(brk, now) ? brk.until : null,
          invisible,
          eta: liveEtaStore.getState().eta,
          now,
        });
    const reason: LiveEndReason | null = next ? null : (forced ?? (invisible ? 'invisible' : endReasonOf(lastSessions, now)));
    if (sessions.length) lastSessions = sessions;
    const op = planLiveActivity({ rt, next, reason, now, newId: uuidV4 });
    const sink = liveSink();
    switch (op.op) {
      case 'none':
        return;
      case 'start':
        if (!sink.enabled()) return; // kullanıcı canlı etkinlikleri kapattı: sessizce yok
        if (!(await sink.start(op.attributes, op.content))) return;
        break;
      case 'update':
        await sink.update(op.content);
        break;
      case 'end':
        await sink.end(op.content, op.dismiss_at);
        if (op.immediate) lastSessions = [];
        break;
    }
    rt = applyLiveOp(rt, op);
  });
  queue = run.catch(() => undefined);
  return run;
}

export function startF12Services(uid: UserId, deps: F12Deps): () => void {
  const unsubs: (() => void)[] = [];
  setBreakResumeHook(deps.publishNow);
  void breakStore.getState().hydrate(uid);
  void shareHistoryStore.getState().hydrate(uid);

  let sessionIds = new Set(liveSessionsNow().map((s) => s.session_id));
  const onSharing = () => {
    const st = sharingStore.getState();
    shareHistoryStore.getState().record(historyEntriesFrom(st.state.shares), serverClockNow());
    const live = liveSessionsNow();
    const brk = breakStore.getState().brk;
    if (brk) {
      // Tüm paylaşımlar bitti → mola biter. Moladayken yeni oturum başladı → kullanıcı paylaş dedi, yayın açılır.
      const fresh = live.some((s) => !sessionIds.has(s.session_id) && s.started_at > brk.started_at);
      if (!live.length || fresh) breakStore.getState().end();
    }
    sessionIds = new Set(live.map((s) => s.session_id));
    void syncLiveActivity();
  };
  unsubs.push(sharingStore.subscribe(onSharing));
  unsubs.push(
    invisibleStore.subscribe((s) => {
      if (selectIsInvisible(s)) breakStore.getState().end();
      void syncLiveActivity();
    }),
  );
  unsubs.push(breakStore.subscribe(() => void syncLiveActivity()));
  unsubs.push(liveEtaStore.subscribe(() => void syncLiveActivity()));
  unsubs.push(friendsStore.subscribe(() => void syncLiveActivity()));
  const pulse = setInterval(() => {
    breakStore.getState().tick();
    void syncLiveActivity();
  }, PULSE_MS);
  unsubs.push(() => clearInterval(pulse));
  onSharing();
  return () => unsubs.forEach((u) => u());
}

/** Çıkış: kilit ekranında iz kalmaz; mola ve geçmiş bellekten (geçmiş diskten de, persist çıkış temizliği) silinir. */
export function resetF12State(): Promise<unknown> {
  breakStore.getState().reset();
  shareHistoryStore.getState().reset();
  liveEtaStore.getState().set(null);
  avatarReady.clear();
  return syncLiveActivity('signed_out');
}


/** Kilit ekranı / bildirim eylemi (`konum://live?action=…`). */
export async function handleLiveAction(action: string, sessionId: string | null): Promise<void> {
  if (action === 'break15') breakStore.getState().start(15);
  else if (action === 'resume') breakStore.getState().end();
  else if (action === 'stop') {
    const id = sessionId ?? liveSessionsNow()[0]?.session_id;
    if (id) await sharingStore.getState().stop(id);
  }
}
