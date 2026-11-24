/**
 * Gönderen tarafı paylaşım durumu: core `sharingReducer` + seçicileri saran zustand deposu.
 *
 *  - Sunucu (Firestore `location_shares`, sender_id == ben) doğrudur → `applyServerShares` = SERVER_SNAPSHOT.
 *  - İyimser durum yalnızca arayüz içindir: sunucu onaylamadan hiçbir alıcıya konum yayınlanmaz
 *    (core `selectPublishTargets` yalnızca onaylı paylaşımları döndürür).
 *  - "Durdur" anında yayın kesilir (STOP_REQUESTED), sunucu yanıtı beklenmez.
 *  - Bir oturum aktifken saniyede bir TICK: süre sunucu saatine göre yerelde de dolar.
 *  - Çift dokunma koruması: aynı işlem (başlat / oturum başına uzat / durdur) sürerken yenisi başlamaz,
 *    süren işlemin sözü (promise) döner.
 *  - Durdurma niyeti KALICIDIR (`state/stopIntents.ts`): STOP_REQUESTED ile aynı anda bellekteki kesme
 *    anahtarı kapanır ve niyet diske yazılır; `share_stop` aynı op_id ile geri çekilmeli olarak yeniden
 *    denenir. Süreç yeniden başlarsa `restoreStopIntents` niyetleri geri yükler: sunucu paylaşımı hâlâ
 *    aktif gösterse bile yayın geri gelmez.
 *  - Callable yanıtıyla onaylanan paylaşımlar, Firestore dinleyicisi aynı ya da daha yeni sürümü
 *    getirene kadar tutulur (geç gelen eski anlık görüntü yeni oturumu silmesin). [core_requests]
 *
 * Yan etkiler (yayın hedeflerini kalıcılaştırma, konum takibini açıp kapama, bildirim planlama)
 * burada DEĞİL, `services/sharingCoordinator.ts` içindedir: depo saf ve test edilebilir kalır.
 */
import {
  DurationError,
  initialSharingState,
  isExpired,
  resolveDuration,
  selectPublishTargets,
  selectSessions,
  sharingReducer,
  uuidV4,
  type DurationChoice,
  type EpochMs,
  type ExtensionMinutes,
  type OutgoingShareView,
  type PublishTarget,
  type SessionId,
  type ShareSession,
  type SharingError,
  type SharingEvent,
  type SharingState,
  type UserId,
} from '@konum/core';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { now as serverClockNow } from '../lib/clock';
import { toKonumError } from '../lib/errors';
import { deviceTimeZone } from '../lib/timeZone';
import { sharingApi, type SharingApi } from '../services/firebase/callables';
import {
  addStopIntent,
  getStopIntent,
  listStopIntents,
  removeStopIntent,
  unblockShares,
  type StopIntent,
} from './stopIntents';

export interface SharingStoreDeps {
  api: SharingApi;
  /** Sunucu saatine göre şimdi. */
  now: () => EpochMs;
  newOpId: () => string;
  timeZone: () => string;
  /** TICK aralığı (ms). */
  tickMs: number;
  /** Başarısız share_stop için otomatik yeniden deneme aralıkları (ms); son değer tekrarlanır. */
  stopRetryBackoffMs: readonly number[];
  /** Callable'la onaylanan paylaşımın dinleyici yetişene kadar tutulma süresi (ms). */
  confirmedHoldMs: number;
}

/** [Varsayım] Geri çekilme: 5 sn, 15 sn, 30 sn, 1 dk, 2 dk, sonra 5 dakikada bir. */
const STOP_RETRY_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;
/** [Varsayım] Firestore dinleyicisi normalde birkaç saniyede yetişir; 2 dk güvenli üst sınır. */
const CONFIRMED_HOLD_MS = 2 * 60_000;

export type StartResult =
  | { ok: true; sessionId: SessionId; skippedReceiverIds: UserId[] }
  | { ok: false; error: SharingError };

export interface SharingStoreState {
  state: SharingState;
  /** Kullanıcının kapattığı (DISMISS) oturumlar: sunucu anlık görüntüsü biten paylaşımlarını geri getirmesin. */
  dismissed: Record<SessionId, true>;
  dispatch: (ev: SharingEvent) => void;
  applyServerShares: (shares: readonly OutgoingShareView[]) => void;
  startShare: (receiverIds: readonly UserId[], choice: DurationChoice) => Promise<StartResult>;
  extend: (sessionId: SessionId, minutes: ExtensionMinutes, opId?: string) => Promise<boolean>;
  stop: (sessionId: SessionId) => Promise<boolean>;
  /** Açılışta: kalıcı durdurma niyetlerini reducer'a geri yükler (yayın kapalı kalır). */
  restoreStopIntents: (intents: readonly StopIntent[]) => void;
  /** Bekleyen tüm durdurma niyetlerini sunucuya yeniden gönderir (AppState active, yeniden bağlanma). */
  retryPendingStops: () => Promise<void>;
  findSession: (sessionId: SessionId) => ShareSession | undefined;
  dismiss: (sessionId: SessionId) => void;
  /** Çıkışta her şeyi sıfırlar. */
  reset: () => void;
  /** Zamanlayıcıyı durdurur (testler). */
  dispose: () => void;
}

