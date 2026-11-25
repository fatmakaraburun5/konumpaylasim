/**
 * Faz 8: yönlü izinler (`permission_grants`). Sunucu doğrudur: iki yönlü dinleyici (`grantsRepo.listenGrants`)
 * `setSnapshot` ile tam listeyi verir; istemci yalnızca callable çağırır.
 *
 * Yön sözlüğü (karıştırılmasın):
 *  - `myGrantTo(id)`   = BENİM o kişiye verdiğim izin belgesi (granter = ben). `location_view` varsa O BENİ görebilir.
 *  - `theirGrantTo(id)` = O kişinin BANA verdiği izin belgesi (granter = o). `location_view` varsa BEN ONU görebilirim.
 *  - `can(scope, id, 'given')`    → o kişi bana karşı bu işi yapabilir mi (ben vermişim).
 *  - `can(scope, id, 'received')` → ben o kişiye karşı bu işi yapabilir miyim (o vermiş).
 *
 * İyimser yama: anahtar kapatılınca (`setScope(..., false)`) yerel belge ANINDA güncellenir; callable yanıtı gelince
 * yanıttaki kapsam listesi, dinleyici yetişene kadar tutulur. Başarısızlıkta yama düşer ve sunucu gerçeğine dönülür.
 * `location_view` geri alınınca kişi `locationRevoked`a girer: yayın hedefi süzgeci (sharingCoordinator) o kişiye
 * yayını sunucu paylaşımı bitirmeden ÖNCE keser; izin yeniden verilince (yeni `granted_at`) çıkar. Geri alma ağ
 * hatasıyla (unavailable / zaman aşımı / internal) biterse kesim ve iyimser yama KALIR (sunucuya ulaşıp ulaşmadığı
 * bilinmez); istek bağlantı gelince aynı op_id ile yeniden gönderilir (`retryPendingRevokes`). Yalnızca kesin sunucu
 * reddinde geri alınır.
 *
 * Gizlilik: ret soğuması / görünmezlik isteyene söylenmez — `request` yanıtı her zaman `sent` | `already_granted`.
 */
import {
  grantedScopes,
  incomingPermissionRequests,
  pairAccessSummary,
  pendingScopes,
  splitGrants,
  uuidV4,
  type AccessScope,
  type DurationChoice,
  type EpochMs,
  type IncomingPermissionRequest,
  type OutgoingShareView,
  type PairAccess,
  type PermissionGrantDoc,
  type RequestableScope,
  type SessionId,
  type UserId,
} from '@konum/core';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { now as serverClockNow } from '../lib/clock';
import { toKonumError } from '../lib/errors';
import { deviceTimeZone } from '../lib/timeZone';
import { accessApi, type AccessApi } from '../services/firebase/callables';
import { sharingStore } from './sharingStore';

export type GrantDirection = 'given' | 'received';

export type GrantActionError = { ok: false; code: string; message: string };

export type RequestResult = { ok: true; status: 'sent' | 'already_granted' } | GrantActionError;

export type RespondResult =
  | {
      ok: true;
      grantedScopes: RequestableScope[];
      declinedScopes: RequestableScope[];
      /** Aynı işlemde paylaşım başladı mı. */
      shareStarted: boolean;
      /** Paylaşım istendi ama başlamadıysa neden. */
      shareSkipped: 'invisible' | 'no_location_view' | null;
    }
  | GrantActionError;

export type SetScopeResult = { ok: true; scopes: AccessScope[] } | GrantActionError;

export interface GrantsStoreDeps {
  api: AccessApi;
  now: () => EpochMs;
  newOpId: () => string;
  timeZone: () => string;
  /** "İzin ver + paylaş" ile başlayan oturum gönderen deposuna işlenir. */
  onShareStarted: (sessionId: SessionId, shares: readonly OutgoingShareView[]) => void;
  /** Callable yanıtındaki kapsamların dinleyici yetişene kadar tutulma süresi (ms). */
  patchHoldMs: number;
}

interface ScopePatch {
  scopes: AccessScope[];
  /** Callable sürerken süresiz; yanıt gelince `now + patchHoldMs`. */
  until: EpochMs | null;
}

