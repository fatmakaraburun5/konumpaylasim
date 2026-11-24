/**
 * Faz 4: tek dokunuşla "Buradayım / Yoldayım" sinyali (core `ping.ts`).
 *
 * Gönderen: `send(to, kind)` → `ping_send` callable'ı. Taze kendi konumum (≤ `PING_LIMITS.maxLocationAgeMs`) varsa
 * eklenir; yoksa ping konumsuz gider (hata değil). Aynı kişiye `perPairCooldownMs` dolmadan ikinci ping AĞA ÇIKMAZ
 * (`rate_limited`); uçuştaki gönderim varken yeni dokunuş aynı sözü döndürür (çift dokunma koruması).
 *
 * Alıcı: RTDB `ping_inbox/{ben}` dinleyicisi (sharingCoordinator → f4Services) `upsertIncoming` / `removeIncoming`
 * çağırır. Yeni ping gelince gönderenin pininde `highlight` (nabız halkası) `highlightMs` boyunca görünür.
 * Süresi geçen pingler budanır (`tick`). Pingler yalnızca bellekte tutulur.
 */
import {
  isPingActive,
  PING_LIMITS,
  pingCooldownLeftMs,
  uuidV4,
  type EpochMs,
  type Ping,
  type PingKind,
  type PingLocation,
  type SharingError,
  type UserId,
} from '@konum/core';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { getServerOffsetMs, now as serverClockNow } from '../lib/clock';
import { toKonumError } from '../lib/errors';
import { pingApi, type PingApi } from '../services/firebase/callables';
import { deletePing } from '../services/firebase/pingInboxRepo';
import { authStore } from './authStore';
import { locationStore } from './locationStore';

/** Faz 4 depolarının ortak sonuç tipi. */
export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: SharingError };

export interface PingState {
  /** Alınan, aktif pingler (süresi geçenler budanır). */
  inbox: Record<string, Ping>;
  /** Soğuma göstergesi için: kişi → son başarılı gönderim (sunucu saati). */
  lastSentAt: Record<UserId, EpochMs>;
  /** Uçuştaki gönderim. */
  sending: Record<UserId, PingKind | undefined>;
  /** Pin nabız vurgusu. */
  highlight: { from: UserId; kind: PingKind; until: EpochMs } | null;
  send(to: UserId, kind: PingKind, opts?: { eta_s?: number | null }): Promise<Result>;
  /** Kutudan ve RTDB'den siler. */
  dismiss(pingId: string): void;
  // --- veri katmanı (koordinatör / bildirim) ---
  upsertIncoming(p: Ping): void;
  removeIncoming(pingId: string): void;
  /** Bildirime dokunuldu: göndereni haritada vurgula. */
  highlightFrom(from: UserId, kind: PingKind): void;
  /** Süresi geçen pingleri ve vurguyu temizler. */
  tick(): void;
  reset(): void;
}

export interface PingStoreDeps {
  api: PingApi;
  /** Sunucu saatine göre şimdi. */
  now: () => EpochMs;
  /** Kendi son konumum (sunucu saatine çevrilmiş); yoksa null. */
  myLocation: () => PingLocation | null;
  myUid: () => UserId | null;
  deleteRemote: (uid: UserId, pingId: string) => Promise<void>;
  newOpId: () => string;
}

/** Bundan eski gelen ping (ör. uygulama açılışında kutuda bekleyen) kendiliğinden vurgu üretmez. [Varsayım] */
const AUTO_HIGHLIGHT_MAX_AGE_MS = 60_000;

/** locationStore `myPosition` (cihaz saati) → ping konumu (sunucu saati). */
export function currentPingLocation(): PingLocation | null {
  const p = locationStore.getState().myPosition;
  if (!p) return null;
  return {
    lat: p.lat,
    lng: p.lng,
    // [Varsayım] Doğruluğu bilinmeyen ölçüm 100 m kabul edilir (şema 0..5000 ister).
    accuracy: Math.min(5_000, Math.max(0, Math.round(p.accuracy ?? 100))),
    timestamp: Math.round(p.timestamp + getServerOffsetMs()),
  };
}

const rateLimited = (): SharingError => ({ code: 'rate_limited', message: 'Az önce gönderdin. Birkaç saniye sonra tekrar dene.' });

