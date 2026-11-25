import type { FriendshipId, RequestId, ShareId, UserId } from './model';

/** Arkadaşlık kimliği yönsüzdür: iki uid sıralanır. Eşzamanlı karşılıklı istekler aynı belgeye düşer. */
export function friendshipId(a: UserId, b: UserId): FriendshipId {
  if (a === b) throw new Error('Kişi kendisiyle arkadaş olamaz');
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

export function sortedPair(a: UserId, b: UserId): [UserId, UserId] {
  return a < b ? [a, b] : [b, a];
}

/** Paylaşım kimliği yönlüdür: gönderen_alıcı. Çift başına tek kayıt. */
export function shareId(senderId: UserId, receiverId: UserId): ShareId {
  if (senderId === receiverId) throw new Error('Kişi konumunu kendisiyle paylaşamaz');
  return `${senderId}_${receiverId}`;
}

export function requestId(requesterId: UserId, targetId: UserId): RequestId {
  if (requesterId === targetId) throw new Error('Kişi kendisinden konum isteyemez');
  return `${requesterId}_${targetId}`;
}

export function blockId(blockerId: UserId, blockedId: UserId): string {
  return `${blockerId}_${blockedId}`;
}

/** Faz 8: izin belgesi kimliği YÖNLÜDÜR: granter_grantee (`permission_grants`). A_B ile B_A ayrı belgelerdir. */
export function grantId(granterId: UserId, granteeId: UserId): string {
  if (granterId === granteeId) throw new Error('Kişi kendisine izin veremez');
  return `${granterId}_${granteeId}`;
}

/** RFC 4122 v4; `crypto.randomUUID` yoksa (eski Hermes) `getRandomValues` ile. */
export function uuidV4(rand: (n: number) => Uint8Array = defaultRandomBytes): string {
  const b = rand(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function defaultRandomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) throw new Error('Güvenli rastgele sayı üreteci yok (react-native-get-random-values yükleyin)');
  return c.getRandomValues(new Uint8Array(n));
}