export interface GrantsStoreState {
  myUid: UserId | null;
  /** Ham sunucu belgeleri (iki yön). */
  docs: PermissionGrantDoc[];
  /** Benim verdiklerim (anahtar = karşı taraf), iyimser yamalar uygulanmış. */
  given: Record<UserId, PermissionGrantDoc>;
  /** Bana verilenler (anahtar = veren). */
  received: Record<UserId, PermissionGrantDoc>;
  /** İlk anlık görüntü geldi mi (gelmeden "izin yok" sonucu çıkarılmaz). */
  loaded: boolean;
  /** Bildirimden açılan istek: Arkadaşlar ekranı bu kişinin isteğini öne çıkarır. */
  focusRequesterId: UserId | null;
  /** Süren işlemler: `request:<id>`, `respond:<id>`, `set:<id>:<scope>`. */
  busy: Record<string, true>;
  /** Bu cihazda konum izni geri alınan kişiler (geri alma anı). Yayın süzgeci bunlara yayını hemen keser. */
  locationRevoked: Record<UserId, EpochMs>;
  error: string | null;

  setSnapshot: (uid: UserId, docs: readonly PermissionGrantDoc[]) => void;
  reset: () => void;
  request: (targetId: UserId, scopes: readonly RequestableScope[]) => Promise<RequestResult>;
  /** İsteği yanıtla: `grantScopes` verilenler (kalanı reddedilir); `share` verilirse aynı işlemde paylaşım başlar. */
  respond: (requesterId: UserId, grantScopes: readonly RequestableScope[], share?: { duration: DurationChoice } | null) => Promise<RespondResult>;
  /** Hepsini reddet (karşı tarafa bildirim gitmez). */
  decline: (requesterId: UserId) => Promise<RespondResult>;
  /** Kişi izinleri anahtarı (yalnızca benim verdiğim izin). */
  setScope: (granteeId: UserId, scope: RequestableScope, granted: boolean) => Promise<SetScopeResult>;
  /** Ağ hatasında kalan konum izni geri almalarını aynı op_id ile yeniden gönderir (bağlantı geldi). */
  retryPendingRevokes: () => Promise<void>;
  focusRequest: (requesterId: UserId | null) => void;

  myGrantTo: (friendId: UserId) => PermissionGrantDoc | null;
  theirGrantTo: (friendId: UserId) => PermissionGrantDoc | null;
  incomingRequests: (now?: EpochMs) => IncomingPermissionRequest[];
  accessSummary: (friendId: UserId) => PairAccess;
  can: (scope: AccessScope, friendId: UserId, direction: GrantDirection) => boolean;
}

const PATCH_HOLD_MS = 2 * 60_000;

function sameScopes(a: readonly AccessScope[], b: readonly AccessScope[]): boolean {
  return a.length === b.length && a.every((s) => b.includes(s));
}

function withScopes(doc: PermissionGrantDoc | undefined, granter: UserId, grantee: UserId, scopes: readonly AccessScope[], t: EpochMs): PermissionGrantDoc {
  const base: PermissionGrantDoc = doc ?? { granter_id: granter, grantee_id: grantee, scopes: {}, pending: null, declined_at: {}, updated_at: t, version: 0 };
  const next: PermissionGrantDoc['scopes'] = {};
  for (const s of scopes) next[s] = base.scopes[s] ?? { granted_at: t, via: 'manual' };
  // Verilen kapsam bekleyen istekten düşer.
  const pending = base.pending ? { ...base.pending, scopes: base.pending.scopes.filter((s) => !scopes.includes(s)) } : null;
  return { ...base, scopes: next, pending: pending && pending.scopes.length ? pending : null };
}