const RUNNING_PHASES = new Set<ShareSession['phase']>(['starting', 'active', 'expiring_soon', 'extending', 'stopping']);

export const localSessionId = (opId: string): SessionId => `local_${opId}`;

export function createSharingStore(overrides: Partial<SharingStoreDeps> = {}): StoreApi<SharingStoreState> {
  const deps: SharingStoreDeps = {
    api: sharingApi,
    now: serverClockNow,
    newOpId: uuidV4,
    timeZone: deviceTimeZone,
    tickMs: 1_000,
    stopRetryBackoffMs: STOP_RETRY_BACKOFF_MS,
    confirmedHoldMs: CONFIRMED_HOLD_MS,
    ...overrides,
  };

  const inflight = new Map<string, Promise<unknown>>();
  let ticker: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  /** Callable yanıtından gelen, dinleyicinin henüz yetişmediği paylaşımlar. */
  const held = new Map<string, { view: OutgoingShareView; until: EpochMs }>();
  const hold = (shares: readonly OutgoingShareView[]) => {
    const until = deps.now() + deps.confirmedHoldMs;
    for (const v of shares) {
      const prev = held.get(v.share_id);
      if (!prev || v.version >= prev.view.version) held.set(v.share_id, { view: v, until });
    }
  };

  const store = createStore<SharingStoreState>()((set, get) => {
    const apply = (...events: SharingEvent[]) => set((s) => ({ state: events.reduce(sharingReducer, s.state) }));

    /** Aynı anahtarla süren işlem varsa onu döndür (çift dokunma). */
    function once<T>(key: string, run: () => Promise<T>): Promise<T> {
      const running = inflight.get(key) as Promise<T> | undefined;
      if (running) return running;
      const p = run().finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    }

    const findSession = (id: SessionId) => selectSessions(get().state).find((x) => x.session_id === id);

    /** share_stop gönderir; başarıda niyet kalkar, hatada yayın kapalı kalır ve yeniden deneme planlanır. */
    async function sendStop(sessionId: SessionId, op: string): Promise<boolean> {
      try {
        const res = await deps.api.shareStop({ op_id: op, session_id: sessionId });
        hold(res.shares);
        apply({ type: 'STOP_SUCCEEDED', session_id: sessionId, shares: res.shares });
        await removeStopIntent(sessionId).catch(() => undefined);
        if (listStopIntents().length === 0) {
          retryAttempt = 0;
          clearRetry();
        }
        return true;
      } catch (e) {
        // Yayın kapalı kalır (paused + kesme anahtarı); kullanıcı tekrar deneyebilir, ayrıca otomatik denenir.
        apply({ type: 'STOP_FAILED', session_id: sessionId, error: toKonumError(e).toSharingError() });
        scheduleRetry();
        return false;
      }
    }

    function clearRetry() {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    }

    function scheduleRetry() {
      if (retryTimer || listStopIntents().length === 0) return;
      const steps = deps.stopRetryBackoffMs;
      const delay = steps[Math.min(retryAttempt, steps.length - 1)] ?? 300_000;
      retryAttempt++;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void get().retryPendingStops();
      }, delay);
    }

    return {
      state: initialSharingState(deps.now()),
      dismissed: {},

      dispatch: (ev) => apply(ev),

      applyServerShares: (shares) => {
        const { dismissed } = get();
        const t = deps.now();
        const byId = new Map(shares.map((s) => [s.share_id, s] as const));
        // Geç gelen anlık görüntü callable'ın onayladığı daha yeni sürümü ezmesin.
        for (const [id, h] of held) {
          const cur = byId.get(id);
          if ((cur && cur.version >= h.view.version) || t > h.until) held.delete(id);
          else byId.set(id, h.view);
        }
        const visible = [...byId.values()].filter((s) => !(dismissed[s.session_id] && (s.status === 'ended' || isExpired(s, t))));
        apply({ type: 'SERVER_SNAPSHOT', shares: visible });
      },

      startShare: (receiverIds, choice) =>
        once<StartResult>('start', async () => {
          const receivers = [...new Set(receiverIds)];
          if (receivers.length === 0) return { ok: false, error: { code: 'invalid_argument', message: 'En az bir kişi seçin' } };
          const t = deps.now();
          let resolved;
          try {
            resolved = resolveDuration(choice, t);
          } catch (e) {
            const message = e instanceof DurationError ? e.message : 'Süre geçersiz';
            return { ok: false, error: { code: 'invalid_duration', message } };
          }
          const opId = deps.newOpId();
          // Sunucu session_id'yi yanıtta verir; o gelene kadar taslak yerel kimlikle tutulur.
          const localId = localSessionId(opId);
          apply({ type: 'START_REQUESTED', op_id: opId, session_id: localId, receiver_ids: receivers, resolved, now: t });
          try {
            const res = await deps.api.shareStart({ op_id: opId, receiver_ids: receivers, duration: choice, time_zone: deps.timeZone() });
            hold(res.shares);
            // Sunucu bu kişilerle olan paylaşım belgesini yeni oturumla değiştirdi: eski durdurma niyetleri bu
            // paylaşımları artık engellememeli (eski oturuma yönelik share_stop yeni oturumu etkilemez).
            void unblockShares(res.shares.map((x) => x.share_id)).catch(() => undefined);
            // Tek geçişte: sunucu oturumunu ekle, yerel taslağı kaldır (arada iki kart görünmesin).
            apply(
              { type: 'START_SUCCEEDED', session_id: res.session_id, shares: res.shares },
              { type: 'DISMISS', session_id: localId },
            );
            return { ok: true, sessionId: res.session_id, skippedReceiverIds: res.skipped_receiver_ids };
          } catch (e) {
            const error = toKonumError(e).toSharingError();
            apply({ type: 'START_FAILED', session_id: localId, error });
            return { ok: false, error };
          }
        }),

      extend: (sessionId, minutes, opId) =>
        once<boolean>(`extend:${sessionId}`, async () => {
          const s = findSession(sessionId);
          if (!s || !s.confirmed || s.expires_at === null) return false;
          if (s.phase !== 'active' && s.phase !== 'expiring_soon') return false;
          const op = opId ?? deps.newOpId();
          apply({ type: 'EXTEND_REQUESTED', session_id: sessionId, op_id: op, minutes });
          try {
            const res = await deps.api.shareExtend({ op_id: op, session_id: sessionId, minutes });
            hold(res.shares);
            apply({ type: 'EXTEND_SUCCEEDED', session_id: sessionId, shares: res.shares });
            return true;
          } catch (e) {
            apply({ type: 'EXTEND_FAILED', session_id: sessionId, error: toKonumError(e).toSharingError() });
            return false;
          }
        }),

      stop: (sessionId) =>
        once<boolean>(`stop:${sessionId}`, async () => {
          const s = findSession(sessionId);
          const existing = getStopIntent(sessionId);
          if (!existing && (!s || !s.confirmed || s.phase === 'ended')) return false;
          // Yeniden denemede aynı op_id: ilk deneme sunucuda uygulandıysa ikinci kez uygulanmaz.
          const op = existing?.op_id ?? deps.newOpId();
          // Yayın BU satırlarda kesilir: reducer (selectPublishTargets) + bellekteki kesme anahtarı.
          apply({ type: 'STOP_REQUESTED', session_id: sessionId, op_id: op });
          const shares = Object.values(get().state.shares)
            .filter((x) => x.session_id === sessionId && x.status === 'active')
            .map((x) => ({ share_id: x.share_id, version: x.version }));
          const persisted = addStopIntent({ session_id: sessionId, op_id: op, shares, requested_at: deps.now() });
          // Niyet diske yazılmadan ağa çıkılmaz: istek sırasında süreç ölürse niyet kaybolmasın.
          await persisted.catch(() => undefined);
          return sendStop(sessionId, op);
        }),

      restoreStopIntents: (intents) => {
        if (intents.length === 0) return;
        apply(...intents.map((i): SharingEvent => ({ type: 'STOP_REQUESTED', session_id: i.session_id, op_id: i.op_id })));
      },

      retryPendingStops: async () => {
        clearRetry();
        const pending = listStopIntents();
        await Promise.all(pending.map((i) => once<boolean>(`stop:${i.session_id}`, () => sendStop(i.session_id, i.op_id))));
      },

      findSession,

      dismiss: (sessionId) => {
        set((s) => ({ dismissed: { ...s.dismissed, [sessionId]: true } }));
        apply({ type: 'DISMISS', session_id: sessionId });
      },

      reset: () => {
        inflight.clear();
        held.clear();
        clearRetry();
        retryAttempt = 0;
        set({ state: initialSharingState(deps.now()), dismissed: {} });
      },

      dispose: () => {
        if (ticker) clearInterval(ticker);
        ticker = null;
        clearRetry();
        unsubscribeTicker();
      },
    };
  });

  // Saniyelik TICK yalnızca süren bir oturum varken çalışır.
  const syncTicker = (st: SharingStoreState) => {
    const running = selectSessions(st.state).some((s) => RUNNING_PHASES.has(s.phase));
    if (running && !ticker) {
      ticker = setInterval(() => store.getState().dispatch({ type: 'TICK', now: deps.now() }), deps.tickMs);
    } else if (!running && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
  const unsubscribeTicker = store.subscribe(syncTicker);

  return store;
}

/** Uygulamanın tek paylaşım deposu. */
export const sharingStore = createSharingStore();

export function useSharingStore<T>(selector: (s: SharingStoreState) => T): T {
  return useStore(sharingStore, selector);
}

/** Oturum listesi (seçici her çağrıda yeni dizi ürettiği için `state` üzerinden hafızalanır). */
export function useShareSessions(): ShareSession[] {
  const state = useSharingStore((s) => s.state);
  return useMemo(() => selectSessions(state), [state]);
}

export function usePublishTargets(): PublishTarget[] {
  const state = useSharingStore((s) => s.state);
  return useMemo(() => selectPublishTargets(state), [state]);
}

export function useSharingNow(): EpochMs {
  return useSharingStore((s) => s.state.now);
}
