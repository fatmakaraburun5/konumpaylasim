/**
 * Demo sunucusu testleri için Faz 8 yardımcıları: demo hesabım onaysız ve kimseye izinsiz başlar (varsayılan kapalı);
 * testler gerçek callable'larla önce sözleşmeyi onaylar ve gereken yönlü izinleri verir.
 */
import { CONSENT_TEXT_SHA256, CONSENT_VERSION, uuidV4, type RequestableScope, type UserId } from '@konum/core';
import type { DemoServer } from '../src/demo/server/server';
import { DEMO_ME } from '../src/demo/server/world';

export const consentPayload = (overrides: Record<string, unknown> = {}) => ({
  op_id: uuidV4(),
  version: CONSENT_VERSION,
  text_sha256: CONSENT_TEXT_SHA256,
  scrolled_to_bottom: true,
  platform: 'web',
  app_version: '0.1.0',
  ...overrides,
});

export async function acceptConsent(s: DemoServer, uid: UserId = DEMO_ME): Promise<void> {
  await s.call('consent_accept', consentPayload(), uid);
}

/** `granter` → `grantee` kapsamları (`permission_set`, granter adına). */
export async function grant(s: DemoServer, granter: UserId, grantee: UserId, ...scopes: RequestableScope[]): Promise<void> {
  for (const scope of scopes) await s.call('permission_set', { op_id: uuidV4(), grantee_id: grantee, scope, granted: true }, granter);
}

/** Faz 7: pil paylaşımı varsayılan KAPALI; pil alanı yazan / düşük pil bildiren testler önce açar. */
export async function shareBattery(s: DemoServer, uid: UserId = DEMO_ME, on = true): Promise<void> {
  await s.call('privacy_settings_set', { op_id: uuidV4(), battery_share: on }, uid);
}