export function createGrantsStore(overrides: Partial<GrantsStoreDeps> = {}): StoreApi<GrantsStoreState> {
  const deps: GrantsStoreDeps = {
    api: accessApi,
    now: serverClockNow,
    newOpId: uuidV4,
    timeZone: deviceTimeZone,
    onShareStarted: (id, shares) => sharingStore.getState().adoptStartedSession(id, shares),
    patchHoldMs: PATCH_HOLD_MS,
    ...overrides,
  };
  const patches = new Map<UserId, ScopePatch>();
  /** Yanıtlanan istekler: dinleyici yetişene kadar kartta yeniden görünmesin. */
  const answered = new Map<UserId, EpochMs>();
  const inflight = new Map<string, Promise<unknown>>();
  /** Ağ hatasıyla biten konum izni geri almaları (kişi → op_id): kesim sürer, bağlantı gelince yeniden gönderilir. */
  const pendingRevokes = new Map<UserId, string>();

  return createStore<GrantsStoreState>()((set, get) => {
    function recompute(docs: readonly PermissionGrantDoc[], uid: UserId | null) {
      if (!uid) return { given: {}, received: {} };
      const t = deps.now();
      const { given, received } = splitGrants(docs, uid);
      for (const [id, p] of patches) {
        const cur = given[id];
        if (p.until !== null && (t > p.until || sameScopes(grantedScopes(cur), p.scopes))) {
          patches.delete(id);
          continue;
        }
        given[id] = withScopes(cur, uid, id, p.scopes, t);
      }
      for (const [id, until] of answered) {
        const cur = given[id];
        if (t > until || !cur?.pending) answered.delete(id);
        else given[id] = { ...cur, pending: null };
      }
      return { given, received };
    }

    function refresh() {
      const { docs, myUid } = get();
      set(recompute(docs, myUid));
    }

    /** İzin yeniden verildiyse (geri almadan sonraki `granted_at`) süzgeçten çıkar. */
    function pruneRevoked(given: Record<UserId, PermissionGrantDoc>, revoked: Record<UserId, EpochMs>): Record<UserId, EpochMs> {
      let out = revoked;
      for (const [id, at] of Object.entries(revoked)) {
        const g = given[id]?.scopes.location_view;
        if (g && g.granted_at > at) {
          if (out === revoked) out = { ...revoked };
          delete out[id];
        }
      }
      return out;
    }

    function unrevoke(id: UserId) {
      const cur = get().locationRevoked;
      if (!(id in cur)) return;
      const { [id]: _gone, ...rest } = cur;
      set({ locationRevoked: rest });
    }

    function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const cur = inflight.get(key) as Promise<T> | undefined;
      if (cur) return cur;
      set({ busy: { ...get().busy, [key]: true } });
      const p = fn().finally(() => {
        inflight.delete(key);
        const { [key]: _done, ...rest } = get().busy;
        set({ busy: rest });
      });
      inflight.set(key, p);
      return p;
    }

    const fail = (e: unknown): GrantActionError => {
      const err = toKonumError(e);
      set({ error: err.message });
      return { ok: false, code: err.code, message: err.message };
    };

    return {
      myUid: null,
      docs: [],
      given: {},
      received: {},
      loaded: false,
      focusRequesterId: null,
      busy: {},
      error: null,
      locationRevoked: {},

      setSnapshot: (uid, docs) => {
        const list = docs.filter((d) => d.granter_id === uid || d.grantee_id === uid);
        const sameUser = get().myUid === uid;
        if (!sameUser) {
          patches.clear();
          answered.clear();
        }
        const next = recompute(list, uid);
        const revoked = sameUser ? pruneRevoked(splitGrants(list, uid).given, get().locationRevoked) : {};
        set({ myUid: uid, docs: list, loaded: true, locationRevoked: revoked, ...next });
      },

      reset: () => {
        patches.clear();
        answered.clear();
        inflight.clear();
        pendingRevokes.clear();
        set({ myUid: null, docs: [], given: {}, received: {}, loaded: false, focusRequesterId: null, busy: {}, error: null, locationRevoked: {} });
      },

      request: (targetId, scopes) =>
        once<RequestResult>(`request:${targetId}`, async () => {
          if (scopes.length === 0) return { ok: false, code: 'invalid_argument', message: 'En az bir izin seçin' };
          set({ error: null });
          try {
            const res = await deps.api.permissionRequestSend({ op_id: deps.newOpId(), target_id: targetId, scopes: [...scopes] });
            return { ok: true, status: res.status };
          } catch (e) {
            return fail(e);
          }
        }),

      respond: (requesterId, grantScopes, share = null) =>
        once<RespondResult>(`respond:${requesterId}`, async () => {
          set({ error: null });
          const uid = get().myUid;
          const before = grantedScopes(get().given[requesterId]);
          try {
            const res = await deps.api.permissionRequestRespond({
              op_id: deps.newOpId(),
              requester_id: requesterId,
              grant_scopes: [...grantScopes],
              share: share ? { duration: share.duration, time_zone: deps.timeZone() } : null,
            });
            answered.set(requesterId, deps.now() + deps.patchHoldMs);
            if (res.granted_scopes.includes('location_view')) unrevoke(requesterId);
            if (uid && res.granted_scopes.length > 0) {
              patches.set(requesterId, { scopes: [...new Set<AccessScope>([...before, ...res.granted_scopes])], until: deps.now() + deps.patchHoldMs });
            }
            if (res.share && res.share.shares.length > 0) deps.onShareStarted(res.share.session_id, res.share.shares);
            if (get().focusRequesterId === requesterId) set({ focusRequesterId: null });
            refresh();
            return {
              ok: true,
              grantedScopes: res.granted_scopes,
              declinedScopes: res.declined_scopes,
              shareStarted: !!res.share && res.share.shares.length > 0,
              shareSkipped: res.share_skipped,
            };
          } catch (e) {
            return fail(e);
          }
        }),

      decline: (requesterId) => get().respond(requesterId, [], null),

      setScope: (granteeId, scope, granted) =>
        once<SetScopeResult>(`set:${granteeId}:${scope}`, async () => {
          set({ error: null });
          const cur = grantedScopes(get().given[granteeId]);
          const optimistic = granted ? [...new Set<AccessScope>([...cur, scope])] : cur.filter((s) => s !== scope);
          patches.set(granteeId, { scopes: optimistic, until: null });
          const prevRevokedAt = get().locationRevoked[granteeId];
          // Konum izni kapanınca yayın bu satırda kesilir (sunucu paylaşımı bitirmeyi beklemeden).
          if (scope === 'location_view' && !granted) set({ locationRevoked: { ...get().locationRevoked, [granteeId]: deps.now() } });
          refresh();
          const revoke = scope === 'location_view' && !granted;
          if (scope === 'location_view' && granted) pendingRevokes.delete(granteeId);
          const opId = (revoke && pendingRevokes.get(granteeId)) || deps.newOpId();
          try {
            const res = await deps.api.permissionSet({ op_id: opId, grantee_id: granteeId, scope, granted });
            if (revoke) pendingRevokes.delete(granteeId);
            patches.set(granteeId, { scopes: res.scopes, until: deps.now() + deps.patchHoldMs });
            if (scope === 'location_view' && granted) unrevoke(granteeId);
            refresh();
            return { ok: true, scopes: res.scopes };
          } catch (e) {
            const code = toKonumError(e).code;
            if (revoke && (code === 'unavailable' || code === 'internal')) {
              // Sunucuya ulaşıp ulaşmadığı bilinmiyor: kesim ve yama kalır, aynı op_id ile yeniden denenir.
              pendingRevokes.set(granteeId, opId);
              return fail(e);
            }
            if (revoke) pendingRevokes.delete(granteeId);
            patches.delete(granteeId);
            if (scope === 'location_view' && !granted) {
              if (prevRevokedAt === undefined) unrevoke(granteeId);
              else set({ locationRevoked: { ...get().locationRevoked, [granteeId]: prevRevokedAt } });
            }
            refresh();
            return fail(e);
          }
        }),

      retryPendingRevokes: async () => {
        await Promise.all([...pendingRevokes.keys()].map((id) => get().setScope(id, 'location_view', false)));
      },

      focusRequest: (requesterId) => set({ focusRequesterId: requesterId }),

      myGrantTo: (friendId) => get().given[friendId] ?? null,
      theirGrantTo: (friendId) => get().received[friendId] ?? null,
      incomingRequests: (now) => {
        const { myUid } = get();
        if (!myUid) return [];
        return incomingPermissionRequests(Object.values(get().given), myUid, now ?? deps.now());
      },
      accessSummary: (friendId) => pairAccessSummary(get().given[friendId], get().received[friendId]),
      can: (scope, friendId, direction) => {
        const doc = direction === 'given' ? get().given[friendId] : get().received[friendId];
        return doc?.scopes?.[scope] != null;
      },
    };
  });
}

