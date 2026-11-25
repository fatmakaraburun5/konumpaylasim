/**
 * "Konum İste" durumu. Sunucu doğrudur: `requestsRepo.listenLocationRequests` iki yönü (`setSnapshot`) verir; istemci
 * yalnızca callable çağırır (`send`, `cancel`, `approve`, `reject`).
 *
 *  - Giden (isteyen = ben): arkadaş başına son istek → core `outgoingRequestState` ("Yanıt bekleniyor", "Geri çek",
 *    "Şu an paylaşamıyor", bekleme süresi). Gönderim yanıtı dinleyiciden önce yerel belge olarak yamalanır.
 *  - Gelen (hedef = ben): bekleyen istekler (en yakın bitecek önde) → harita / Arkadaşlar kartı.
 *  - `openApprove(requestId)`: süre seçici sayfa açılır (bildirimdeki "Onayla" da buraya gelir).
 *  - Onay yanıtındaki paylaşım `sharingStore.adoptStartedSession` ile kitapçığa (ShareDeck) girer.
 *  - Yanıtlanan istek dinleyici yetişene kadar kartta yeniden görünmez.
 */
import {
  incomingPendingRequests,
  outgoingRequestState,
  requestId as requestIdOf,
  uuidV4,
  type DurationChoice,
  type EpochMs,
  type OutgoingRequestState,
  type OutgoingShareView,
  type SessionId,
  type UserId,
} from '@konum/core';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { now as serverClockNow } from '../lib/clock';
import { toKonumError } from '../lib/errors';
import type { LocationRequestDoc } from '../lib/schemas';
import { deviceTimeZone } from '../lib/timeZone';
import { locationRequestApi, type LocationRequestApi } from '../services/firebase/callables';
import { incomingStore } from './incomingStore';
import { sharingStore } from './sharingStore';

export type LocationRequestError = { ok: false; code: string; message: string };
export type SendResult = { ok: true; status: 'pending' | 'already_sharing' } | LocationRequestError;
export type ApproveResult = { ok: true } | LocationRequestError;

export interface LocationRequestDeps {
  api: LocationRequestApi;
  now: () => EpochMs;
  newOpId: () => string;
  timeZone: () => string;
  onShareStarted: (sessionId: SessionId, shares: readonly OutgoingShareView[]) => void;
  /** Bu kişi şu an bana aktif paylaşım yapıyor mu (düğme gizlenir). */
  sharingWithMe: (friendId: UserId, now: EpochMs) => boolean;
}

export interface LocationRequestState {
  uid: UserId | null;
  docs: Record<string, LocationRequestDoc>;
  /** Yanıtladığım istekler (dinleyici yetişene kadar kartta görünmesin). */
  answered: Record<string, EpochMs>;
  /** Süren işlemler: `send:<uid>`, `cancel:<id>`, `approve:<id>`, `reject:<id>`. */
  busy: Record<string, true>;
  /** Kişi başına son hata metni (satırda gösterilir). */
  errors: Record<string, string>;
  /** Süre seçici açık mı (istek kimliği). */
  approving: string | null;
  setSnapshot: (uid: UserId, docs: readonly LocationRequestDoc[]) => void;
  send: (targetId: UserId) => Promise<SendResult>;
  cancel: (targetId: UserId) => Promise<{ ok: boolean }>;
  openApprove: (requestId: string) => void;
  closeApprove: () => void;
  approve: (requestId: string, duration: DurationChoice) => Promise<ApproveResult>;
  reject: (requestId: string) => Promise<{ ok: boolean }>;
  reset: () => void;
}

function defaultSharingWithMe(friendId: UserId, now: EpochMs): boolean {
  return Object.values(incomingStore.getState().shares).some(
    (s) => s.sender_id === friendId && s.status === 'active' && (s.expires_at === null || s.expires_at > now),
  );
}

const fail = (e: unknown): LocationRequestError => {
  const k = toKonumError(e);
  return { ok: false, code: k.code, message: k.message };
};

