/**
 * Firestore kuralları: istemci sosyal grafiğe ve paylaşımlara yazamaz; okuma yalnızca ilgili taraflara;
 * uygulamanın çalıştırdığı sorgular kurallarca kabul edilir.
 */
import { randomUUID } from 'node:crypto';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { blockId, friendshipId, requestId, shareId } from '@konum/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../functions/src/admin';
import { cleanupRulesEnv, clientFirestore } from '../helpers/emulator';

const uid = (p: string) => `${p}${randomUUID().slice(0, 8)}`;
const A = uid('a');
const B = uid('b');
const C = uid('c');
const now = Date.now();

const share = (sender: string, receiver: string) => ({
  share_id: shareId(sender, receiver),
  session_id: randomUUID(),
  audience: 'friend',
  sender_id: sender,
  receiver_id: receiver,
  status: 'ended', // tetikleyici ACL yazmasın diye bitmiş paylaşım
  share_mode: 'timed',
  started_at: now,
  expires_at: now + 3_600_000,
  ended_at: now,
  end_reason: 'stopped_by_sender',
  version: 2,
  extended_count: 0,
  in_response_to: null,
  updated_at: now,
});

beforeAll(async () => {
  const [lo, hi] = A < B ? [A, B] : [B, A];
  const batch = db().batch();
  batch.set(db().doc(`users/${A}`), { user_id: A, display_name: 'A', avatar_url: null, invite_code: 'LOC-AAAAAA', created_at: now, rtdb_instance: 0 });
  batch.set(db().doc(`users_private/${A}`), { phone_e164: '+905551112233', created_at: now, updated_at: now });
  batch.set(db().doc('phone_index/+905551112233'), { user_id: A, created_at: now });
  batch.set(db().doc('invite_codes/LOC-AAAAAA'), { user_id: A, created_at: now });
  batch.set(db().doc(`ops/${A}_${randomUUID()}`), { uid: A, op: 'share_start', response: {} });
  batch.set(db().doc(`friendships/${friendshipId(A, B)}`), {
    id: friendshipId(A, B),
    member_ids: [lo, hi],
    status: 'accepted',
    requested_by: A,
    via: 'invite_code',
    member_profiles: {},
    created_at: now,
    updated_at: now,
    accepted_at: now,
  });
  // Bekleyen istek: A → C (hedef C).
  const [plo, phi] = A < C ? [A, C] : [C, A];
  batch.set(db().doc(`friendships/${friendshipId(A, C)}`), {
    id: friendshipId(A, C),
    member_ids: [plo, phi],
    status: 'pending',
    requested_by: A,
    target_id: C,
    via: 'phone',
    member_profiles: {},
    created_at: now,
    updated_at: now,
    accepted_at: null,
  });
  batch.set(db().doc(`users/${A}/outgoing_requests/o1`), {
    id: 'o1',
    via: 'phone',
    label: '+90 *** *** 22 33',
    created_at: now,
    expires_at: now + 1_000,
    purge_at: now + 1_000,
  });
  batch.set(db().doc(`location_shares/${shareId(A, B)}`), share(A, B));
  batch.set(db().doc(`location_requests/${requestId(B, A)}`), {
    request_id: requestId(B, A),
    requester_id: B,
    target_id: A,
    status: 'pending',
    created_at: now,
    expires_at: now + 900_000,
    responded_at: null,
    share_id: null,
  });
  batch.set(db().doc(`blocks/${blockId(A, C)}`), { blocker_id: A, blocked_id: C, created_at: now });
  await batch.commit();
});

afterAll(async () => {
  await cleanupRulesEnv();
});

