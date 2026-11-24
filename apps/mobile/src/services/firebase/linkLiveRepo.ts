/**
 * Token sahibinin (QR'ı okutan kişinin) salt okunur dinleyicisi: RTDB `link_live/{token_hash}`.
 *
 *  - Token cihazda özetlenir (core `linkTokenHash`, saf TS; Hermes'te crypto.subtle yok); ağa yalnızca özet çıkar.
 *  - Okuma kuralı `link_acl/{hash}` aktif ve süresi dolmamışsa izin verir. Ret (`permission_denied`) =
 *    bağlantı bitti ya da hiç yok: ikisi AYIRT EDİLMEZ (core `linkViewState`).
 *  - Durdurmada sunucu düğümü siler → `onValue(null)` → ekran anında "Paylaşım sona erdi" der.
 *  - Konum yalnızca bellekte tutulur; diske yazılmaz.
 */
import { linkLivePath, parseLinkLive, type LinkLiveLocation } from '@konum/core';
import { getDatabase, onValue, ref } from '@react-native-firebase/database';
import { isPermissionDenied } from '../../lib/errors';
import { ensureFirebase } from './init';

export interface LinkLiveHandlers {
  /** Her anlık görüntü: düğüm yoksa ya da bozuksa null. */
  onLive: (live: LinkLiveLocation | null) => void;
  /** Dinleyici reddedildi (ACL bitti / yok). */
  onDenied: () => void;
  /** Diğer hatalar (ağ vb.). */
  onError?: (e: Error) => void;
}

export function listenLinkLive(tokenHash: string, h: LinkLiveHandlers): () => void {
  let unsub: (() => void) | null = null;
  let cancelled = false;
  void ensureFirebase()
    .then(() => {
      if (cancelled) return;
      unsub = onValue(
        ref(getDatabase(), linkLivePath(tokenHash)),
        (snap) => h.onLive(parseLinkLive(snap.val())),
        (e) => (isPermissionDenied(e) ? h.onDenied() : h.onError?.(e)),
      );
    })
    .catch((e: unknown) => h.onError?.(e instanceof Error ? e : new Error(String(e))));
  return () => {
    cancelled = true;
    unsub?.();
  };
}
