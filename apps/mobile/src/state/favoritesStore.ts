/**
 * Faz 6: favori kişiler (sıralı, en çok 4). Doğru kaynak `users/{ben}.favorite_ids` (profil dinleyicisi,
 * authStore.profile); yazma yalnızca `favorites_set` callable'ı. Sıra = widget sırası; ilk favori tek tuşla
 * paylaşımın varsayılan hedefidir.
 *
 *  - İyimser: yıldız / sıralama hemen görünür (`optimistic`), çağrı başarısızsa geri alınır ve hata metni çıkar.
 *  - Ardışık dokunuşlar sıraya girer; her çağrı TAM listeyi yazar (son yazan kazanır, op_id her çağrıda yeni).
 *  - Sınır doluysa liste değişmez, `FAVORITE_LIMIT_TEXT` gösterilir.
 *  - Görünen liste arkadaş olmayanlardan arındırılır (`sanitizeFavorites`; sunucu da aynısını yapar).
 */
import {
  FAVORITE_LIMIT_TEXT,
  FAVORITES_LIMIT,
  moveFavorite,
  sanitizeFavorites,
  toggleFavorite,
  type FavoritesSetResponse,
  type UserId,
} from '@konum/core';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { toKonumError } from '../lib/errors';
import { favoritesSet } from '../services/firebase/callables';
import { authStore, useAuthStore } from './authStore';
import { friendsStore, useFriendsStore } from './friendsStore';

export interface FavoritesState {
  /** İyimser liste (çağrı sürerken / sunucu yanıtı); null = profildeki liste. */
  optimistic: UserId[] | null;
  saving: boolean;
  error: string | null;
  toggle: (uid: UserId) => Promise<{ ok: boolean; limit: boolean }>;
  move: (uid: UserId, delta: number) => Promise<boolean>;
  setList: (list: readonly UserId[]) => Promise<boolean>;
  /** Profil dinleyicisi yeni liste getirdi: kayıt sürmüyorsa iyimser kopya bırakılır. */
  profileChanged: () => void;
  clearError: () => void;
  reset: () => void;
}

export interface FavoritesStoreDeps {
  api: (input: { favorite_ids: UserId[] }) => Promise<FavoritesSetResponse>;
  /** Profildeki (sunucu) liste. */
  serverList: () => readonly UserId[];
  /** Kabul edilmiş arkadaşlar; null = henüz yüklenmedi (süzme yapılmaz). */
  friendIds: () => ReadonlySet<UserId> | null;
}

/** Görünen favoriler: iyimser ya da sunucu listesi, arkadaş olmayanlar atılmış. Saf. */
export function selectFavoriteIds(server: readonly UserId[], optimistic: readonly UserId[] | null, friendIds: ReadonlySet<UserId> | null): UserId[] {
  const base = optimistic ?? server;
  return friendIds ? sanitizeFavorites(base, friendIds) : [...new Set(base)].slice(0, FAVORITES_LIMIT);
}

function acceptedFriendIds(): ReadonlySet<UserId> | null {
  const s = friendsStore.getState();
  if (!s.loaded || !s.myUid) return null;
  const me = s.myUid;
  return new Set(s.friendships.filter((f) => f.status === 'accepted').map((f) => (f.member_ids[0] === me ? f.member_ids[1] : f.member_ids[0])));
}

export function createFavoritesStore(overrides: Partial<FavoritesStoreDeps> = {}): StoreApi<FavoritesState> {
  const deps: FavoritesStoreDeps = {
    api: (input) => favoritesSet(input),
    serverList: () => authStore.getState().profile?.favorite_ids ?? [],
    friendIds: acceptedFriendIds,
    ...overrides,
  };
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;

  return createStore<FavoritesState>()((set, get) => {
    const current = () => selectFavoriteIds(deps.serverList(), get().optimistic, deps.friendIds());

    /** Listeyi iyimser uygular ve sıraya alınmış çağrıyla yazar. */
    function write(next: UserId[]): Promise<boolean> {
      const before = get().optimistic;
      pending++;
      set({ optimistic: next, saving: true, error: null });
      const run = queue.then(async () => {
        try {
          const res = await deps.api({ favorite_ids: next });
          // Daha yeni bir istek sıradaysa onun iyimser listesi ezilmez.
          if (pending === 1) set({ optimistic: res.favorite_ids });
          return true;
        } catch (e) {
          if (pending === 1) set({ optimistic: before, error: toKonumError(e).message });
          else set({ error: toKonumError(e).message });
          return false;
        } finally {
          pending--;
          if (pending === 0) set({ saving: false });
        }
      });
      queue = run.catch(() => undefined);
      return run;
    }

    return {
      optimistic: null,
      saving: false,
      error: null,

      toggle: async (uid) => {
        const r = toggleFavorite(current(), uid);
        if (r.error === 'limit') {
          set({ error: FAVORITE_LIMIT_TEXT });
          return { ok: false, limit: true };
        }
        return { ok: await write(r.list), limit: false };
      },

      move: async (uid, delta) => {
        const list = current();
        const next = moveFavorite(list, uid, delta);
        if (next.join() === list.join()) return true;
        return write(next);
      },

      setList: (list) => write(selectFavoriteIds(list, null, deps.friendIds())),

      profileChanged: () => {
        if (!get().saving && get().optimistic !== null) set({ optimistic: null });
      },

      clearError: () => set({ error: null }),

      reset: () => {
        queue = Promise.resolve();
        pending = 0;
        set({ optimistic: null, saving: false, error: null });
      },
    };
  });
}

export const favoritesStore = createFavoritesStore();

export function useFavoritesStore<T>(selector: (s: FavoritesState) => T): T {
  return useStore(favoritesStore, selector);
}

/** Görünen sıralı favoriler (widget sırası). */
export function useFavoriteIds(): UserId[] {
  const server = useAuthStore((s) => s.profile?.favorite_ids);
  const optimistic = useFavoritesStore((s) => s.optimistic);
  const friendships = useFriendsStore((s) => s.friendships);
  const loaded = useFriendsStore((s) => s.loaded);
  return useMemo(() => selectFavoriteIds(server ?? [], optimistic, loaded ? acceptedFriendIds() : null), [server, optimistic, friendships, loaded]);
}

/** Saf okuma (widget eşitleme, hızlı paylaşım varsayılan hedefi). */
export function currentFavoriteIds(): UserId[] {
  return selectFavoriteIds(authStore.getState().profile?.favorite_ids ?? [], favoritesStore.getState().optimistic, acceptedFriendIds());
}