describe('yazma yasakları', () => {
  it('istemci paylaşım ve arkadaşlık yazamaz (taraflar dahil)', async () => {
    for (const who of [A, B, C]) {
      const fs = await clientFirestore(who);
      await assertFails(fs.doc(`location_shares/${shareId(A, B)}`).set(share(A, B)));
      await assertFails(fs.doc(`location_shares/${shareId(A, B)}`).update({ status: 'active' }));
      await assertFails(fs.doc(`location_shares/${shareId(who, C === who ? A : C)}`).set(share(who, C === who ? A : C)));
      await assertFails(fs.doc(`location_shares/${shareId(A, B)}`).delete());
      await assertFails(fs.doc(`friendships/${friendshipId(A, B)}`).update({ status: 'pending' }));
      await assertFails(fs.doc(`friendships/${friendshipId(who, C === who ? B : C)}`).set({ member_ids: [who, C], status: 'accepted' }));
      await assertFails(fs.doc(`location_requests/${requestId(who, A === who ? B : A)}`).set({ requester_id: who }));
      await assertFails(fs.doc(`blocks/${blockId(who, A === who ? B : A)}`).set({ blocker_id: who }));
      await assertFails(fs.doc(`users/${who}`).set({ user_id: who, display_name: 'x' }));
    }
  });

  it('ops, users_private, phone_index, invite_codes, rate_limits ve sunucu iç koleksiyonları istemciye kapalı', async () => {
    const fs = await clientFirestore(A);
    for (const path of [
      `users_private/${A}`,
      'phone_index/+905551112233',
      'invite_codes/LOC-AAAAAA',
      `ops/${A}_x`,
      `rate_limits/${A}_friend_request`,
      `acl_pending/${shareId(A, B)}`,
      `deleted_users/${A}`,
      `phone_blocks/${A}_x`,
      `outgoing_request_links/${A}_o1`,
    ]) {
      await assertFails(fs.doc(path).get());
      await assertFails(fs.doc(path).set({ user_id: A }));
    }
    await assertFails(fs.collection('ops').where('uid', '==', A).get());
  });
});

