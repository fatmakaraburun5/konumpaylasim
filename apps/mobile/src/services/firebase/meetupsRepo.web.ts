/** Web demo: `meetups` okuyucusu → bellek içi demo sunucusu (native `meetupsRepo.ts` ile aynı API). */
import type { Meetup, UserId } from '@konum/core';
import { demoServer } from '../../demo/server';
import { meetupFromDoc } from './f5Docs';

export interface MeetupHandlers {
  onSent: (list: Meetup[]) => void;
  onReceived: (list: Meetup[]) => void;
  onError?: (e: Error) => void;
}

const parseAll = (list: readonly unknown[]): Meetup[] => {
  const out: Meetup[] = [];
  for (const d of list) {
    const m = meetupFromDoc(String((d as { meetup_id?: unknown }).meetup_id ?? ''), d);
    if (m) out.push(m);
  }
  return out;
};

export function listenMeetups(uid: UserId, h: MeetupHandlers): () => void {
  const unSent = demoServer().subscribe(
    () => demoServer().meetupsWhere('from', uid),
    (list) => h.onSent(parseAll(list)),
  );
  const unReceived = demoServer().subscribe(
    () => demoServer().meetupsWhere('to', uid),
    (list) => h.onReceived(parseAll(list)),
  );
  return () => {
    unSent();
    unReceived();
  };
}