export function createLocationRequestStore(overrides: Partial<LocationRequestDeps> = {}): StoreApi<LocationRequestState> {
  const deps: LocationRequestDeps = {
    api: locationRequestApi,
    now: serverClockNow,
    newOpId: uuidV4,
    timeZone: deviceTimeZone,
    onShareStarted: (id, shares) => sharingStore.getState().adoptStartedSession(id, shares),
    sharingWithMe: defaultSharingWithMe,
    ...overrides,
  };

  return createStore<LocationRequestState>()((set, get) => {
    const setBusy = (key: string, on: boolean) =>
      set((s) => {
        const { [key]: _x, ...rest } = s.busy;
        return { busy: on ? { ...rest, [key]: true } : rest };
      });
    const setError = (who: string, msg: string | null) =>
      set((s) => {
        const { [who]: _x, ...rest } = s.errors;
        return { errors: msg ? { ...rest, [who]: msg } : rest };
      });
    const patchDoc = (id: string, patch: Partial<LocationRequestDoc>) =>
      set((s) => {
        const cur = s.docs[id];
        return cur ? { docs: { ...s.docs, [id]: { ...cur, ...patch } } } : s;
      });
    const markAnswered = (id: string, status: 'approved' | 'rejected') => {
      const t = deps.now();
      patchDoc(id, { status, responded_at: t });
      set((s) => ({ answered: { ...s.answered, [id]: t } }));
    };

    return {
      uid: null,
      docs: {},
      answered: {},
      busy: {},
      errors: {},
      approving: null,

      setSnapshot: (uid, docs) => {
        const next: Record<string, LocationRequestDoc> = {};
        for (const d of docs) next[d.request_id] = d;
        // Dinleyici yanıtı gördüyse "yanıtlandı" işareti düşer.
        const answered: Record<string, EpochMs> = {};
        for (const [id, at] of Object.entries(get().answered)) if (next[id]?.status === 'pending') answered[id] = at;
        set({ uid, docs: next, answered });
      },

      send: async (targetId) => {
        const uid = get().uid;
        const key = `send:${targetId}`;
        if (!uid || get().busy[key]) return { ok: false, code: 'internal', message: '' };
        setBusy(key, true);
        setError(targetId, null);
        try {
          const r = await deps.api.locationRequestSend({ target_id: targetId, op_id: deps.newOpId() });
          if (r.status === 'pending' && r.expires_at !== null) {
            const id = r.request_id;
            const prev = get().docs[id];
            set((s) => ({
              docs: {
                ...s.docs,
                [id]: {
                  ...(prev ?? {}),
                  request_id: id,
                  requester_id: uid,
                  target_id: targetId,
                  status: 'pending',
                  created_at: prev?.status === 'pending' ? prev.created_at : r.server_now,
                  expires_at: r.expires_at as number,
                  responded_at: null,
                  share_id: null,
                },
              },
            }));
          }
          return { ok: true, status: r.status };
        } catch (e) {
          const f = fail(e);
          setError(targetId, f.message);
          return f;
        } finally {
          setBusy(key, false);
        }
      },

      cancel: async (targetId) => {
        const uid = get().uid;
        if (!uid) return { ok: false };
        const id = requestIdOf(uid, targetId);
        const key = `cancel:${id}`;
        if (get().busy[key]) return { ok: false };
        setBusy(key, true);
        const before = get().docs[id];
        patchDoc(id, { status: 'cancelled', responded_at: deps.now() });
        try {
          await deps.api.locationRequestCancel({ request_id: id, op_id: deps.newOpId() });
          return { ok: true };
        } catch (e) {
          if (before) set((s) => ({ docs: { ...s.docs, [id]: before } }));
          setError(targetId, fail(e).message);
          return { ok: false };
        } finally {
          setBusy(key, false);
        }
      },

      openApprove: (requestId) => set({ approving: requestId }),
      closeApprove: () => set({ approving: null }),

      approve: async (requestId, duration) => {
        const key = `approve:${requestId}`;
        if (get().busy[key]) return { ok: false, code: 'internal', message: '' };
        setBusy(key, true);
        try {
          const r = await deps.api.locationRequestRespond({
            request_id: requestId,
            accept: true,
            duration,
            time_zone: deps.timeZone(),
            op_id: deps.newOpId(),
          });
          markAnswered(requestId, 'approved');
          if (r.share && r.session_id) deps.onShareStarted(r.session_id, [r.share]);
          set({ approving: null });
          return { ok: true };
        } catch (e) {
          return fail(e);
        } finally {
          setBusy(key, false);
        }
      },

      reject: async (requestId) => {
        const key = `reject:${requestId}`;
        if (get().busy[key]) return { ok: false };
        setBusy(key, true);
        try {
          await deps.api.locationRequestRespond({ request_id: requestId, accept: false, op_id: deps.newOpId() });
          markAnswered(requestId, 'rejected');
          if (get().approving === requestId) set({ approving: null });
          return { ok: true };
        } catch (e) {
          const f = fail(e);
          // Artık geçerli değil (süresi doldu / geri çekildi): kart kapanır.
          if (f.code === 'already_expired' || f.code === 'share_not_active') markAnswered(requestId, 'rejected');
          return { ok: false };
        } finally {
          setBusy(key, false);
        }
      },

      reset: () => set({ uid: null, docs: {}, answered: {}, busy: {}, errors: {}, approving: null }),
    };
  });
}

export const locationRequestStore = createLocationRequestStore();

export function useLocationRequestStore<T>(selector: (s: LocationRequestState) => T): T {
  return useStore(locationRequestStore, selector);
}

/** İsteyen tarafın bu arkadaş için durumu. */
export function selectOutgoingState(
  s: Pick<LocationRequestState, 'uid' | 'docs'>,
  friendId: UserId,
  now: EpochMs,
  sharingWithMe = defaultSharingWithMe(friendId, now),
): OutgoingRequestState {
  if (!s.uid) return { kind: 'none' };
  return outgoingRequestState(s.docs[requestIdOf(s.uid, friendId)], sharingWithMe, now);
}

/** Hedef tarafın bekleyen gelen istekleri (yanıtladıklarım hariç). */
export function selectIncomingRequests(s: Pick<LocationRequestState, 'uid' | 'docs' | 'answered'>, now: EpochMs): LocationRequestDoc[] {
  if (!s.uid) return [];
  return incomingPendingRequests(Object.values(s.docs), s.uid, now).filter((d) => s.answered[d.request_id] === undefined);
}
