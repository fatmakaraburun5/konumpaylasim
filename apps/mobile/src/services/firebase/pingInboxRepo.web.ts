/**
 * Web demo: ping kutusu → bellek içi demo sunucusu (native `pingInboxRepo.ts` ile aynı API ve `parsePing`).
 * Simüle bağlantı yokken güncelleme gelmez; bağlantı gelince son durum tek seferde iletilir.
 */
import { parsePing, type Ping, type UserId } from '@konum/core';
import { demoServer } from '../../demo/server';
import { demoOnline, onDemoNetworkChange } from '../../demo/web/network';
import { demoCurrentUid } from '../../demo/web/session';

export interface PingInboxHandlers {
  onUpsert: (p: Ping) => void;
  onRemove: (pingId: string) => void;
  onError?: (e: Error) => void;
}

export function listenPingInbox(uid: UserId, h: PingInboxHandlers): () => void {
  let prev: Record<string, string> = {};
  let pending: Record<string, Record<string, unknown>> | null = null;
  const apply = (inbox: Record<string, Record<string, unknown>>) => {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(inbox)) {
      const raw = JSON.stringify(value);
      next[key] = raw;
      if (prev[key] === raw) continue;
      const p = parsePing(value, key);
      if (p && p.ping_id === key) h.onUpsert(p);
    }
    for (const key of Object.keys(prev)) if (!(key in next)) h.onRemove(key);
    prev = next;
  };
  const unsub = demoServer().subscribe(
    () => (demoCurrentUid() === uid ? demoServer().pingInboxOf(uid) : {}),
    (inbox) => {
      if (demoOnline()) apply(inbox);
      else pending = inbox;
    },
  );
  const unNet = onDemoNetworkChange((online) => {
    if (!online || !pending) return;
    const p = pending;
    pending = null;
    apply(p);
  });
  return () => {
    unsub();
    unNet();
  };
}

export async function deletePing(uid: UserId, pingId: string): Promise<void> {
  demoServer().deletePing(uid, pingId, demoCurrentUid());
}
