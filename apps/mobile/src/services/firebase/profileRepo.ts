/**
 * Firestore okuyucuları: kendi profilim (`users/{uid}`, yalnızca sahibi okur) ve arkadaşlıklarım
 * (`friendships`, iki kısıtlı sorgu) ve giden isteklerim (`users/{uid}/outgoing_requests`). FCM token kaydı (`devices/{uid}/tokens`, sahibi yazar).
 */
import { currentDsid } from './authClient';
import { PATHS, SOS_LIMITS, type Friendship, type UserId, type UserProfile } from '@konum/core';
import {
  collection,
  deleteDoc,
  doc,
  getFirestore,
  onSnapshot,
  query,
  setDoc,
  where,
} from '@react-native-firebase/firestore';
import { Platform } from 'react-native';
import { now } from '../../lib/clock';
import { FriendshipSchema, OutgoingRequestSchema, UserProfileSchema } from '../../lib/schemas';

export function listenProfile(uid: UserId, cb: (p: UserProfile | null) => void, onError?: (e: Error) => void): () => void {
  return onSnapshot(
    doc(getFirestore(), PATHS.user(uid)),
    (snap) => {
      if (!snap.exists()) return cb(null);
      const parsed = UserProfileSchema.safeParse({ user_id: uid, ...snap.data() });
      cb(parsed.success ? parsed.data : null);
    },
    (e) => onError?.(e),
  );
}

/**
 * Arkadaşlık grafiği iki sorguyla okunur (backend kuralları filtre değildir, sorgu kısıtı taşımalıdır):
 *  - kabul edilmiş: `member_ids array-contains ben` + `status == 'accepted'`
 *  - bana gelen bekleyen: `target_id == ben` + `status == 'pending'`
 * Kendi gönderdiğim bekleyen istekler buradan GÖRÜNMEZ (numara kayıtlı mı / engellendim mi sızmasın);
 * onlar `users/{ben}/outgoing_requests` altındadır, bkz. `listenOutgoingRequests`.
 * İki sorgunun ikisi de en az bir kez yanıt verince `cb` çağrılır.
 */
export function listenFriendships(uid: UserId, cb: (list: Friendship[]) => void, onError?: (e: Error) => void): () => void {
  const db = getFirestore();
  const parts: { accepted: Friendship[] | null; incoming: Friendship[] | null } = { accepted: null, incoming: null };
  const parse = (docs: { id: string; data: () => unknown }[]): Friendship[] => {
    const out: Friendship[] = [];
    for (const d of docs) {
      const parsed = FriendshipSchema.safeParse({ id: d.id, ...(d.data() as object) });
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  };
  const emit = () => {
    if (parts.accepted && parts.incoming) cb([...parts.accepted, ...parts.incoming]);
  };
  const unA = onSnapshot(
    query(collection(db, PATHS.friendships), where('member_ids', 'array-contains', uid), where('status', '==', 'accepted')),
    (snap) => {
      parts.accepted = parse(snap.docs);
      emit();
    },
    (e) => onError?.(e),
  );
  const unP = onSnapshot(
    query(collection(db, PATHS.friendships), where('target_id', '==', uid), where('status', '==', 'pending')),
    (snap) => {
      parts.incoming = parse(snap.docs);
      emit();
    },
    (e) => onError?.(e),
  );
  return () => {
    unA();
    unP();
  };
}

/**
 * Faz 4: acil durum kişilerim `users/{ben}.emergency_contacts` (yalnızca `emergency_contacts_set` callable'ı yazar;
 * belgeyi yalnızca sahibi okur). Alan yoksa boş liste.
 */
export function listenEmergencyContacts(uid: UserId, cb: (ids: UserId[]) => void, onError?: (e: Error) => void): () => void {
  return onSnapshot(
    doc(getFirestore(), PATHS.user(uid)),
    (snap) => cb(snap.exists() ? emergencyContactsOf(snap.data()) : []),
    (e) => onError?.(e),
  );
}

/** Belgedeki listeyi savunmalı okur (geçersiz kimlikler atlanır, en çok core `SOS_LIMITS.maxContacts`). */
export function emergencyContactsOf(data: unknown): UserId[] {
  const raw = (data as { emergency_contacts?: unknown } | null | undefined)?.emergency_contacts;
  if (!Array.isArray(raw)) return [];
  const out: UserId[] = [];
  for (const v of raw) if (typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) && !out.includes(v)) out.push(v);
  return out.slice(0, SOS_LIMITS.maxContacts);
}

/** Gönderdiğim arkadaşlık istekleri: yalnızca maskeli etiket taşır, hedefin uid'ini içermez. */
export interface OutgoingRequest {
  id: string;
  via: 'invite_code' | 'phone';
  label: string;
  created_at: number;
  expires_at: number;
}

export function listenOutgoingRequests(
  uid: UserId,
  cb: (list: OutgoingRequest[]) => void,
  onError?: (e: Error) => void,
): () => void {
  return onSnapshot(
    collection(getFirestore(), `${PATHS.user(uid)}/outgoing_requests`),
    (snap) => {
      const out: OutgoingRequest[] = [];
      for (const d of snap.docs) {
        const parsed = OutgoingRequestSchema.safeParse({ id: d.id, ...d.data() });
        if (parsed.success) out.push(parsed.data);
      }
      cb(out.sort((a, b) => b.created_at - a.created_at));
    },
    (e) => onError?.(e),
  );
}

/**
 * [Varsayım: backend kuralıyla doğrulanmalı] Belge kimliği = token (FCM token'ları `/` içermez).
 * Belge şekli core'da tanımlı değil (core_requests).
 */
export async function saveDeviceToken(uid: UserId, token: string): Promise<void> {
  // Faz 10: token cihaz oturumuna bağlanır (`dsid`; kural: belirteçteki iddiayla aynı) → "eski cihazı kapat"
  // yalnızca o cihazın token'larına sessiz `session_revoked` gönderir.
  const dsid = await currentDsid();
  return setDoc(doc(getFirestore(), PATHS.deviceTokens(uid), token), {
    token,
    platform: Platform.OS,
    // core kuralı: zaman damgaları epoch ms (Firestore Timestamp değil).
    updated_at: now(),
    ...(dsid ? { dsid } : {}),
  });
}

/** Çıkışta / token yenilenince eski token belgesini siler (kural: sahibi silebilir). */
export function deleteDeviceToken(uid: UserId, token: string): Promise<void> {
  return deleteDoc(doc(getFirestore(), PATHS.deviceTokens(uid), token));
}