describe('okuma', () => {
  it('paylaşımı iki taraf okur, üçüncü kişi okuyamaz', async () => {
    await assertSucceeds((await clientFirestore(A)).doc(`location_shares/${shareId(A, B)}`).get());
    await assertSucceeds((await clientFirestore(B)).doc(`location_shares/${shareId(A, B)}`).get());
    await assertFails((await clientFirestore(C)).doc(`location_shares/${shareId(A, B)}`).get());
  });

  it('gönderen sender_id sorgusu, alıcı receiver_id sorgusu çalışır; kısıtsız sorgu reddedilir', async () => {
    await assertSucceeds((await clientFirestore(A)).collection('location_shares').where('sender_id', '==', A).get());
    await assertSucceeds(
      (await clientFirestore(A)).collection('location_shares').where('sender_id', '==', A).where('status', '==', 'active').get(),
    );
    await assertSucceeds((await clientFirestore(B)).collection('location_shares').where('receiver_id', '==', B).get());
    await assertFails((await clientFirestore(C)).collection('location_shares').where('sender_id', '==', A).get());
    await assertFails((await clientFirestore(A)).collection('location_shares').get());
  });

  it('kabul edilmiş arkadaşlığı üyeler okur; member_ids + status sorgusu çalışır, kısıtsız sorgu reddedilir', async () => {
    const id = friendshipId(A, B);
    await assertSucceeds((await clientFirestore(A)).doc(`friendships/${id}`).get());
    await assertSucceeds((await clientFirestore(B)).doc(`friendships/${id}`).get());
    await assertFails((await clientFirestore(C)).doc(`friendships/${id}`).get());
    const accepted = (who: string) =>
      clientFirestore(who).then((fs) =>
        fs.collection('friendships').where('member_ids', 'array-contains', who).where('status', '==', 'accepted').get(),
      );
    const snap = await assertSucceeds(accepted(A));
    expect(snap.docs.map((d) => d.id)).toEqual([id]);
    // status kısıtı olmayan sorgu bekleyen belgeleri kapsayabilir: reddedilir.
    await assertFails((await clientFirestore(A)).collection('friendships').where('member_ids', 'array-contains', A).get());
    await assertFails(
      (await clientFirestore(C)).collection('friendships').where('member_ids', 'array-contains', A).where('status', '==', 'accepted').get(),
    );
  });

  it('bekleyen isteği YALNIZCA hedef okur (target_id sorgusu); isteyen kendi bekleyen isteğini göremez', async () => {
    const id = friendshipId(A, C);
    await assertSucceeds((await clientFirestore(C)).doc(`friendships/${id}`).get());
    const snap = await assertSucceeds(
      (await clientFirestore(C)).collection('friendships').where('target_id', '==', C).where('status', '==', 'pending').get(),
    );
    expect(snap.docs.map((d) => d.id)).toEqual([id]);
    await assertFails((await clientFirestore(A)).doc(`friendships/${id}`).get());
    await assertFails((await clientFirestore(A)).collection('friendships').where('target_id', '==', C).where('status', '==', 'pending').get());
    await assertFails((await clientFirestore(B)).doc(`friendships/${id}`).get());
  });

  it('giden istekler (users/{uid}/outgoing_requests) yalnızca sahibine açık, istemci yazamaz', async () => {
    const mine = await clientFirestore(A);
    await assertSucceeds(mine.collection(`users/${A}/outgoing_requests`).get());
    await assertSucceeds(mine.doc(`users/${A}/outgoing_requests/o1`).get());
    await assertFails(mine.doc(`users/${A}/outgoing_requests/o2`).set({ id: 'o2' }));
    await assertFails(mine.doc(`users/${A}/outgoing_requests/o1`).delete());
    await assertFails((await clientFirestore(C)).collection(`users/${A}/outgoing_requests`).get());
  });

  it('konum isteğini iki taraf okur; requester_id / target_id sorguları çalışır', async () => {
    const id = requestId(B, A);
    await assertSucceeds((await clientFirestore(A)).doc(`location_requests/${id}`).get());
    await assertSucceeds((await clientFirestore(B)).doc(`location_requests/${id}`).get());
    await assertFails((await clientFirestore(C)).doc(`location_requests/${id}`).get());
    await assertSucceeds((await clientFirestore(A)).collection('location_requests').where('target_id', '==', A).get());
    await assertSucceeds((await clientFirestore(B)).collection('location_requests').where('requester_id', '==', B).get());
  });

  it('profil yalnızca sahibine açık', async () => {
    await assertSucceeds((await clientFirestore(A)).doc(`users/${A}`).get());
    await assertFails((await clientFirestore(B)).doc(`users/${A}`).get());
  });

  it('engeli yalnızca engelleyen görür', async () => {
    const id = blockId(A, C);
    await assertSucceeds((await clientFirestore(A)).doc(`blocks/${id}`).get());
    await assertSucceeds((await clientFirestore(A)).collection('blocks').where('blocker_id', '==', A).get());
    await assertFails((await clientFirestore(C)).doc(`blocks/${id}`).get());
    await assertFails((await clientFirestore(C)).collection('blocks').where('blocked_id', '==', C).get());
  });
});

describe('devices/{uid}/tokens', () => {
  const valid = { token: 'fcm-token-123', platform: 'ios', updated_at: now };

  it('sahibi şemaya uygun yazar, günceller, siler', async () => {
    const fs = await clientFirestore(A);
    const ref = fs.doc(`devices/${A}/tokens/t1`);
    await assertSucceeds(ref.set(valid));
    await assertSucceeds(ref.set({ ...valid, platform: 'android', updated_at: now + 1 }));
    // Sunucu saat farkı kesirli olabilir (Date.now() + offset): kesirli epoch ms kabul edilir.
    await assertSucceeds(ref.set({ ...valid, updated_at: now + 0.25 }));
    await assertSucceeds(ref.delete());
  });

  it('şema dışı belge reddedilir', async () => {
    const ref = (await clientFirestore(A)).doc(`devices/${A}/tokens/t2`);
    await assertFails(ref.set({ ...valid, platform: 'web' }));
    await assertFails(ref.set({ ...valid, extra: true }));
    await assertFails(ref.set({ token: '', platform: 'ios', updated_at: now }));
    await assertFails(ref.set({ token: 'x', platform: 'ios' }));
    await assertFails(ref.set({ ...valid, updated_at: 'dün' }));
    await assertFails(ref.set({ ...valid, updated_at: 0 }));
  });

  it('başkası okuyamaz ve yazamaz', async () => {
    await assertSucceeds((await clientFirestore(A)).doc(`devices/${A}/tokens/t3`).set(valid));
    const other = await clientFirestore(B);
    await assertFails(other.doc(`devices/${A}/tokens/t3`).get());
    await assertFails(other.collection(`devices/${A}/tokens`).get());
    await assertFails(other.doc(`devices/${A}/tokens/t3`).set(valid));
    await assertFails(other.doc(`devices/${A}/tokens/t3`).delete());
  });
});

