/** Token sahibinin canlı konum dinleyicisi (salt okunur `link_live/{hash}`); konum yalnızca bellekte. */
import { useEffect, useState } from 'react';
import { listenLinkLive as defaultListen } from '../../services/firebase/linkLiveRepo';
import { INITIAL_LINK_LIVE, type LinkLiveState } from './linkViewerModel';

export function useLinkLive(hash: string | null, listen: typeof defaultListen = defaultListen): LinkLiveState {
  const [state, setState] = useState<LinkLiveState>(INITIAL_LINK_LIVE);
  useEffect(() => {
    setState(INITIAL_LINK_LIVE);
    if (!hash) return;
    return listen(hash, {
      onLive: (live) => setState((p) => ({ live, loaded: true, denied: false, seenLive: p.seenLive || live !== null, hadAccess: true })),
      onDenied: () => setState((p) => ({ ...p, live: null, loaded: true, denied: true })),
      onError: () => setState((p) => ({ ...p, loaded: true })),
    });
  }, [hash, listen]);
  return state;
}
