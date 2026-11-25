/**
 * Arkadaşlar: Firestore `friendships` (kabul edilmiş + bana gelen bekleyen) ve `users/{ben}/outgoing_requests`
 * (gönderdiğim istekler, maskeli etiketle). Yalnızca `accepted` olanlar
 * paylaşım alıcısı olabilir. Görünen adlar `member_profiles` kopyasından gelir (users/{uid} yalnızca sahibine açık).
 * Faz 6: aynı kopyada cinsiyet (çerçeve rengi) ve fotoğrafın iki boyu da vardır; bekleyen istekte yalnızca ad.
 */
import { avatarObjectPathFromUrl, normalizeInviteCode, parseAvatarObjectPath, type Friendship, type FriendshipId, type Gender, type UserId } from '@konum/core';
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
  /** Faz 6: 160 px küçük boy (pin / liste / widget); yoksa `avatarUrl`. */
  avatarThumbUrl: string | null;
  /** Faz 6: çerçeve rengi; eski hesap / bekleyen istek → null (gri). */
  gender: Gender | null;
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
  const accepted = f.status === 'accepted';
  return {
    uid,
    friendshipId: f.id,
    displayName: p?.display_name || 'Arkadaş',
    // Bekleyen istekte fotoğraf / cinsiyet gösterilmez (sözleşme: istek profili yalnızca ad taşır).
    avatarUrl: accepted ? (p?.avatar_url ?? null) : null,
    avatarThumbUrl: accepted ? (p?.avatar_thumb_url ?? null) : null,
    gender: accepted ? (p?.gender ?? null) : null,
  };
}

/** Avatar bileşeni için görünüm: küçük boy önce (pin / liste), önbellek anahtarı = Storage sürümü. */
export interface FriendAvatarProps {
  name: string;
  photoUrl: string | null;
  gender: Gender | null;
  recyclingKey: string | null;
}

/** İndirme adresinden sürüm (`avatars/{uid}/{sürüm}_160.jpg`) — önbellek anahtarı; çözülemezse adresin kendisi. */
export function avatarRecyclingKey(url: string | null): string | null {
  if (!url) return null;
  const ref = parseAvatarObjectPath(avatarObjectPathFromUrl(url) ?? '');
  return ref ? `${ref.uid}:${ref.version}` : url;
}

export function friendAvatarProps(f: Pick<Friend, 'displayName' | 'avatarUrl' | 'avatarThumbUrl' | 'gender'>, prefer: 'thumb' | 'main' = 'thumb'): FriendAvatarProps {
  const photoUrl = prefer === 'thumb' ? (f.avatarThumbUrl ?? f.avatarUrl) : (f.avatarUrl ?? f.avatarThumbUrl);
  return { name: f.displayName, photoUrl, gender: f.gender, recyclingKey: avatarRecyclingKey(photoUrl) };
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

/** Faz 6: uid → arkadaş (fotoğraf + cinsiyet; pin / liste / kart avatarları için). */
export function useFriendsById(): Record<UserId, Friend> {
  const friends = useFriends();
  return useMemo(() => Object.fromEntries(friends.map((f) => [f.uid, f])), [friends]);
}

/** uid → görünen ad (alıcı avatarları için). */
export function useFriendNames(): Record<UserId, string> {
  const friends = useFriends();
  return useMemo(() => Object.fromEntries(friends.map((f) => [f.uid, f.displayName])), [friends]);
}