// ---------------------------------------------------------------------------
// Faz 4: yer notları ve acil durum uyarıları (yalnızca ilgililer okur, kimse yazamaz)
// ---------------------------------------------------------------------------

describe('Faz 4: place_notes / sos_alerts', () => {
  const noteId = `n${randomUUID().slice(0, 8)}`;
  const sosId = `s${randomUUID().slice(0, 8)}`;
  beforeAll(async () => {
    await db().doc(`place_notes/${noteId}`).set({ note_id: noteId, owner_id: A, emoji: '🅿️', text: 'Park yeri burası', position: { lat: 41, lng: 29, accuracy: 5 }, visible_to: [B], created_at: now, updated_at: now, expires_at: now + 3_600_000 });
    await db().doc(`sos_alerts/${sosId}`).set({ sos_id: sosId, sender_id: A, recipient_ids: [B], status: 'active', location: { lat: 41, lng: 29, accuracy: 5, timestamp: now }, created_at: now });
  });

  it('yer notu: sahibi ve visible_to okur (sorgular dahil); başkası okuyamaz; kimse yazamaz', async () => {
    const [fa, fb, fc] = await Promise.all([clientFirestore(A), clientFirestore(B), clientFirestore(C)]);
    await assertSucceeds(fa.doc(`place_notes/${noteId}`).get());
    await assertSucceeds(fa.collection('place_notes').where('owner_id', '==', A).get());
    await assertSucceeds(fb.collection('place_notes').where('visible_to', 'array-contains', B).get());
    await assertFails(fc.doc(`place_notes/${noteId}`).get());
    await assertFails(fc.collection('place_notes').where('owner_id', '==', A).get());
    await assertFails(fa.doc(`place_notes/${noteId}`).update({ text: 'x' }));
    await assertFails(fa.doc('place_notes/yeni').set({ owner_id: A, visible_to: [] }));
  });

  it('SOS: gönderen ve alıcı okur (sorgular dahil); başkası okuyamaz; kimse yazamaz', async () => {
    const [fa, fb, fc] = await Promise.all([clientFirestore(A), clientFirestore(B), clientFirestore(C)]);
    await assertSucceeds(fa.collection('sos_alerts').where('sender_id', '==', A).get());
    const got = await assertSucceeds(fb.collection('sos_alerts').where('recipient_ids', 'array-contains', B).get());
    expect(got.docs.map((d) => d.id)).toContain(sosId);
    await assertFails(fc.doc(`sos_alerts/${sosId}`).get());
    await assertFails(fb.doc(`sos_alerts/${sosId}`).update({ [`acks.${B}`]: now }));
    await assertFails(fa.doc(`sos_alerts/${sosId}`).update({ status: 'resolved' }));
  });
});

// ---------------------------------------------------------------------------
// Faz 5: bölgeler YALNIZCA sahibine; buluşma önerileri öneren + alıcılara (kimse yazamaz)
// ---------------------------------------------------------------------------

