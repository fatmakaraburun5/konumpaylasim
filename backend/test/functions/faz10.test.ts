/**
 * Faz 10: cihaz oturumları (kayıt, `dsid` iddialı token, legacy kapanışı), kurtarma e-postası, yeni cihazda e-posta
 * ikinci aşaması, "Eski Cihazdaki Oturumu ve Konum Yayınını Kapat" (kara liste + paylaşımların bitmesi) ve kurallar.
 * Uçtan uca: Functions emülatörü (gerçek custom token); kod deterministik değil, emülatörde yanıtta `dev_code` döner.
 */
import { PATHS, revokedDeviceKey } from '@konum/core';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { afterAll, describe, expect, it } from 'vitest';
import { db, rtdb } from '../../functions/src/admin';
import { type TestUser, call, callError, cleanupRulesEnv, newUser, opId, rulesEnv, signInWithCustomToken } from '../helpers/emulator';
import { befriend, start } from '../review/helpers';

afterAll(async () => {
  await cleanupRulesEnv();
});

const device = (install: string, model: string) => ({
  op_id: opId(),
  device: { install_id: install, platform: 'ios', model, os_version: '18.1', app_version: 'test' },
});

async function registerActive(u: TestUser, install: string, model: string): Promise<TestUser & { dsid: string }> {
  const r = await call('device_register', device(install, model), u);
  expect(r.status).toBe('active');
  const s = await signInWithCustomToken(r.custom_token);
  expect(s.uid).toBe(u.uid);
  return { ...u, idToken: s.idToken, dsid: r.device.dsid };
}

describe('Faz 10 cihaz oturumları', () => {
  it('ilk kayıt etkin; dsid’siz eski belirteç kapanır, yeni belirteç çalışır', async () => {
    const u = await newUser('Deniz');
    const a = await registerActive(u, 'install-a-000001', 'iPhone 13');
    expect((await db().doc(PATHS.revokedDevice(revokedDeviceKey(u.uid, null))).get()).exists).toBe(true);
    const e = await callError('favorites_set', { op_id: opId(), favorite_ids: [] }, u);
    expect(e.details?.code).toBe('device_registration_required');
    const hb = await call('device_heartbeat', { op_id: opId(), publishing: true, app_version: 'test' }, a);
    expect(hb.device.dsid).toBe(a.dsid);
  });

  it('e-posta doğrulanmışsa yeni telefon ikinci aşama ister; eski cihaz kapatılınca paylaşım biter ve belirteci reddedilir', async () => {
    const u = await newUser('Deniz');
    const friend = await newUser('Ayşe');
    await befriend(u, friend);
    const old = await registerActive(u, 'install-old-00001', 'iPhone 11');
    await start(old, [friend]);

    const st = await call('recovery_channel_start', { op_id: opId(), channel: 'email', email: 'Deniz.Kaya@Gmail.com' }, old);
    expect(st.challenge.to_masked).toContain('@gmail.com');
    const bad = await callError('recovery_channel_verify', { op_id: opId(), challenge_id: st.challenge.challenge_id, code: '000000' === st.challenge.dev_code ? '111111' : '000000' }, old);
    expect(bad.details?.code).toBe('otp_invalid');
    const ok = await call('recovery_channel_verify', { op_id: opId(), challenge_id: st.challenge.challenge_id, code: st.challenge.dev_code }, old);
    expect(ok.recovery.email.verified_at).toBeTruthy();

    // Yeni telefon: SMS girişi (dsid'siz) → kayıt bekler → e-posta kodu → etkin.
    const reg = await call('device_register', device('install-new-00001', 'iPhone 16'), u);
    expect(reg.status).toBe('needs_second_factor');
    expect(reg.custom_token).toBeNull();
    const ver = await call('device_second_factor_verify', { op_id: opId(), dsid: reg.device.dsid, challenge_id: reg.challenge.challenge_id, code: reg.challenge.dev_code }, u);
    expect(ver.migrated).toBe(true);
    const fresh = { ...u, idToken: (await signInWithCustomToken(ver.custom_token)).idToken };

    const man = await call('account_migration_manifest', {}, fresh);
    expect(man.manifest.items.friendships.count).toBeGreaterThanOrEqual(1);
    expect(man.manifest.items.consents.count).toBe(1);

    expect((await callError('device_revoke', { op_id: opId(), dsid: reg.device.dsid, all_others: false, stop_shares: true }, fresh)).details?.code).toBe('device_is_current');
    const rv = await call('device_revoke', { op_id: opId(), dsid: old.dsid, all_others: false, stop_shares: true }, fresh);
    expect(rv.revoked).toEqual([old.dsid]);
    expect(rv.stopped_shares).toBe(1);
    expect((await rtdb().ref(PATHS.revokedDeviceMirror(u.uid, old.dsid)).get()).val()).toBe(true);
    expect((await callError('device_heartbeat', { op_id: opId(), publishing: true, app_version: 'test' }, old)).details?.code).toBe('session_revoked');

    // Kurallar: eski cihazın belirteci Firestore + RTDB'de reddedilir, yeni cihazınki geçer.
    const env = await rulesEnv();
    const oldFs = env.authenticatedContext(u.uid, { dsid: old.dsid }).firestore();
    const newFs = env.authenticatedContext(u.uid, { dsid: reg.device.dsid }).firestore();
    await assertFails(oldFs.doc(`users/${u.uid}`).get());
    await assertSucceeds(newFs.doc(`users/${u.uid}`).get());
    await assertSucceeds(newFs.doc(PATHS.deviceSession(old.dsid)).get());
  });
});
