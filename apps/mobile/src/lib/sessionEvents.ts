/**
 * Faz 10: oturum olayları (döngüsel içe aktarmayı önleyen küçük olay yolu). Callable `session_revoked` /
 * `device_registration_required` döndürünce, sessiz `session_revoked` push'unda ya da kendi cihaz kaydım "revoked"
 * görününce yayınlanır; `services/security/deviceSession.ts` dinler.
 */
export type SessionEvent = { kind: 'revoked'; source: 'callable' | 'push' | 'listener' | 'database' } | { kind: 'registration_required' };

type Listener = (e: SessionEvent) => void;
const listeners = new Set<Listener>();

export function onSessionEvent(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function emitSessionEvent(e: SessionEvent): void {
  for (const l of [...listeners]) {
    try {
      l(e);
    } catch {
      // dinleyici hatası yayını durdurmaz
    }
  }
}
