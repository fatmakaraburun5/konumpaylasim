/**
 * Firestore `location_shares` okuyucuları (istemci YAZMAZ; tüm geçişler callable ile).
 *
 * Kurallar filtre değildir: her sorgu `sender_id == uid` ya da `receiver_id == uid` kısıtını
 * TAŞIMAK ZORUNDA, aksi halde kural sorguyu toptan reddeder (BACKEND_SPEC §5).
 */
import { PATHS, type UserId } from '@konum/core';
import {
  collection,
  getDocsFromServer,
  getFirestore,
  onSnapshot,
  query,
  where,
  type QuerySnapshot,
} from '@react-native-firebase/firestore';
import { ShareDocSchema, type ShareDoc } from '../../lib/schemas';

function parseSnapshot(snap: QuerySnapshot): ShareDoc[] {
  const out: ShareDoc[] = [];
  for (const d of snap.docs) {
    const parsed = ShareDocSchema.safeParse({ share_id: d.id, ...d.data() });
    if (parsed.success) out.push(parsed.data);
    else if (__DEV__) console.warn('[konum] bozuk location_shares belgesi atlandı', d.id);
  }
  return out;
}

export { toOutgoingView } from './shareView';

/** Benim gönderdiğim paylaşımlar → sharingStore `SERVER_SNAPSHOT`. */
export function listenOutgoingShares(uid: UserId, onShares: (shares: ShareDoc[]) => void, onError?: (e: Error) => void): () => void {
  const q = query(collection(getFirestore(), PATHS.shares), where('sender_id', '==', uid));
  return onSnapshot(q, (snap) => onShares(parseSnapshot(snap)), (e) => onError?.(e));
}

/** Bana gelen paylaşımlar → incomingStore (kim, ne zamana kadar). */
export function listenIncomingShares(uid: UserId, onShares: (shares: ShareDoc[]) => void, onError?: (e: Error) => void): () => void {
  const q = query(collection(getFirestore(), PATHS.shares), where('receiver_id', '==', uid));
  return onSnapshot(q, (snap) => onShares(parseSnapshot(snap)), (e) => onError?.(e));
}

/** Önbelleği atlayarak sunucudan tazeler (yayıncı PERMISSION_DENIED aldığında). */
export async function fetchOutgoingShares(uid: UserId): Promise<ShareDoc[]> {
  const q = query(collection(getFirestore(), PATHS.shares), where('sender_id', '==', uid));
  return parseSnapshot(await getDocsFromServer(q));
}
