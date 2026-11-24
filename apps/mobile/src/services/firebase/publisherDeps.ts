/** Yayıncının gerçek Firebase bağımlılıkları (RTDB yazma + Firestore tazeleme + kesme anahtarı). */
import { isExpired, type EpochMs, type PublishTarget, type UserId } from '@konum/core';
import { isLinkBlocked } from '../../state/linkStops';
import { isShareBlocked } from '../../state/stopIntents';
import type { LinkPublisherDeps } from './linkPublisher';
import { fetchOutgoingLinks } from './linksRepo';
import { writeFanout } from './liveRepo';
import type { PublisherDeps } from './publisher';
import { fetchOutgoingShares } from './sharesRepo';

/** [Varsayım] Çevrimdışıyken getDocsFromServer'ın konum hattını bekletmemesi için üst sınır. */
const REFRESH_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function firebasePublisherDeps(uid: UserId, now: () => EpochMs): PublisherDeps {
  return {
    write: (map) => writeFanout(map),
    refreshTargets: async () => {
      const docs = await withTimeout(fetchOutgoingShares(uid), REFRESH_TIMEOUT_MS);
      const t = now();
      return docs
        .filter((d) => d.status === 'active' && !isExpired(d, t))
        .map<PublishTarget>((d) => ({ share_id: d.share_id, receiver_id: d.receiver_id, share_mode: d.share_mode, expires_at: d.expires_at }));
    },
    isAllowed: (shareId) => !isShareBlocked(shareId),
  };
}

/** Bağlantı yayıncısının bağımlılıkları: `link_live/{hash}` yazma + `link_shares` tazeleme + kesme anahtarı. */
export function firebaseLinkPublisherDeps(uid: UserId, now: () => EpochMs): LinkPublisherDeps {
  return {
    write: (map) => writeFanout(map),
    refreshTargets: async () => {
      const docs = await withTimeout(fetchOutgoingLinks(uid), REFRESH_TIMEOUT_MS);
      const t = now();
      return docs
        .filter((d) => d.status === 'active' && !isExpired(d, t))
        .map((d) => ({ link_id: d.link_id, token_hash: d.token_hash, share_mode: d.share_mode, expires_at: d.expires_at }));
    },
    isAllowed: (linkId) => !isLinkBlocked(linkId),
  };
}
