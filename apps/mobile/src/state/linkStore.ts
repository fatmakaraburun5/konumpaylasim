/**
 * Bağlantı (QR) ile paylaşım: gönderen tarafı durum deposu (zustand). Faz 1 `sharingStore` ile aynı ilkeler:
 *
 *  - Sunucu doğrudur: Firestore `link_shares` (sender_id == ben) → `applyServerLinks`. Callable yanıtları
 *    (create / extend / stop) dinleyici aynı ya da daha yeni sürümü getirene kadar tutulur.
 *  - Yayın yalnızca sunucunun onayladığı bağlantılara: `selectLinkTargets` core `selectLinkPublishTargets`
 *    ile aktif + süresi dolmamış + kullanıcının durdurmadığı bağlantıları döndürür.
 *  - "Paylaşımı durdur" anında yayın kesilir (bellekteki kesme anahtarı `linkStops`), niyet diske yazılır,
 *    `link_share_stop` aynı op_id ile geri çekilmeli olarak yeniden denenir. Sunucu durdurunca
 *    `link_acl` mezar taşı + `link_live` silinir: açık web sekmesi / uygulama "Paylaşım sona erdi" der.
 *  - Süre motoru Faz 1 ile aynı: `resolveDuration`, uyarı anı `extendPromptAt`, uzatma +30 dk / +1 saat
 *    (sunucu `extendExpiry`). Evre (`active` → `expiring_soon` → `ended`) sunucu saatine göre hesaplanır.
 *  - Düz token yalnızca create yanıtında gelir; QR'ın URL'si güvenli kasada tutulur (linkTokenVault).
 *
 * Yan etkiler (yayın hedeflerini kalıcılaştırma, takibi açma, bildirim planlama) `sharingCoordinator`'dadır.
 */
import {
  DurationError,
  extendPromptAt,
  isExpired,
  isNearExpiry,
  resolveDuration,
  selectLinkPublishTargets,
  uuidV4,
  type DurationChoice,
  type EpochMs,
  type ExtensionMinutes,
  type LinkEndReason,
  type LinkId,
  type LinkPublishTarget,
  type LinkShareView,
  type ShareMode,
  type SharingError,
} from '@konum/core';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { now as serverClockNow } from '../lib/clock';
import { toKonumError } from '../lib/errors';
import { deviceTimeZone } from '../lib/timeZone';
import { linkApi, type LinkApi } from '../services/firebase/callables';
import { linkTokenVault, type LinkTokenVault } from '../services/security/linkTokenVault';
import { addLinkStop, getLinkStop, isLinkBlocked, listLinkStops, removeLinkStop, type LinkStopIntent } from './linkStops';

export type LinkPhase = 'active' | 'expiring_soon' | 'extending' | 'stopping' | 'ended';

/** Arayüzün gördüğü bağlantı oturumu. */
export interface LinkSession {
  link_id: LinkId;
  session_id: string;
  token_hash: string;
  phase: LinkPhase;
  share_mode: ShareMode;
  started_at: EpochMs;
  expires_at: EpochMs | null;
  /** "Süre dolmak üzere" uyarı anı (core `extendPromptAt`); süresizde null. */
  prompt_at: EpochMs | null;
  end_reason: LinkEndReason | null;
  version: number;
  extended_count: number;
  /** QR'ın taşıdığı URL; bu cihazda yoksa (başka cihazda oluşturuldu / kasa silindi) null. */
  url: string | null;
  error: SharingError | null;
}

export interface LinkStoreDeps {
  api: LinkApi;
  vault: LinkTokenVault;
  now: () => EpochMs;
  newOpId: () => string;
  timeZone: () => string;
  tickMs: number;
  stopRetryBackoffMs: readonly number[];
  confirmedHoldMs: number;
}