describe('Faz 5: zones / zone_events / meetups', () => {
  const zoneId = `z${randomUUID().slice(0, 8)}`;
  const meetupId = `m${randomUUID().slice(0, 8)}`;
  beforeAll(async () => {
    await db().doc(`users/${A}/zones/${zoneId}`).set({ zone_id: zoneId, owner_id: A, kind: 'home', name: 'Ev', emoji: null, center: { lat: 41, lng: 29 }, radius_m: 150, rules: [{ rule_id: 'r1', trigger: 'arrive', action: 'notify', recipient_ids: [B] }], enabled: true, time_zone: 'Europe/Istanbul', created_at: now, updated_at: now });
    await db().doc(`users/${A}/zone_events/e1`).set({ zone_id: zoneId, transition: 'arrive', occurred_at: now, notified: 1, suppressed: null });
    await db().doc(`meetups/${meetupId}`).set({ meetup_id: meetupId, from: A, from_name: 'A', to: [B], place: { place_id: null, name: 'Orta nokta', address: null, location: { lat: 41, lng: 29 }, primary_type: null, category: 'midpoint' }, etas: [], meet_at: null, note: null, responses: {}, status: 'active', created_at: now, expires_at: now + 3_600_000 });
  });

  it('bölge ve olay kaydı: yalnızca sahibi okur (kural alıcısı bile okuyamaz); kimse yazamaz', async () => {
    const [fa, fb] = await Promise.all([clientFirestore(A), clientFirestore(B)]);
    await assertSucceeds(fa.doc(`users/${A}/zones/${zoneId}`).get());
    await assertSucceeds(fa.collection(`users/${A}/zones`).get());
    await assertSucceeds(fa.collection(`users/${A}/zone_events`).get());
    await assertFails(fb.doc(`users/${A}/zones/${zoneId}`).get());
    await assertFails(fb.collection(`users/${A}/zones`).get());
    await assertFails(fb.collection(`users/${A}/zone_events`).get());
    await assertFails(fa.doc(`users/${A}/zones/${zoneId}`).update({ radius_m: 500 }));
    await assertFails(fa.doc(`users/${A}/zones/yeni`).set({ owner_id: A }));
    await assertFails(fa.doc(`zone_cooldowns/${A}_${zoneId}_arrive`).get());
  });

  it('buluşma önerisi: öneren ve alıcı okur (sorgular dahil); başkası okuyamaz; kimse yazamaz', async () => {
    const [fa, fb, fc] = await Promise.all([clientFirestore(A), clientFirestore(B), clientFirestore(C)]);
    await assertSucceeds(fa.collection('meetups').where('from', '==', A).get());
    const got = await assertSucceeds(fb.collection('meetups').where('to', 'array-contains', B).get());
    expect(got.docs.map((d) => d.id)).toContain(meetupId);
    await assertFails(fc.doc(`meetups/${meetupId}`).get());
    await assertFails(fc.collection('meetups').where('from', '==', A).get());
    await assertFails(fb.doc(`meetups/${meetupId}`).update({ [`responses.${B}`]: 'accepted' }));
    await assertFails(fa.doc(`meetups/${meetupId}`).update({ status: 'cancelled' }));
    await assertFails(fa.doc('meetup_cache/x').get());
  });
});

// ---------------------------------------------------------------------------
// Faz 8: yönlü izinler yalnızca iki tarafa; onay kayıtları yalnızca sahibine (kimse yazamaz)
// ---------------------------------------------------------------------------

