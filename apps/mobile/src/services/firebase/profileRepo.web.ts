/**
 * Web demo: profil, arkadaşlıklar ve giden istekler → bellek içi demo sunucusu. Sonuçlar native
 * sürümdeki gibi yerel zod şemalarından geçer. FCM token kaydı web'de yoktur (no-op).
 */
import type { Friendship, UserId, UserProfile } from '@konum/core';
import { demoServer } from '../../demo/server';
import { FriendshipSchema, OutgoingRequestSchema, UserProfileSchema } from '../../lib/schemas';

export function listenProfile(uid: UserId, cb: (p: UserProfile | null) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().profileOf(uid),
    (p) => {
      if (!p) return cb(null);
      const parsed = UserProfileSchema.safeParse(p);
      cb(parsed.success ? parsed.data : null);
    },
  );
}

export function listenFriendships(uid: UserId, cb: (list: Friendship[]) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().friendshipsOf(uid),
    (list) => {
      const out: Friendship[] = [];
      for (const f of list) {
        const parsed = FriendshipSchema.safeParse(f);
        if (parsed.success) out.push(parsed.data);
      }
      cb(out);
    },
  );
}

/** Faz 4: `users/{ben}.emergency_contacts` (native `listenEmergencyContacts` ile aynı). */
export function listenEmergencyContacts(uid: UserId, cb: (ids: UserId[]) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().emergencyContactsOf(uid),
    (ids) => cb(ids.filter((v): v is UserId => typeof v === 'string')),
  );
}

export interface OutgoingRequest {
  id: string;
  via: 'invite_code' | 'phone';
  label: string;
  created_at: number;
  expires_at: number;
}

export function listenOutgoingRequests(uid: UserId, cb: (list: OutgoingRequest[]) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().outgoingRequestsOf(uid),
    (list) => {
      const out: OutgoingRequest[] = [];
      for (const d of list) {
        const parsed = OutgoingRequestSchema.safeParse(d);
        if (parsed.success) out.push(parsed.data);
      }
      cb(out.sort((a, b) => b.created_at - a.created_at));
    },
  );
}

export function saveDeviceToken(_uid: UserId, _token: string): Promise<void> {
  return Promise.resolve();
}

export function deleteDeviceToken(_uid: UserId, _token: string): Promise<void> {
  return Promise.resolve();
}
