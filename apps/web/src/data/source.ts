/**
 * Görüntüleyicinin veri kaynağı. Gerçekte Firebase RTDB (`link_live/{hash}`), testte ve önizlemede
 * bellekteki sahte kaynak. Arayüz yalnızca ÖZET alır: token hiçbir kaynağa verilmez.
 */
export type Unsubscribe = () => void;

export interface LinkLiveHandlers {
  /** Düğümün tam değeri; düğüm yoksa null. */
  value(raw: unknown): void;
  /** Kural okumayı reddetti (`permission_denied`): bağlantı yok, bitti ya da süresi doldu. Kalıcıdır. */
  denied(): void;
  /** Başka bir dinleyici hatası. Kalıcıdır. */
  failed(): void;
}

export interface LinkLiveSource {
  subscribe(tokenHash: string, handlers: LinkLiveHandlers): Unsubscribe;
  /** Sunucu bağlantısı (RTDB `.info/connected`). İlk değer genellikle `false` gelir. */
  onConnection(cb: (connected: boolean) => void): Unsubscribe;
  /** Sunucu saati − cihaz saati, ms (RTDB `.info/serverTimeOffset`). */
  onServerTimeOffset(cb: (offsetMs: number) => void): Unsubscribe;
}

/** RTDB iptal hatası `permission_denied` mi (SDK: `error.code = 'PERMISSION_DENIED'`). */
export function isPermissionDenied(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.toUpperCase() === 'PERMISSION_DENIED') return true;
  const msg = (err as { message?: unknown }).message;
  return typeof msg === 'string' && msg.startsWith('permission_denied');
}