describe('Faz 8: permission_grants / permission_declines / users/{uid}/consents', () => {
  const grant = (granter: string, grantee: string) => ({
    granter_id: granter,
    grantee_id: grantee,
    scopes: { location_view: { granted_at: now, via: 'manual' } },
    pending: null,
    declined_at: {},
    updated_at: now,
    version: 1,
  });
  beforeAll(async () => {
    const batch = db().batch();
    batch.set(db().doc(`permission_grants/${A}_${B}`), grant(A, B));
    batch.set(db().doc(`permission_declines/${B}_${A}`), { granter_id: B, grantee_id: A, declined_at: { ping: now }, updated_at: now });
    batch.set(db().doc(`users/${A}/consents/2026-11-25`), { user_id: A, version: '2026-11-25', text_sha256: '0'.repeat(64), scrolled_to_bottom: true, accepted_at: now, platform: 'ios', app_version: 'test', withdrawn_at: null });
    await batch.commit();
  });

  it('izin belgesini granter ve grantee okur (sorgular dahil); üçüncü kişi okuyamaz; kimse yazamaz', async () => {
    const [fa, fb, fc] = await Promise.all([clientFirestore(A), clientFirestore(B), clientFirestore(C)]);
    await assertSucceeds(fa.doc(`permission_grants/${A}_${B}`).get());
    await assertSucceeds(fb.doc(`permission_grants/${A}_${B}`).get());
    const out = await assertSucceeds(fa.collection('permission_grants').where('granter_id', '==', A).get());
    expect(out.docs.map((d) => d.id)).toContain(`${A}_${B}`);
    const inc = await assertSucceeds(fb.collection('permission_grants').where('grantee_id', '==', B).get());
    expect(inc.docs.map((d) => d.id)).toContain(`${A}_${B}`);
    await assertFails(fc.doc(`permission_grants/${A}_${B}`).get());
    await assertFails(fc.collection('permission_grants').where('granter_id', '==', A).get());
    await assertFails(fa.collection('permission_grants').get());
    // Ne granter ne grantee yazabilir (kendine izin vermek ya da istek uydurmak yok).
    await assertFails(fa.doc(`permission_grants/${A}_${B}`).update({ scopes: {} }));
    await assertFails(fb.doc(`permission_grants/${A}_${B}`).update({ 'scopes.ping': { granted_at: now, via: 'manual' } }));
    await assertFails(fb.doc(`permission_grants/${B}_${A}`).set(grant(B, A)));
    await assertFails(fa.doc(`permission_grants/${A}_${B}`).delete());
  });

  it('ret kayıtlarını yalnızca reddeden okur (isteyen reddedildiğini öğrenmez); kimse yazamaz', async () => {
    const [fa, fb, fc] = await Promise.all([clientFirestore(A), clientFirestore(B), clientFirestore(C)]);
    await assertFails(fa.doc(`permission_declines/${B}_${A}`).get());
    await assertFails(fa.collection('permission_declines').where('grantee_id', '==', A).get());
    await assertFails(fc.doc(`permission_declines/${B}_${A}`).get());
    await assertSucceeds(fb.doc(`permission_declines/${B}_${A}`).get());
    const own = await assertSucceeds(fb.collection('permission_declines').where('granter_id', '==', B).get());
    expect(own.docs.map((d) => d.id)).toContain(`${B}_${A}`);
    await assertFails(fb.doc(`permission_declines/${B}_${A}`).delete());
    await assertFails(fb.doc(`permission_declines/${B}_${A}`).update({ declined_at: {} }));
  });

  it('onay kaydını yalnızca sahibi okur; kimse yazamaz', async () => {
    const [fa, fb] = await Promise.all([clientFirestore(A), clientFirestore(B)]);
    await assertSucceeds(fa.doc(`users/${A}/consents/2026-11-25`).get());
    await assertSucceeds(fa.collection(`users/${A}/consents`).get());
    await assertFails(fb.doc(`users/${A}/consents/2026-11-25`).get());
    await assertFails(fb.collection(`users/${A}/consents`).get());
    await assertFails(fa.doc(`users/${A}/consents/2026-11-25`).update({ withdrawn_at: null, accepted_at: 1 }));
    await assertFails(fa.doc(`users/${A}/consents/2099-01-01`).set({ user_id: A, version: '2099-01-01' }));
    // Profil üzerindeki onay / görünmez alanları da istemciden yazılamaz.
    await assertFails(fa.doc(`users/${A}`).update({ consent: { version: '2026-11-25', accepted_at: now } }));
    await assertFails(fa.doc(`users/${A}`).update({ invisible: null }));
  });
});
