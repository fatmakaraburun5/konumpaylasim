/**
 * Arkadaşlar: Firestore `friendships` (kabul edilmiş + bana gelen bekleyen) ve `users/{ben}/outgoing_requests`
 * (gönderdiğim istekler, maskeli etiketle). Yalnızca `accepted` olanlar
 * paylaşım alıcısı olabilir. Görünen adlar `member_profiles` kopyasından gelir (users/{uid} yalnızca sahibine açık).
 */
import { normalizeInviteCode, type Friendship, type FriendshipId, type UserId } from '@konum/core';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { KonumError, toKonumError } from '../lib/errors';
import type { OutgoingRequest } from '../services/firebase/profileRepo';
import {
  friendRequestCancel,
  friendRequestRespond,
  friendRequestSendByInviteCode,
  friendshipRemove,
} from '../services/firebase/callables';

export interface Friend {
  uid: UserId;
  friendshipId: FriendshipId;
  displayName: string;
  avatarUrl: string | null;
}

/** Bana gelen bekleyen istek. */
export type FriendRequestView = Friend;

/** Gönderdiğim istek: karşı tarafın kimliği bilinmez, yalnızca etiket (maskeli numara / davet kodu). */
export type OutgoingRequestView = OutgoingRequest;

interface FriendsState {
  myUid: UserId | null;
  friendships: Friendship[];
  outgoing: OutgoingRequest[];
  loaded: boolean;
  setSnapshot: (myUid: UserId, list: Friendship[]) => void;
  setOutgoing: (list: OutgoingRequest[]) => void;
  reset: () => void;
  addByInviteCode: (input: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  respond: (friendshipId: FriendshipId, accept: boolean) => Promise<FriendOpResult>;
  /** Giden isteği iptal eder (outgoing_requests kaydının kimliği). */
  cancel: (outgoingId: string) => Promise<FriendOpResult>;
  remove: (friendshipId: FriendshipId) => Promise<FriendOpResult>;
}

/** Arkadaşlık işlemi sonucu: başarısızlıkta arayüzde gösterilecek Türkçe metin (core ERROR_CODES). */
export type FriendOpResult = { ok: true } | { ok: false; message: string };

export const friendsStore = createStore<FriendsState>()((set) => ({
  myUid: null,
  friendships: [],
  outgoing: [],
  loaded: false,
  setSnapshot: (myUid, list) => set({ myUid, friendships: list, loaded: true }),
  setOutgoing: (list) => set({ outgoing: list }),
  reset: () => set({ myUid: null, friendships: [], outgoing: [], loaded: false }),

  addByInviteCode: async (input) => {
    const code = normalizeInviteCode(input);
    if (!code) return { ok: false, message: 'Davet kodu LOC- ve 6 karakterden oluşur' };
    try {
      await friendRequestSendByInviteCode(code);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: toKonumError(e).message };
    }
  },
  respond: async (id, accept) => run(() => friendRequestRespond(id, accept)),
  cancel: async (id) => run(() => friendRequestCancel(id)),
  remove: async (id) => run(() => friendshipRemove(id)),
}));

async function run(fn: () => Promise<unknown>): Promise<FriendOpResult> {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    if (__DEV__ && !(e instanceof KonumError)) console.warn('[konum] arkadaşlık işlemi başarısız', e);
    return { ok: false, message: toKonumError(e).message };
  }
}

function otherOf(f: Friendship, me: UserId): Friend {
  const uid = f.member_ids[0] === me ? f.member_ids[1] : f.member_ids[0];
  const p = f.member_profiles[uid];
  return { uid, friendshipId: f.id, displayName: p?.display_name || 'Arkadaş', avatarUrl: p?.avatar_url ?? null };
}

export function selectFriends(s: Pick<FriendsState, 'myUid' | 'friendships'>): Friend[] {
  if (!s.myUid) return [];
  const me = s.myUid;
  return s.friendships
    .filter((f) => f.status === 'accepted')
    .map((f) => otherOf(f, me))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'tr'));
}

/** Bana gelen bekleyen istekler (kurallar gereği okunabilen her `pending` belge bana gelendir). */
export function selectRequests(s: Pick<FriendsState, 'myUid' | 'friendships'>): FriendRequestView[] {
  if (!s.myUid) return [];
  const me = s.myUid;
  return s.friendships.filter((f) => f.status === 'pending' && f.requested_by !== me).map((f) => otherOf(f, me));
}

/** Süresi dolmamış giden istekler. */
export function selectOutgoing(s: Pick<FriendsState, 'outgoing'>, now: number): OutgoingRequestView[] {
  return s.outgoing.filter((o) => o.expires_at > now);
}

export function useFriendsStore<T>(selector: (s: FriendsState) => T): T {
  return useStore(friendsStore, selector);
}

export function useFriends(): Friend[] {
  const myUid = useFriendsStore((s) => s.myUid);
  const friendships = useFriendsStore((s) => s.friendships);
  return useMemo(() => selectFriends({ myUid, friendships }), [myUid, friendships]);
}

export function useFriendRequests(): FriendRequestView[] {
  const myUid = useFriendsStore((s) => s.myUid);
  const friendships = useFriendsStore((s) => s.friendships);
  return useMemo(() => selectRequests({ myUid, friendships }), [myUid, friendships]);
}

export function useOutgoingRequests(): OutgoingRequestView[] {
  const outgoing = useFriendsStore((s) => s.outgoing);
  return useMemo(() => selectOutgoing({ outgoing }, Date.now()), [outgoing]);
}

/** uid → görünen ad (alıcı avatarları için). */
export function useFriendNames(): Record<UserId, string> {
  const friends = useFriends();
  return useMemo(() => Object.fromEntries(friends.map((f) => [f.uid, f.displayName])), [friends]);
}
