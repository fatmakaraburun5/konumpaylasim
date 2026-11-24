/**
 * Faz 5: Firestore `meetups` okuyucusu (istemci YAZMAZ; `meetup_*` callable'ları).
 * İki kısıtlı sorgu (kural: `from == ben || ben in to`): gönderdiklerim `from == ben`, bana gelenler
 * `to array-contains ben`. Süresi geçen / iptal edilen öneri okuma tarafında gizlenir (meetupStore).
 */
import { PATHS, type Meetup, type UserId } from '@konum/core';
import { collection, getFirestore, onSnapshot, query, where, type QuerySnapshot } from '@react-native-firebase/firestore';
import { meetupFromDoc } from './f5Docs';

export interface MeetupHandlers {
  onSent: (list: Meetup[]) => void;
  onReceived: (list: Meetup[]) => void;
  onError?: (e: Error) => void;
}

function parse(snap: QuerySnapshot): Meetup[] {
  const out: Meetup[] = [];
  for (const d of snap.docs) {
    const m = meetupFromDoc(d.id, d.data());
    if (m) out.push(m);
    else if (__DEV__) console.warn('[konum] bozuk meetups belgesi atlandı', d.id);
  }
  return out;
}

export function listenMeetups(uid: UserId, h: MeetupHandlers): () => void {
  const db = getFirestore();
  const unSent = onSnapshot(
    query(collection(db, PATHS.meetups), where('from', '==', uid)),
    (snap) => h.onSent(parse(snap)),
    (e) => h.onError?.(e),
  );
  const unReceived = onSnapshot(
    query(collection(db, PATHS.meetups), where('to', 'array-contains', uid)),
    (snap) => h.onReceived(parse(snap)),
    (e) => h.onError?.(e),
  );
  return () => {
    unSent();
    unReceived();
  };
}
