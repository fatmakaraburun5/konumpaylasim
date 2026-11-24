/**
 * Firestore `link_shares` okuyucuları (istemci YAZMAZ; geçişler `link_share_*` callable'ları ile).
 * Kural filtre değildir: sorgu `sender_id == uid` kısıtını taşımak ZORUNDA.
 *
 * Belgede `token_hash` vardır, düz token YOKTUR. Yayıncı `link_live/{token_hash}` yoluna yazar.
 */
import { PATHS, type LinkShareView, type UserId } from '@konum/core';
import {
  collection,
  getDocsFromServer,
  getFirestore,
  onSnapshot,
  query,
  where,
  type QuerySnapshot,
} from '@react-native-firebase/firestore';
import { LinkDocSchema, type LinkDoc } from './linkDoc';

export { recentLinks, toLinkView, type LinkDoc } from './linkDoc';

function parseSnapshot(snap: QuerySnapshot): LinkDoc[] {
  const out: LinkDoc[] = [];
  for (const d of snap.docs) {
    const parsed = LinkDocSchema.safeParse({ link_id: d.id, ...d.data() });
    if (parsed.success) out.push(parsed.data);
    else if (__DEV__) console.warn('[konum] bozuk link_shares belgesi atlandı', d.id);
  }
  return out;
}

/** Benim bağlantılarım → linkStore `applyServerLinks`. */
export function listenOutgoingLinks(uid: UserId, onLinks: (links: LinkDoc[]) => void, onError?: (e: Error) => void): () => void {
  const q = query(collection(getFirestore(), PATHS.linkShares), where('sender_id', '==', uid));
  return onSnapshot(q, (snap) => onLinks(parseSnapshot(snap)), (e) => onError?.(e));
}

/** Önbelleği atlayarak sunucudan tazeler (bağlantı yayıncısı PERMISSION_DENIED aldığında). */
export async function fetchOutgoingLinks(uid: UserId): Promise<LinkShareView[]> {
  const q = query(collection(getFirestore(), PATHS.linkShares), where('sender_id', '==', uid));
  return parseSnapshot(await getDocsFromServer(q));
}
