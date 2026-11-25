/**
 * İnceleme testleri için ortak yardımcılar (yalnızca test/review/ altında kullanılır).
 * Bu testler ilk incelemede bulunan açıkları gösteriyordu; düzeltmelerden sonra regresyon testi olarak geçmeleri gerekir.
 */
import {
  HOUR,
  type OutgoingShareView,
  PATHS,
  REQUESTABLE_SCOPES,
  type ShareStartResponse,
  emptyGrantDoc,
  friendshipId,
  withGranted,
} from '@konum/core';
import { expect } from 'vitest';
import { db } from '../../functions/src/admin';
import { CallError, type TestUser, call, clientDb, deliveredFor, livePathOf, opId } from '../helpers/emulator';

export const TZ = 'Europe/Istanbul';

export interface BefriendOptions {
  /**
   * Faz 8: arkadaşlık izin değildir. Faz 1–6 testleri anlamını korusun diye varsayılan olarak iki yönde tüm
   * istenebilir kapsamlar (`location_view`, `ping`, `zone_notify`, `meetup_invite`) yazılır. Faz 8 testleri 'none'.
   */
  grants?: 'all' | 'none';
}

export async function befriend(a: TestUser, b: TestUser, opts: BefriendOptions = {}): Promise<void> {
  await call('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: b.invite_code }, a);
  const r = await call('friend_request_respond', { op_id: opId(), friendship_id: friendshipId(a.uid, b.uid), accept: true }, b);
  expect(r.status).toBe('accepted');
  if ((opts.grants ?? 'all') === 'all') await grantAll(a, b);
}

/**
 * Faz 8 test tohumu: iki yönde tüm istenebilir kapsamlar (`via:'manual'`, core `withGranted`). Admin SDK ile yazılır
 * (callable `permission_set` faz8.test.ts'te ayrıca sınanır); belge şekli sunucunun yazdığıyla aynıdır.
 */
export async function grantAll(a: Pick<TestUser, 'uid'>, b: Pick<TestUser, 'uid'>): Promise<void> {
  const now = Date.now();
  const batch = db().batch();
  for (const [g, e] of [
    [a.uid, b.uid],
    [b.uid, a.uid],
  ] as const) {
    batch.set(db().doc(PATHS.permissionGrant(g, e)), withGranted(emptyGrantDoc(g, e, now), REQUESTABLE_SCOPES, 'manual', now));
  }
  await batch.commit();
}

export async function start(sender: TestUser, receivers: TestUser[], duration: unknown = { kind: 'preset', preset: 'h1' }) {
  return call<ShareStartResponse>(
    'share_start',
    { op_id: opId(), receiver_ids: receivers.map((r) => r.uid), duration, time_zone: TZ },
    sender,
  );
}

/** Gönderen kimliğiyle core paketini yazar (shares.test.ts ile aynı yöntem). */
export async function writeLive(sender: TestUser, s: OutgoingShareView, patch: Record<string, unknown> = {}) {
  const t = { sender_id: sender.uid, receiver_id: s.receiver_id, share_mode: s.share_mode, expires_at: s.expires_at };
  const base = deliveredFor({ ...t, expires_at: s.expires_at === null ? null : Math.max(s.expires_at, Date.now() + HOUR) });
  const v = s.expires_at === null ? base : { ...base, expires_at: s.expires_at };
  return (await clientDb(sender.uid)).ref(livePathOf(t)).set({ ...v, ...patch });
}

/** Callable sonucunu karşılaştırılabilir bir "dış görünüşe" indirger (başarı ya da hata durumu). */
export async function outcome(name: Parameters<typeof call>[0], data: unknown, user: TestUser): Promise<string> {
  try {
    const r = (await call(name, data, user)) as Record<string, unknown>;
    return `ok:${String(r.status)}`;
  } catch (err) {
    if (err instanceof CallError) return `error:${err.status}`;
    throw err;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