/** [Varsayım] Faz 1 ile aynı geri çekilme: 5 sn, 15 sn, 30 sn, 1 dk, 2 dk, sonra 5 dakikada bir. */
const STOP_RETRY_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;
const CONFIRMED_HOLD_MS = 2 * 60_000;
/**
 * Yanıtı kaybolan (yeniden denenebilir hatayla biten) `link_share_create` aynı süre seçimiyle bu süre içinde
 * yeniden denenirse AYNI op_id gider: sunucu ikinci bağlantı açmaz, aynı `link_id` için token'ı yeniler
 * (backend sözleşmesi). Böylece QR'ı gösterilemeyen yetim bağlantı kalmaz. [Varsayım] 10 dk (sunucu op kaydı 1 gün).
 */
const CREATE_RETRY_WINDOW_MS = 10 * 60_000;

export type CreateLinkResult = { ok: true; linkId: LinkId; url: string } | { ok: false; error: SharingError };

export interface LinkStoreState {
  links: Record<LinkId, LinkShareView>;
  urls: Record<LinkId, string>;
  pending: Record<LinkId, 'extending' | 'stopping'>;
  errors: Record<LinkId, SharingError>;
  dismissed: Record<LinkId, true>;
  /** Sunucu saati; bağlantı sürerken saniyede bir ilerler. */
  now: EpochMs;
  /** Gerçek bir sunucu anlık görüntüsü geldi mi (geçici açılış görünümü değil). */
  serverKnown: boolean;
  applyServerLinks: (views: readonly LinkShareView[]) => void;
  /** Açılışta kalıcı hedeflerden geçici görünüm (sunucu anlık görüntüsü gelene kadar). */
  seedProvisional: (views: readonly LinkShareView[]) => void;
  create: (choice: DurationChoice) => Promise<CreateLinkResult>;
  extend: (linkId: LinkId, minutes: ExtensionMinutes, opId?: string) => Promise<boolean>;
  stop: (linkId: LinkId) => Promise<boolean>;
  restoreStops: (intents: readonly LinkStopIntent[]) => void;
  retryPendingStops: () => Promise<void>;
  /** Kasadan QR URL'sini yükler (yoksa null). */
  ensureUrl: (linkId: LinkId) => Promise<string | null>;
  findLink: (linkId: LinkId) => LinkSession | undefined;
  dismiss: (linkId: LinkId) => void;
  reset: () => void;
  dispose: () => void;
}

const isEnded = (v: LinkShareView, now: EpochMs) => v.status === 'ended' || isExpired(v, now);

export function linkPhase(v: LinkShareView, pending: 'extending' | 'stopping' | undefined, blocked: boolean, now: EpochMs): LinkPhase {
  if (isEnded(v, now)) return 'ended';
  if (blocked || pending === 'stopping') return 'stopping';
  if (pending === 'extending') return 'extending';
  if (isNearExpiry(v, now)) return 'expiring_soon';
  return 'active';
}

/** Saf seçici: bağlantı oturumları, en yenisi önce. */
export function selectLinkSessions(s: Pick<LinkStoreState, 'links' | 'urls' | 'pending' | 'errors' | 'dismissed' | 'now'>): LinkSession[] {
  return Object.values(s.links)
    .filter((v) => !s.dismissed[v.link_id])
    .map((v): LinkSession => {
      const phase = linkPhase(v, s.pending[v.link_id], isLinkBlocked(v.link_id), s.now);
      const end_reason: LinkEndReason | null = phase === 'ended' ? (v.status === 'ended' ? (v.end_reason ?? 'stopped_by_sender') : 'expired') : null;
      return {
        link_id: v.link_id,
        session_id: v.session_id,
        token_hash: v.token_hash,
        phase,
        share_mode: v.share_mode,
        started_at: v.started_at,
        expires_at: v.expires_at,
        prompt_at: extendPromptAt(v),
        end_reason,
        version: v.version,
        extended_count: v.extended_count,
        url: s.urls[v.link_id] ?? null,
        error: s.errors[v.link_id] ?? null,
      };
    })
    .sort((a, b) => b.started_at - a.started_at);
}

