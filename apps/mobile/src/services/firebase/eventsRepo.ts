/**
 * Faz 7: Firestore `events` ve `users/{ben}/notices` okuyucusu (istemci YAZMAZ; `event_*` callable'ları).
 *  - Etkinlikler: kural `ben in member_ids` → sorgu `member_ids array-contains ben`, `updated_at` azalan, en çok 50
 *    (bileşik dizin `firestore.indexes.json`). Bitenler de gelir (liste "Geçmiş" bölümünde gösterir).
 *  - Bildirim kutusu: `created_at` azalan, en çok `NOTICE_LIST_LIMIT` (30 gün TTL).
 * Bozuk belge atlanır.
 */
import { NOTICE_LIST_LIMIT, PATHS, parseEventDoc, parseEventNotice, type EventDoc, type EventNotice, type UserId } from '@konum/core';
import { collection, getFirestore, limit, onSnapshot, orderBy, query, where } from '@react-native-firebase/firestore';

/** Listede tutulan en çok etkinlik. */
export const EVENTS_LIST_LIMIT = 50;

export function listenEvents(uid: UserId, onList: (list: EventDoc[]) => void, onError?: (e: Error) => void): () => void {
  const db = getFirestore();
  return onSnapshot(
    query(collection(db, PATHS.events), where('member_ids', 'array-contains', uid), orderBy('updated_at', 'desc'), limit(EVENTS_LIST_LIMIT)),
    (snap) => {
      const out: EventDoc[] = [];
      for (const d of snap.docs) {
        const e = parseEventDoc({ ...d.data(), event_id: d.id });
        if (e) out.push(e);
        else if (__DEV__) console.warn('[konum] bozuk etkinlik belgesi atlandı', d.id);
      }
      onList(out);
    },
    (e) => onError?.(e),
  );
}

export function listenNotices(uid: UserId, onList: (list: EventNotice[]) => void, onError?: (e: Error) => void): () => void {
  const db = getFirestore();
  return onSnapshot(
    query(collection(db, PATHS.notices(uid)), orderBy('created_at', 'desc'), limit(NOTICE_LIST_LIMIT)),
    (snap) => {
      const out: EventNotice[] = [];
      for (const d of snap.docs) {
        const n = parseEventNotice({ ...d.data(), notice_id: d.id });
        if (n) out.push(n);
      }
      onList(out);
    },
    (e) => onError?.(e),
  );
}