export const grantsStore = createGrantsStore();

export function useGrantsStore<T>(selector: (s: GrantsStoreState) => T): T {
  return useStore(grantsStore, selector);
}

// --- seçiciler (saf; arayüz kancaları aşağıda) ----------------------------------------------------

export function selectMyGrantTo(s: Pick<GrantsStoreState, 'given'>, friendId: UserId): PermissionGrantDoc | null {
  return s.given[friendId] ?? null;
}

export function selectTheirGrantTo(s: Pick<GrantsStoreState, 'received'>, friendId: UserId): PermissionGrantDoc | null {
  return s.received[friendId] ?? null;
}

export function selectAccessSummary(s: Pick<GrantsStoreState, 'given' | 'received'>, friendId: UserId): PairAccess {
  return pairAccessSummary(s.given[friendId], s.received[friendId]);
}

export function selectCan(s: Pick<GrantsStoreState, 'given' | 'received'>, scope: AccessScope, friendId: UserId, direction: GrantDirection): boolean {
  const doc = direction === 'given' ? s.given[friendId] : s.received[friendId];
  return doc?.scopes?.[scope] != null;
}

export function selectIncomingRequests(s: Pick<GrantsStoreState, 'given' | 'myUid'>, now: EpochMs): IncomingPermissionRequest[] {
  if (!s.myUid) return [];
  return incomingPermissionRequests(Object.values(s.given), s.myUid, now);
}