/**
 * Yayın hedefleri: sunucunun onayladığı, aktif, süresi dolmamış ve kullanıcının durdurmadığı bağlantılar.
 * `senderName` = görünen ad (telefon ASLA); core `linkSenderName` pakette yeniden temizler.
 */
export function selectLinkTargets(s: Pick<LinkStoreState, 'links' | 'pending' | 'now'>, senderName: string): LinkPublishTarget[] {
  const views = Object.values(s.links).filter((v) => s.pending[v.link_id] !== 'stopping' && !isLinkBlocked(v.link_id));
  return selectLinkPublishTargets(views, senderName, s.now).sort((a, b) => a.link_id.localeCompare(b.link_id));
}

const toView = (r: LinkShareView): LinkShareView => ({
  link_id: r.link_id,
  session_id: r.session_id,
  token_hash: r.token_hash,
  status: r.status,
  share_mode: r.share_mode,
  started_at: r.started_at,
  expires_at: r.expires_at,
  end_reason: r.end_reason,
  version: r.version,
  extended_count: r.extended_count,
});

const omit = <T,>(rec: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in rec)) return rec;
  const { [key]: _gone, ...rest } = rec;
  return rest;
};

export function createLinkStore(overrides: Partial<LinkStoreDeps> = {}): StoreApi<LinkStoreState> {
  const deps: LinkStoreDeps = {
    api: linkApi,
    vault: linkTokenVault,
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
  const held = new Map<LinkId, { view: LinkShareView; until: EpochMs }>();
  let createRetry: { op_id: string; key: string; at: EpochMs } | null = null;
  const hold = (v: LinkShareView) => {
    const prev = held.get(v.link_id);
    if (!prev || v.version >= prev.view.version) held.set(v.link_id, { view: v, until: deps.now() + deps.confirmedHoldMs });
  };

  const store = createStore<LinkStoreState>()((set, get) => {
    function once<T>(key: string, run: () => Promise<T>): Promise<T> {
      const running = inflight.get(key) as Promise<T> | undefined;
      if (running) return running;
      const p = run().finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    }

    /** Callable yanıtı: tut + depoya yaz (daha eski sürüm yenisini ezmez). */
    const acceptView = (v: LinkShareView) => {
      hold(v);
      set((s) => {
        const cur = s.links[v.link_id];
        if (cur && cur.version > v.version) return { now: deps.now() };
        return { links: { ...s.links, [v.link_id]: v }, now: deps.now() };
      });
    };

    function clearRetry() {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    }

    function scheduleRetry() {
      if (retryTimer || listLinkStops().length === 0) return;
      const steps = deps.stopRetryBackoffMs;
      const delay = steps[Math.min(retryAttempt, steps.length - 1)] ?? 300_000;
      retryAttempt++;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void get().retryPendingStops();
      }, delay);
    }

    const stopDone = async (linkId: LinkId) => {
      set((s) => ({ pending: omit(s.pending, linkId), errors: omit(s.errors, linkId) }));
      await removeLinkStop(linkId).catch(() => undefined);
      await deps.vault.remove(linkId).catch(() => undefined);
      set((s) => ({ urls: omit(s.urls, linkId) }));
      if (listLinkStops().length === 0) {
        retryAttempt = 0;
        clearRetry();
      }
    };

    async function sendStop(linkId: LinkId, op: string): Promise<boolean> {
      try {
        const res = await deps.api.linkShareStop({ op_id: op, link_id: linkId });
        acceptView(toView(res));
        await stopDone(linkId);
        return true;
      } catch (e) {
        const err = toKonumError(e);
        if (err.code === 'link_not_found') {
          // Sunucu bu bağlantıyı tanımıyor: durdurulacak bir şey yok. Yerelde bitmiş say.
          const cur = get().links[linkId];
          if (cur) acceptView({ ...cur, status: 'ended', end_reason: 'stopped_by_sender', version: cur.version + 1 });
          await stopDone(linkId);
          return true;
        }
        // Yayın kapalı kalır (kesme anahtarı); kullanıcı tekrar deneyebilir, ayrıca otomatik denenir.
        set((s) => ({ errors: { ...s.errors, [linkId]: err.toSharingError() } }));
        scheduleRetry();
        return false;
      }
    }

    return {
      links: {},
      urls: {},
      pending: {},
      errors: {},
      dismissed: {},
      now: deps.now(),
      serverKnown: false,

      applyServerLinks: (views) => {
        const t = deps.now();
        const byId = new Map(views.map((v) => [v.link_id, toView(v)] as const));
        for (const [id, h] of held) {
          const cur = byId.get(id);
          if ((cur && cur.version >= h.view.version) || t > h.until) held.delete(id);
          else byId.set(id, h.view);
        }
        set((s) => {
          const links: Record<LinkId, LinkShareView> = {};
          for (const [id, v] of byId) links[id] = v;
          // Durdurma bekleyen ama listeden düşen bağlantı: yerel kaydı tut (kart "durduruluyor" göstersin).
          for (const id of Object.keys(s.pending)) if (!links[id] && s.links[id]) links[id] = s.links[id] as LinkShareView;
          return { links, now: t, serverKnown: true };
        });
      },

      seedProvisional: (views) => {
        if (get().serverKnown || views.length === 0) return;
        set((s) => {
          const links = { ...s.links };
          for (const v of views) if (!links[v.link_id]) links[v.link_id] = toView(v);
          return { links, now: deps.now() };
        });
      },

      create: (choice) =>
        once<CreateLinkResult>('create', async () => {
          const t = deps.now();
          try {
            resolveDuration(choice, t);
          } catch (e) {
            return { ok: false, error: { code: 'invalid_duration', message: e instanceof DurationError ? e.message : 'Süre geçersiz' } };
          }
          const key = JSON.stringify(choice);
          const reuse = createRetry && createRetry.key === key && t - createRetry.at < CREATE_RETRY_WINDOW_MS ? createRetry : null;
          const opId = reuse?.op_id ?? deps.newOpId();
          createRetry = null;
          try {
            const res = await deps.api.linkShareCreate({ op_id: opId, duration: choice, time_zone: deps.timeZone() });
            acceptView(toView(res));
            set((s) => ({ urls: { ...s.urls, [res.link_id]: res.url }, dismissed: omit(s.dismissed, res.link_id) }));
            // Token yalnızca bu yanıtta gelir: QR'ı sonradan göstermek için güvenli kasaya.
            await deps.vault.save(res.link_id, res.url).catch(() => undefined);
            return { ok: true, linkId: res.link_id, url: res.url };
          } catch (e) {
            const err = toKonumError(e);
            if (err.retryable) createRetry = { op_id: opId, key, at: reuse?.at ?? t };
            return { ok: false, error: err.toSharingError() };
          }
        }),

      extend: (linkId, minutes, opId) =>
        once<boolean>(`extend:${linkId}`, async () => {
          const v = get().links[linkId];
          const t = deps.now();
          if (!v || v.status !== 'active' || v.expires_at === null || isExpired(v, t)) return false;
          if (isLinkBlocked(linkId) || get().pending[linkId] === 'stopping') return false;
          set((s) => ({ pending: { ...s.pending, [linkId]: 'extending' }, errors: omit(s.errors, linkId) }));
          try {
            const res = await deps.api.linkShareExtend({ op_id: opId ?? deps.newOpId(), link_id: linkId, minutes });
            acceptView(toView(res));
            set((s) => (s.pending[linkId] === 'extending' ? { pending: omit(s.pending, linkId) } : s));
            return true;
          } catch (e) {
            const error = toKonumError(e).toSharingError();
            set((s) => ({
              pending: s.pending[linkId] === 'extending' ? omit(s.pending, linkId) : s.pending,
              errors: { ...s.errors, [linkId]: error },
            }));
            return false;
          }
        }),

      stop: (linkId) =>
        once<boolean>(`stop:${linkId}`, async () => {
          const v = get().links[linkId];
          const existing = getLinkStop(linkId);
          if (!existing && (!v || isEnded(v, deps.now()))) return false;
          const op = existing?.op_id ?? deps.newOpId();
          // Yayın BU satırda kesilir: kesme anahtarı (senkron) + bekleyen durdurma.
          const persisted = addLinkStop({ link_id: linkId, op_id: op, version: v?.version ?? 0, requested_at: deps.now() });
          set((s) => ({ pending: { ...s.pending, [linkId]: 'stopping' }, errors: omit(s.errors, linkId) }));
          // Niyet diske yazılmadan ağa çıkılmaz.
          await persisted.catch(() => undefined);
          return sendStop(linkId, op);
        }),

      restoreStops: (intents) => {
        if (intents.length === 0) return;
        set((s) => {
          const pending = { ...s.pending };
          for (const i of intents) pending[i.link_id] = 'stopping';
          return { pending };
        });
      },

      retryPendingStops: async () => {
        clearRetry();
        const list = listLinkStops();
        await Promise.all(list.map((i) => once<boolean>(`stop:${i.link_id}`, () => sendStop(i.link_id, i.op_id))));
      },

      ensureUrl: async (linkId) => {
        const have = get().urls[linkId];
        if (have) return have;
        const url = await deps.vault.load(linkId).catch(() => null);
        if (url && get().links[linkId]) set((s) => ({ urls: { ...s.urls, [linkId]: url } }));
        return url;
      },

      findLink: (linkId) => selectLinkSessions(get()).find((l) => l.link_id === linkId),

      dismiss: (linkId) => set((s) => ({ dismissed: { ...s.dismissed, [linkId]: true } })),

      reset: () => {
        inflight.clear();
        held.clear();
        clearRetry();
        retryAttempt = 0;
        createRetry = null;
        set({ links: {}, urls: {}, pending: {}, errors: {}, dismissed: {}, now: deps.now(), serverKnown: false });
      },

      dispose: () => {
        if (ticker) clearInterval(ticker);
        ticker = null;
        clearRetry();
        unsubscribeTicker();
      },
    };
  });

  // Saniyelik saat yalnızca süren (bitmemiş) bir bağlantı varken çalışır.
  const syncTicker = (st: LinkStoreState) => {
    const running = Object.values(st.links).some((v) => !isEnded(v, st.now)) || Object.keys(st.pending).length > 0;
    if (running && !ticker) {
      ticker = setInterval(() => store.setState({ now: deps.now() }), deps.tickMs);
    } else if (!running && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
  const unsubscribeTicker = store.subscribe(syncTicker);

  return store;
}

/** Uygulamanın tek bağlantı deposu. */
export const linkStore = createLinkStore();

export function useLinkStore<T>(selector: (s: LinkStoreState) => T): T {
  return useStore(linkStore, selector);
}

export function useLinkSessions(): LinkSession[] {
  const links = useLinkStore((s) => s.links);
  const urls = useLinkStore((s) => s.urls);
  const pending = useLinkStore((s) => s.pending);
  const errors = useLinkStore((s) => s.errors);
  const dismissed = useLinkStore((s) => s.dismissed);
  const now = useLinkStore((s) => s.now);
  return useMemo(() => selectLinkSessions({ links, urls, pending, errors, dismissed, now }), [links, urls, pending, errors, dismissed, now]);
}

export function useLinkSession(linkId: LinkId | null): LinkSession | undefined {
  const sessions = useLinkSessions();
  return linkId ? sessions.find((l) => l.link_id === linkId) : undefined;
}
