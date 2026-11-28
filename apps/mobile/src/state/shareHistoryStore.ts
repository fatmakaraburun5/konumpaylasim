/**
 * Faz 12: cihazdaki giden paylaşım geçmişi (core `frequentContacts.ts`) → "Sık paylaştıkların" kısayolları.
 *
 * Kayıt yalnızca bu cihazda, hesaba bağlı (`konum.f12.shareHistory.v1`); sunucuya gitmez. f12Services sharingStore'u
 * izler: onaylanmış her yeni giden paylaşım (alıcı başına, `share_id` tekil) eklenir — paylaş sayfası, kısayol,
 * widget, Konum İste onayı fark etmez. Arkadaşlıktan çıkan kişi sıralamada zaten elenir; "Öneriden kaldır" geçmişini siler.
 */
import { forgetContact, mergeHistory, parseHistory, type EpochMs, type ShareHistoryEntry, type UserId } from '@konum/core';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { loadShareHistory, saveShareHistory } from './persist';

export interface ShareHistoryState {
  uid: UserId | null;
  entries: ShareHistoryEntry[];
  hydrate: (uid: UserId) => Promise<void>;
  record: (add: readonly ShareHistoryEntry[], now: EpochMs) => void;
  forget: (receiver: UserId) => void;
  reset: () => void;
}

let writes: Promise<unknown> = Promise.resolve();
function persist(uid: UserId | null, entries: ShareHistoryEntry[]) {
  if (!uid) return;
  writes = writes.then(() => saveShareHistory({ uid, entries })).catch(() => undefined);
}

export const shareHistoryStore = createStore<ShareHistoryState>()((set, get) => ({
  uid: null,
  entries: [],
  hydrate: async (uid) => {
    const v = await loadShareHistory().catch(() => null);
    const disk = v && v.uid === uid ? parseHistory(v.entries) : [];
    // Diskten önce kaydedilenler (açılışta gelen anlık görüntü) korunur.
    const mem = get().uid === uid ? get().entries : [];
    set({ uid, entries: mergeHistory(disk, mem, Date.now()) });
  },
  record: (add, now) => {
    if (!add.length) return;
    const cur = get().entries;
    const known = new Set(cur.map((e) => e.share_id));
    if (add.every((e) => known.has(e.share_id))) return;
    const entries = mergeHistory(cur, add, now);
    set({ entries });
    persist(get().uid, entries);
  },
  forget: (receiver) => {
    const entries = forgetContact(get().entries, receiver);
    set({ entries });
    persist(get().uid, entries);
  },
  reset: () => set({ uid: null, entries: [] }),
}));

export function useShareHistory<T>(selector: (s: ShareHistoryState) => T): T {
  return useStore(shareHistoryStore, selector);
}