/** Benim o kişiye gönderdiğim, henüz yanıtlanmamış istek kapsamları ("İstek gönderildi"). */
export function selectMyPendingRequestTo(s: Pick<GrantsStoreState, 'received'>, friendId: UserId, now: EpochMs): RequestableScope[] {
  return pendingScopes(s.received[friendId], now);
}

/**
 * Yayın süzgeci: bu cihazda konum izni geri alınan kişiye yayın yok (sunucu paylaşımı bitirene kadar da). Sunucunun
 * onayladığı paylaşım zaten izin ister; süzgeç yalnızca geri alma anındaki boşluğu kapatır.
 */
export function isLocationRevoked(s: Pick<GrantsStoreState, 'locationRevoked'>, receiverId: UserId): boolean {
  return s.locationRevoked[receiverId] !== undefined;
}

export function useMyGrantTo(friendId: UserId): PermissionGrantDoc | null {
  return useGrantsStore((s) => s.given[friendId] ?? null);
}

export function useTheirGrantTo(friendId: UserId): PermissionGrantDoc | null {
  return useGrantsStore((s) => s.received[friendId] ?? null);
}

export function useAccessSummary(friendId: UserId): PairAccess {
  return useGrantsStore((s) => selectAccessSummary(s, friendId));
}

export function useCan(scope: AccessScope, friendId: UserId, direction: GrantDirection): boolean {
  return useGrantsStore((s) => selectCan(s, scope, friendId, direction));
}

/** "İzin istekleri" kartı. `now` verilmezse belge her değiştiğinde yeniden hesaplanır (süre dolumu için ekran saati verir). */
export function useIncomingPermissionRequests(now?: EpochMs): IncomingPermissionRequest[] {
  const given = useGrantsStore((s) => s.given);
  const myUid = useGrantsStore((s) => s.myUid);
  return useMemo(() => selectIncomingRequests({ given, myUid }, now ?? serverClockNow()), [given, myUid, now]);
}

export function useMyPendingRequestTo(friendId: UserId, now?: EpochMs): RequestableScope[] {
  const doc = useGrantsStore((s) => s.received[friendId]);
  return useMemo(() => pendingScopes(doc, now ?? serverClockNow()), [doc, now]);
}