export function createPingStore(overrides: Partial<PingStoreDeps> = {}): StoreApi<PingState> {
  const deps: PingStoreDeps = {
    api: pingApi,
    now: serverClockNow,
    myLocation: currentPingLocation,
    myUid: () => authStore.getState().uid,
    deleteRemote: deletePing,
    newOpId: uuidV4,
    ...overrides,
  };
  const inflight = new Map<UserId, Promise<Result>>();

  return createStore<PingState>()((set, get) => ({
    inbox: {},
    lastSentAt: {},
    sending: {},
    highlight: null,

    send: (to, kind, opts) => {
      const running = inflight.get(to);
      if (running) return running;
      const t = deps.now();
      if (pingCooldownLeftMs(get().lastSentAt[to], t) > 0) return Promise.resolve({ ok: false, error: rateLimited() });
      const loc = deps.myLocation();
      // [Varsayım] Her iki türde de taze konum eklenir ("Yoldayım" da nereden geldiğini gösterir); eski konum gönderilmez.
      const location = loc && t - loc.timestamp <= PING_LIMITS.maxLocationAgeMs && loc.timestamp <= t + 60_000 ? loc : null;
      const etaRaw = kind === 'on_way' ? (opts?.eta_s ?? null) : null;
      const eta_s = etaRaw !== null && Number.isFinite(etaRaw) && etaRaw > 0 ? Math.min(PING_LIMITS.maxEtaS, Math.round(etaRaw)) : null;
      set((s) => ({ sending: { ...s.sending, [to]: kind } }));
      const p = (async (): Promise<Result> => {
        try {
          const res = await deps.api.pingSend({ op_id: deps.newOpId(), to, kind, location, eta_s });
          set((s) => ({ lastSentAt: { ...s.lastSentAt, [to]: res.server_now } }));
          return { ok: true };
        } catch (e) {
          const err = toKonumError(e);
          // Sunucu da soğuma uyguladıysa gösterge dolsun (aynı süre).
          if (err.code === 'rate_limited') set((s) => ({ lastSentAt: { ...s.lastSentAt, [to]: deps.now() } }));
          return { ok: false, error: err.code === 'rate_limited' ? rateLimited() : err.toSharingError() };
        } finally {
          inflight.delete(to);
          set((s) => {
            const { [to]: _gone, ...rest } = s.sending;
            return { sending: rest };
          });
        }
      })();
      inflight.set(to, p);
      return p;
    },

    dismiss: (pingId) => {
      const p = get().inbox[pingId];
      get().removeIncoming(pingId);
      if (p && get().highlight?.from === p.from) set({ highlight: null });
      const uid = deps.myUid();
      if (uid) void deps.deleteRemote(uid, pingId).catch(() => undefined);
    },

    upsertIncoming: (p) => {
      const t = deps.now();
      if (!isPingActive(p, t)) {
        // Süresi geçmiş kayıt: kutuda kalmasın (sunucu süpürücüsü de siler).
        const uid = deps.myUid();
        if (uid) void deps.deleteRemote(uid, p.ping_id).catch(() => undefined);
        return;
      }
      const isNew = !(p.ping_id in get().inbox);
      set((s) => ({ inbox: { ...s.inbox, [p.ping_id]: p } }));
      if (isNew && t - p.sent_at <= AUTO_HIGHLIGHT_MAX_AGE_MS) get().highlightFrom(p.from, p.kind);
    },

    removeIncoming: (pingId) =>
      set((s) => {
        if (!(pingId in s.inbox)) return s;
        const { [pingId]: _gone, ...rest } = s.inbox;
        return { inbox: rest };
      }),

    highlightFrom: (from, kind) => set({ highlight: { from, kind, until: deps.now() + PING_LIMITS.highlightMs } }),

    tick: () => {
      const t = deps.now();
      const s = get();
      const expired = Object.values(s.inbox).filter((p) => !isPingActive(p, t));
      const highlightDone = s.highlight !== null && s.highlight.until <= t;
      if (expired.length === 0 && !highlightDone) return;
      const inbox = { ...s.inbox };
      for (const p of expired) delete inbox[p.ping_id];
      set({ inbox, ...(highlightDone ? { highlight: null } : {}) });
    },

    reset: () => {
      inflight.clear();
      set({ inbox: {}, lastSentAt: {}, sending: {}, highlight: null });
    },
  }));
}

export const pingStore = createPingStore();

export function usePingStore<T>(selector: (s: PingState) => T): T {
  return useStore(pingStore, selector);
}

/** Bu kişiye ping için kalan soğuma (ms); 0 = gönderilebilir. */
export function pingCooldownFor(s: Pick<PingState, 'lastSentAt'>, to: UserId, now: EpochMs): number {
  return pingCooldownLeftMs(s.lastSentAt[to], now);
}

/** Kutudaki pingler, en yeni önce. */
export function selectInbox(s: Pick<PingState, 'inbox'>): Ping[] {
  return Object.values(s.inbox).sort((a, b) => b.sent_at - a.sent_at);
}
