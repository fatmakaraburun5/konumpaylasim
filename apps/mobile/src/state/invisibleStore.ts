/**
 * Faz 8: görünmez mod. Sunucu gerçeği `users/{uid}.invisible` (authStore profili); istemci niyeti `publishHold`
 * kesme anahtarındadır (bellek + `konum.bg.invisible.v1`).
 *
 *  - `setInvisible()`: niyet ÖNCE yazılır (bellek anında → yayın o satırda kesilir; sonra disk), sonra
 *    `invisible_set(true)`. Ağ yoksa niyet kalır, yayın kapalı kalır; açılışta / bağlantı gelince AYNI op_id ile
 *    yeniden gönderilir (`retryPending`).
 *  - `setVisible(restoreIds)`: `invisible_set(false, restore_receiver_ids)`; yalnızca seçilen alıcılar geri gelir
 *    (varsayılan hiçbiri). Niyet yalnızca BAŞARILI yanıtla silinir (hata → niyet ve yayın kesimi kalır). Niyet sunucuya
 *    ulaştığı doğrulanmamışsa önce aynı op_id ile `invisible_set(true)` gönderilir: sunucu eski paylaşımları bitirir,
 *    hiçbiri kendiliğinden geri gelmez (§1.5).
 *  - `clearAfterServerVisible()`: sunucu görünmezliği kendisi kapattı (ör. `sos_send` yanıtı): niyet ve yerel profil
 *    hemen temizlenir (profil anlık görüntüsü beklenmez).
 *  - `applyServer`: profil anlık görüntüsü. Sunucu `on` gösterirse niyet onaylanır (yalnızca burada) (başka cihazdan açıldıysa da
 *    yayın kesilir); sunucu görünür derse onaylanmış niyet silinir (ör. SOS görünmezliği kapattı). Onaylanmamış
 *    niyet silinmez: istek henüz işlenmemiş olabilir.
 *
 * Arayüz `selectIsInvisible` kullanır: niyet ya da sunucu `on` → "Görünmezsin".
 */
import { INVISIBLE_TEXT, restorableEntries, uuidV4, type EpochMs, type InvisibleSnapshotEntry, type InvisibleState, type UserId } from '@konum/core';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { now as serverClockNow } from '../lib/clock';
import { toKonumError } from '../lib/errors';
import { invisibleApi, type InvisibleApi } from '../services/firebase/callables';
import { authStore } from './authStore';
import { confirmInvisibleIntent, invisibleIntent, onPublishHoldChange, setInvisibleIntent } from './publishHold';

export type InvisibleResult = { ok: true } | { ok: false; code: string; message: string };
export type VisibleResult =
  | { ok: true; restoredReceiverIds: UserId[]; skippedReceiverIds: UserId[] }
  | { ok: false; code: string; message: string };

export interface InvisibleStoreDeps {
  api: InvisibleApi;
  now: () => EpochMs;
  newOpId: () => string;
  /** Oturumdaki kullanıcı. */
  uid: () => UserId | null;
  /** Görünür olunca profil yerelde hemen güncellenir (dinleyici yetişene kadar). */
  patchProfile: (invisible: InvisibleState | null) => void;
}

export interface InvisibleStoreState {
  /** Sunucu gerçeği (profil). */
  server: InvisibleState | null;
  /** Yerel niyet var mı (publishHold aynası; arayüz için reaktif). */
  intent: boolean;
  busy: 'on' | 'off' | null;
  error: string | null;
  /** Görünmez ol. `false` verilirse `setVisible([])` ile aynı. */
  setInvisible: (on?: boolean) => Promise<InvisibleResult>;
  /** Görünür ol: yalnızca seçilen alıcılarla paylaşım eski bitiş saatine kadar geri yüklenir. */
  setVisible: (restoreReceiverIds?: readonly UserId[]) => Promise<VisibleResult>;
  applyServer: (uid: UserId, state: InvisibleState | null) => void;
  /** Onaylanmamış görünmez niyetini aynı op_id ile yeniden gönderir (açılış, bağlantı geldi). */
  retryPending: () => Promise<void>;
  /** Sunucu görünmezliği kapattı (ör. SOS gönderildi): niyet + yerel profil hemen silinir. */
  clearAfterServerVisible: () => Promise<void>;
  reset: () => void;
}

