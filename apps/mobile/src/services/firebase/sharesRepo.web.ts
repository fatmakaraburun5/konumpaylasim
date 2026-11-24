/** Web demo: `location_shares` okuyucuları → bellek içi demo sunucusu (yerel zod şemasından geçer). */
import type { UserId } from '@konum/core';
import { demoServer } from '../../demo/server';
import { ShareDocSchema, type ShareDoc } from '../../lib/schemas';

function parseAll(list: readonly unknown[]): ShareDoc[] {
  const out: ShareDoc[] = [];
  for (const d of list) {
    const parsed = ShareDocSchema.safeParse(d);
    if (parsed.success) out.push(parsed.data);
    else if (__DEV__) console.warn('[konum demo] bozuk location_shares belgesi atlandı', parsed.error);
  }
  return out;
}

export { toOutgoingView } from './shareView';

export function listenOutgoingShares(uid: UserId, onShares: (shares: ShareDoc[]) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().sharesWhere('sender_id', uid),
    (list) => onShares(parseAll(list)),
  );
}

export function listenIncomingShares(uid: UserId, onShares: (shares: ShareDoc[]) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().sharesWhere('receiver_id', uid),
    (list) => onShares(parseAll(list)),
  );
}

export async function fetchOutgoingShares(uid: UserId): Promise<ShareDoc[]> {
  await new Promise((r) => setTimeout(r, 60));
  return parseAll(JSON.parse(JSON.stringify(demoServer().sharesWhere('sender_id', uid))) as unknown[]);
}
