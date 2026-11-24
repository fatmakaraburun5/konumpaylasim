/**
 * Web demo: token sahibinin salt okunur dinleyicisi `link_live/{token_hash}` → bellek içi demo sunucusu
 * (native `linkLiveRepo.ts` ile aynı API). Sunucu `database.rules.json` okuma kuralını uygular: kimlik
 * gerekmez; `link_acl` aktif ve süresi dolmamış değilse dinleyici `permission_denied` ile iptal edilir,
 * düğüm silinirse `null` gelir. Konum yalnızca bellekte tutulur.
 */
import { parseLinkLive, type LinkLiveLocation } from '@konum/core';
import { demoServer } from '../../demo/server';

export interface LinkLiveHandlers {
  /** Her anlık görüntü: düğüm yoksa ya da bozuksa null. */
  onLive: (live: LinkLiveLocation | null) => void;
  /** Dinleyici reddedildi (ACL bitti / yok). */
  onDenied: () => void;
  /** Diğer hatalar (ağ vb.). Demo her zaman bağlıdır. */
  onError?: (e: Error) => void;
}

export function listenLinkLive(tokenHash: string, h: LinkLiveHandlers): () => void {
  return demoServer().listenLinkLive(
    tokenHash,
    (raw) => h.onLive(parseLinkLive(raw)),
    () => h.onDenied(),
  );
}
