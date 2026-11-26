/** Web demo: `events` / `notices` okuyucusu → bellek içi demo sunucusu (native `eventsRepo.ts` ile aynı API). */
import { parseEventDoc, parseEventNotice, type EventDoc, type EventNotice, type UserId } from '@konum/core';
import { demoServer } from '../../demo/server';

export const EVENTS_LIST_LIMIT = 50;

export function listenEvents(uid: UserId, onList: (list: EventDoc[]) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().eventsOf(uid),
    (list) => onList(list.map((d) => parseEventDoc(d)).filter((e): e is EventDoc => e !== null)),
  );
}

export function listenNotices(uid: UserId, onList: (list: EventNotice[]) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().noticesOf(uid),
    (list) => onList(list.map((d) => parseEventNotice(d)).filter((n): n is EventNotice => n !== null)),
  );
}
