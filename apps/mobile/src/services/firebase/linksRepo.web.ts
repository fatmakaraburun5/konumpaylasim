/**
 * Web demo: Firestore `link_shares` okuyucuları → bellek içi demo sunucusu (native `linksRepo.ts` ile aynı API).
 * Belgeler aynı `LinkDocSchema`'dan geçer; belgede düz token yoktur, yalnızca `token_hash`.
 */
import type { LinkShareView, UserId } from '@konum/core';
import { demoServer } from '../../demo/server';
import { LinkDocSchema, type LinkDoc } from './linkDoc';

export { recentLinks, toLinkView, type LinkDoc } from './linkDoc';

function parseAll(list: readonly unknown[]): LinkDoc[] {
  const out: LinkDoc[] = [];
  for (const d of list) {
    const parsed = LinkDocSchema.safeParse(d);
    if (parsed.success) out.push(parsed.data);
    else if (__DEV__) console.warn('[konum demo] bozuk link_shares belgesi atlandı', parsed.error);
  }
  return out;
}

/** Benim bağlantılarım (`sender_id == uid`) → linkStore `applyServerLinks`. */
export function listenOutgoingLinks(uid: UserId, onLinks: (links: LinkDoc[]) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().linksWhere(uid),
    (list) => onLinks(parseAll(list)),
  );
}

/** Önbelleği atlayarak "sunucudan" tazeler (bağlantı yayıncısı PERMISSION_DENIED aldığında). */
export async function fetchOutgoingLinks(uid: UserId): Promise<LinkShareView[]> {
  await new Promise((r) => setTimeout(r, 60));
  return parseAll(JSON.parse(JSON.stringify(demoServer().linksWhere(uid))) as unknown[]);
}
