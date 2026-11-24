/**
 * Faz 4: RTDB ping kutusu `ping_inbox/{ben}/{ping_id}` (yalnızca sunucu yazar; kural: alıcı okur ve yalnızca SİLER).
 * Kayıt = core `Ping` (RTDB null saklamaz: eksik `location`/`eta_s` core `parsePing` ile null olur).
 * Konum ve ping yalnızca bellekte tutulur.
 */
import { parsePing, PATHS, type Ping, type UserId } from '@konum/core';
import { getDatabase, onChildAdded, onChildChanged, onChildRemoved, ref, remove, type DataSnapshot } from '@react-native-firebase/database';

export interface PingInboxHandlers {
  onUpsert: (p: Ping) => void;
  onRemove: (pingId: string) => void;
  onError?: (e: Error) => void;
}

export function listenPingInbox(uid: UserId, h: PingInboxHandlers): () => void {
  const inbox = ref(getDatabase(), PATHS.pingInbox(uid));
  const handle = (snap: DataSnapshot) => {
    if (!snap.key) return;
    const p = parsePing(snap.val(), snap.key);
    // Anahtar ile içerik tutarsızsa yok say.
    if (!p || p.ping_id !== snap.key) return;
    h.onUpsert(p);
  };
  const cancel = (e: Error) => h.onError?.(e);
  const subs = [
    onChildAdded(inbox, handle, cancel),
    onChildChanged(inbox, handle, cancel),
    onChildRemoved(
      inbox,
      (snap) => {
        if (snap.key) h.onRemove(snap.key);
      },
      cancel,
    ),
  ];
  return () => subs.forEach((u) => u());
}

/** Alıcı pingi kutusundan siler (kural: `auth.uid === $uid && !newData.exists()`). */
export function deletePing(uid: UserId, pingId: string): Promise<void> {
  return remove(ref(getDatabase(), `${PATHS.pingInbox(uid)}/${pingId}`));
}