export function createInvisibleStore(overrides: Partial<InvisibleStoreDeps> = {}): StoreApi<InvisibleStoreState> {
  const deps: InvisibleStoreDeps = {
    api: invisibleApi,
    now: serverClockNow,
    newOpId: uuidV4,
    uid: () => authStore.getState().uid,
    patchProfile: (invisible) => authStore.getState().patchProfileLocal({ invisible }),
    ...overrides,
  };
  let inflight: Promise<unknown> | null = null;

  const store = createStore<InvisibleStoreState>()((set, get) => {
    const fail = (e: unknown) => {
      const err = toKonumError(e);
      set({ error: err.message });
      return { ok: false as const, code: err.code, message: err.message };
    };

    async function sendOn(uid: UserId, opId: string): Promise<InvisibleResult> {
      set({ busy: 'on', error: null });
      try {
        await deps.api.invisibleSet({ op_id: opId, invisible: true });
        // Niyet burada ONAYLANMAZ: onay yalnızca profil anlık görüntüsü `on` gösterince gelir (`applyServer`). Böylece
        // yanıttan sonra gelen eski bir "görünür" anlık görüntü niyeti silemez.
        return { ok: true };
      } catch (e) {
        // Niyet kalır: yayın kapalı kalır, bağlantı gelince aynı op_id ile yeniden denenir.
        return fail(e);
      } finally {
        set({ busy: null });
      }
    }

    return {
      server: null,
      intent: invisibleIntent() !== null,
      busy: null,
      error: null,

      setInvisible: (on = true) => {
        if (!on) return get().setVisible([]);
        if (inflight) return inflight as Promise<InvisibleResult>;
        const p = (async (): Promise<InvisibleResult> => {
          const uid = deps.uid();
          if (!uid) return { ok: false, code: 'unauthenticated', message: 'Oturum bulunamadı' };
          const cur = invisibleIntent(uid);
          const opId = cur && !cur.confirmed && cur.op_id ? cur.op_id : deps.newOpId();
          // ÖNCE niyet: bellek anında (yayın kesilir), disk yazımı beklenir (başsız bağlam da görsün).
          const written = setInvisibleIntent(uid, { op_id: opId, at: deps.now(), confirmed: cur?.confirmed ?? false });
          await written.catch(() => undefined);
          if (cur?.confirmed && get().server?.on) return { ok: true };
          return sendOn(uid, opId);
        })().finally(() => {
          inflight = null;
        });
        inflight = p;
        return p;
      },

      setVisible: (restoreReceiverIds = []) => {
        if (inflight) return inflight.then(() => get().setVisible(restoreReceiverIds));
        const p = (async (): Promise<VisibleResult> => {
          const uid = deps.uid();
          if (!uid) return { ok: false, code: 'unauthenticated', message: 'Oturum bulunamadı' };
          set({ busy: 'off', error: null });
          try {
            const cur = invisibleIntent(uid);
            if (cur && !cur.confirmed && !get().server?.on) {
              // Görünmez olma isteği sunucuya ulaşmamış olabilir: önce o (aynı op_id) → eski paylaşımlar sunucuda biter.
              const opId = cur.op_id || deps.newOpId();
              if (!cur.op_id) await setInvisibleIntent(uid, { ...cur, op_id: opId }).catch(() => undefined);
              await deps.api.invisibleSet({ op_id: opId, invisible: true });
            }
            const res = await deps.api.invisibleSet({
              op_id: deps.newOpId(),
              invisible: false,
              restore_receiver_ids: [...new Set(restoreReceiverIds)],
            });
            await setInvisibleIntent(uid, null).catch(() => undefined);
            deps.patchProfile(null);
            set({ server: null });
            return { ok: true, restoredReceiverIds: res.restored_receiver_ids, skippedReceiverIds: res.skipped_receiver_ids };
          } catch (e) {
            // Niyet KALIR: yalnızca sunucunun "görünür" yanıtı kaldırır (onaylanmamışsa bağlantı gelince aynı op_id ile
            // yeniden gönderilir). Yayın kesimi sürer.
            return fail(e);
          } finally {
            set({ busy: null });
          }
        })().finally(() => {
          inflight = null;
        });
        inflight = p;
        return p;
      },

      applyServer: (uid, state) => {
        const on = !!state?.on;
        set({ server: on ? state : null });
        const cur = invisibleIntent(uid);
        if (on) {
          if (!cur?.confirmed) void confirmInvisibleIntent(uid, state?.since ?? deps.now()).catch(() => undefined);
          return;
        }
        if (get().busy === 'on' || !cur) return;
        if (cur.confirmed) void setInvisibleIntent(uid, null).catch(() => undefined);
      },

      retryPending: async () => {
        const uid = deps.uid();
        if (!uid || inflight) return;
        const cur = invisibleIntent(uid);
        if (!cur || cur.confirmed || get().server?.on) return;
        const opId = cur.op_id || deps.newOpId();
        if (!cur.op_id) await setInvisibleIntent(uid, { ...cur, op_id: opId }).catch(() => undefined);
        const p = sendOn(uid, opId).finally(() => {
          inflight = null;
        });
        inflight = p;
        await p;
      },

      clearAfterServerVisible: async () => {
        const uid = deps.uid();
        if (!uid) return;
        await setInvisibleIntent(uid, null).catch(() => undefined);
        deps.patchProfile(null);
        set({ server: null });
      },

      reset: () => {
        inflight = null;
        set({ server: null, intent: false, busy: null, error: null });
      },
    };
  });

  onPublishHoldChange(() => {
    const v = invisibleIntent() !== null;
    if (store.getState().intent !== v) store.setState({ intent: v });
  });
  return store;
}

export const invisibleStore = createInvisibleStore();

export function useInvisibleStore<T>(selector: (s: InvisibleStoreState) => T): T {
  return useStore(invisibleStore, selector);
}

/** "Görünmezsin": yerel niyet ya da sunucu `on`. */
export function selectIsInvisible(s: Pick<InvisibleStoreState, 'intent' | 'server'>): boolean {
  return s.intent || !!s.server?.on;
}

export function useIsInvisible(): boolean {
  return useInvisibleStore(selectIsInvisible);
}

/** Görünür olurken seçilebilecek, hâlâ geri yüklenebilir paylaşımlar (çok az süresi kalanlar düşer). */
export function selectRestorable(s: Pick<InvisibleStoreState, 'server'>, now: EpochMs): InvisibleSnapshotEntry[] {
  return restorableEntries(s.server?.snapshot ?? [], now);
}

export function useRestorableShares(now?: EpochMs): InvisibleSnapshotEntry[] {
  const server = useInvisibleStore((s) => s.server);
  return useMemo(() => selectRestorable({ server }, now ?? serverClockNow()), [server, now]);
}

export { INVISIBLE_TEXT };
