/**
 * Hesap ve arkadaşlık callable'ları: bootstrap, davet kodu, istek gönderme (numara taraması koruması),
 * karşılıklı istek, kabul/ret/iptal, engel ve hesap silme.
 */
import { INVITE_CODE_RE, friendshipId, shareId } from '@konum/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuth, db, rtdb } from '../../functions/src/admin';
import {
  type TestUser,
  call,
  callError,
  cleanupRulesEnv,
  newUser,
  opId,
  randomPhone,
  signInWithPhone,
} from '../helpers/emulator';

const fDoc = async (a: TestUser, b: TestUser) => (await db().doc(`friendships/${friendshipId(a.uid, b.uid)}`).get()).data();
const outgoing = async (u: TestUser) =>
  (await db().collection(`users/${u.uid}/outgoing_requests`).get()).docs.map((d) => d.data() as Record<string, unknown>);

let A: TestUser;

beforeAll(async () => {
  A = await newUser('Ayşe');
});

afterAll(async () => {
  await cleanupRulesEnv();
});

describe('user_bootstrap', () => {
  it('idempotent: profil, gizli telefon, telefon indeksi ve davet kodu', async () => {
    const phone = randomPhone();
    const auth = await signInWithPhone(phone);
    const first = await call('user_bootstrap', { display_name: 'Zeynep' }, auth);
    const second = await call('user_bootstrap', {}, auth);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.user).toEqual(first.user);
    expect(first.user.invite_code).toMatch(INVITE_CODE_RE);
    expect(first.user).toMatchObject({ user_id: auth.uid, display_name: 'Zeynep', avatar_url: null, rtdb_instance: 0 });
    expect((await db().doc(`users_private/${auth.uid}`).get()).data()).toMatchObject({ phone_e164: phone });
    expect((await db().doc(`phone_index/${phone}`).get()).data()).toMatchObject({ user_id: auth.uid });
    expect((await db().doc(`invite_codes/${first.user.invite_code}`).get()).data()).toMatchObject({ user_id: auth.uid });
    // Telefon users/{uid} içinde YOK (arkadaşlara kopyalanan profil de telefonsuz).
    expect(JSON.stringify(first.user)).not.toContain(phone);
  });

  it('telefonsuz kimlik reddedilir', async () => {
    const uid = `nophone${Date.now()}`;
    await adminAuth().createUser({ uid });
    const token = await adminAuth().createCustomToken(uid);
    const res = await fetch(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, returnSecureToken: true }),
    });
    const { idToken } = (await res.json()) as { idToken: string };
    const e = await callError('user_bootstrap', {}, { idToken });
    expect(e.details).toMatchObject({ code: 'unauthenticated' });
  });

  it('invite_code_regenerate: yeni kod çalışır, eski kod boşa çıkar', async () => {
    const u = await newUser('Kaan');
    const old = u.invite_code;
    const r = await call('invite_code_regenerate', { op_id: opId() }, u);
    expect(r.invite_code).toMatch(INVITE_CODE_RE);
    expect(r.invite_code).not.toBe(old);
    expect((await db().doc(`invite_codes/${old}`).get()).exists).toBe(false);
    expect((await db().doc(`users/${u.uid}`).get()).data()?.invite_code).toBe(r.invite_code);
  });
});

describe('friend_request_send', () => {
  it('bilinmeyen telefon ile kayıtlı telefon AYNI yanıtı döner', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    const unknown = await call('friend_request_send', { op_id: opId(), via: 'phone', phone_e164: randomPhone() }, X);
    const known = await call('friend_request_send', { op_id: opId(), via: 'phone', phone_e164: Y.phone }, X);
    expect(Object.keys(unknown).sort()).toEqual(Object.keys(known).sort());
    expect(unknown.status).toBe('sent');
    expect(known.status).toBe(unknown.status);
    const { server_now: _a, ...u } = unknown;
    const { server_now: _b, ...k } = known;
    expect(u).toEqual(k);
    // Kayıtlıda bekleyen istek oluşur; hedefin adı kabul edilene kadar kopyalanmaz; avatar kopyalanmaz.
    const f = await fDoc(X, Y);
    expect(f).toMatchObject({ status: 'pending', requested_by: X.uid, target_id: Y.uid, via: 'phone' });
    expect(f?.member_profiles).toEqual({ [X.uid]: { display_name: 'X', avatar_url: null } });
    // İsteyenin görünümü: iki istek için de aynı biçimde maskeli giden kayıt; hedef uid'i yok.
    const out = await outgoing(X);
    expect(out).toHaveLength(2);
    for (const o of out) {
      expect(Object.keys(o).sort()).toEqual(['created_at', 'expires_at', 'id', 'label', 'purge_at', 'via']);
      expect(o.via).toBe('phone');
      expect(String(o.label)).toContain("•");
      expect(JSON.stringify(o)).not.toContain(Y.uid);
      expect(JSON.stringify(o)).not.toContain(Y.phone);
    }
  });

  it('giden istek outgoing_id ile iptal edilir: kayıtlıda bekleyen belge de silinir, kayıtsızda sessiz', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    await call('friend_request_send', { op_id: opId(), via: 'phone', phone_e164: Y.phone }, X);
    await call('friend_request_send', { op_id: opId(), via: 'phone', phone_e164: randomPhone() }, X);
    const ids = (await outgoing(X)).map((o) => String(o.id));
    expect(ids).toHaveLength(2);
    const results = [];
    for (const id of ids) {
      const r = await call('friend_request_cancel', { op_id: opId(), outgoing_id: id }, X);
      const { server_now: _n, ...rest } = r;
      results.push(rest);
    }
    expect(results.map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
    expect(await outgoing(X)).toHaveLength(0);
    expect(await fDoc(X, Y)).toBeUndefined();
    // Bilinmeyen kimlik de aynı yanıt.
    const none = await call('friend_request_cancel', { op_id: opId(), outgoing_id: 'f'.repeat(32) }, X);
    expect(none.status).toBe('cancelled');
  });

  it('bilinmeyen davet kodu da aynı yanıtı döner; biçimsiz kod invalid_argument', async () => {
    const r = await call('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: 'LOC-ZZZZZZ' }, A);
    expect(r.status).toBe('sent');
    const e = await callError('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: 'LOC-0000' }, A);
    expect(e.details).toMatchObject({ code: 'invalid_argument' });
  });

  it('davet kodu normalize edilir; karşılıklı bekleyen istek otomatik kabul olur', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    const sloppy = ` ${Y.invite_code.slice(4, 7).toLowerCase()} ${Y.invite_code.slice(7).toLowerCase()} `;
    await call('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: sloppy }, X);
    expect((await fDoc(X, Y))?.status).toBe('pending');
    await call('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: X.invite_code }, Y);
    const f = await fDoc(X, Y);
    expect(f).toMatchObject({ status: 'accepted' });
    expect(new Set(Object.keys(f?.member_profiles ?? {}))).toEqual(new Set([X.uid, Y.uid]));
  });

  it('engel varsa sessiz no-op (aynı yanıt, belge yok)', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    await call('user_block', { op_id: opId(), user_id: X.uid }, Y);
    const r = await call('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: Y.invite_code }, X);
    expect(r.status).toBe('sent');
    expect(await fDoc(X, Y)).toBeUndefined();
    // İsteyenin görünümü kayıtsız koddaki ile aynı: bir giden kayıt.
    expect(await outgoing(X)).toHaveLength(1);
    // Engel kalkınca istek gönderilebilir (arkadaşlık kendiliğinden geri gelmez).
    await call('user_unblock', { op_id: opId(), user_id: X.uid }, Y);
    await call('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: Y.invite_code }, X);
    expect((await fDoc(X, Y))?.status).toBe('pending');
  });

  it('kendi kodu ile istek sessiz no-op', async () => {
    const r = await call('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: A.invite_code }, A);
    expect(r.status).toBe('sent');
  });
});

describe('friend_request_respond / cancel', () => {
  it('kabul: iki profil kopyalanır; isteyen kendi isteğini kabul edemez', async () => {
    const [X, Y] = await Promise.all([newUser('Xavier'), newUser('Yasemin')]);
    await call('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: Y.invite_code }, X);
    const id = friendshipId(X.uid, Y.uid);
    // İsteyen kendi bekleyen isteğini göremez: yanıt "yok" ile aynı (NOT_FOUND).
    const self = await callError('friend_request_respond', { op_id: opId(), friendship_id: id, accept: true }, X);
    expect(self.status).toBe('NOT_FOUND');
    const ok = await call('friend_request_respond', { op_id: opId(), friendship_id: id, accept: true }, Y);
    expect(ok).toMatchObject({ friendship_id: id, status: 'accepted' });
    const f = await fDoc(X, Y);
    expect(f?.member_profiles).toEqual({
      [X.uid]: { display_name: 'Xavier', avatar_url: null },
      [Y.uid]: { display_name: 'Yasemin', avatar_url: null },
    });
    // Kabul ile iptal yarışında kaybeden failed-precondition + güncel durum alır.
    const late = await callError('friend_request_cancel', { op_id: opId(), friendship_id: id }, X);
    expect(late.status).toBe('FAILED_PRECONDITION');
    expect(late.details).toMatchObject({ status: 'accepted' });
  });

  it('ret belgeyi siler; iptal idempotenttir; üçüncü kişi yanıt veremez', async () => {
    const [X, Y, Z] = await Promise.all([newUser('X'), newUser('Y'), newUser('Z')]);
    await call('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: Y.invite_code }, X);
    const id = friendshipId(X.uid, Y.uid);
    const stranger = await callError('friend_request_respond', { op_id: opId(), friendship_id: id, accept: true }, Z);
    expect(stranger.status).toBe('NOT_FOUND');
    const no = await call('friend_request_respond', { op_id: opId(), friendship_id: id, accept: false }, Y);
    expect(no.status).toBe('declined');
    expect(await fDoc(X, Y)).toBeUndefined();
    const cancel = await call('friend_request_cancel', { op_id: opId(), friendship_id: id }, X);
    expect(cancel.status).toBe('cancelled');
    // Üye olmayan / var olmayan arkadaşlık: iptal ve kaldırma aynı başarı yanıtını döner (kâhin yok).
    const foreign = friendshipId(Y.uid, Z.uid);
    expect((await call('friend_request_cancel', { op_id: opId(), friendship_id: foreign }, X)).status).toBe('cancelled');
    expect((await call('friendship_remove', { op_id: opId(), friendship_id: foreign }, X)).status).toBe('removed');
  });

  it('yol içeren kimlik invalid_argument (yol enjeksiyonu yok)', async () => {
    const e = await callError('friend_request_respond', { op_id: opId(), friendship_id: 'a/b', accept: true }, A);
    expect(e.details).toMatchObject({ code: 'invalid_argument', field: 'friendship_id' });
  });

  it('eşzamanlı karşılıklı istekler tek belgede kabul ile sonuçlanır', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    await Promise.all([
      call('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: Y.invite_code }, X),
      call('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: X.invite_code }, Y),
    ]);
    expect((await fDoc(X, Y))?.status).toBe('accepted');
  });
});

describe('account_delete', () => {
  it('profil, indeksler, arkadaşlıklar silinir; paylaşımlar account_deleted ile biter', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    await call('friend_request_send', { op_id: opId(), via: 'invite_code', invite_code: Y.invite_code }, X);
    await call('friend_request_respond', { op_id: opId(), friendship_id: friendshipId(X.uid, Y.uid), accept: true }, Y);
    await call('share_start', { op_id: opId(), receiver_ids: [Y.uid], duration: { kind: 'weekly' }, time_zone: 'Europe/Istanbul' }, X);
    await call('share_start', { op_id: opId(), receiver_ids: [X.uid], duration: { kind: 'weekly' }, time_zone: 'Europe/Istanbul' }, Y);

    const e = await callError('account_delete', { op_id: opId() }, X);
    expect(e.details).toMatchObject({ code: 'invalid_argument' });
    const r = await call('account_delete', { op_id: opId(), confirm: true }, X);
    expect(r.status).toBe('deleted');

    for (const path of [`users/${X.uid}`, `users_private/${X.uid}`, `phone_index/${X.phone}`, `invite_codes/${X.invite_code}`]) {
      expect((await db().doc(path).get()).exists, path).toBe(false);
    }
    expect(await fDoc(X, Y)).toBeUndefined();
    for (const id of [shareId(X.uid, Y.uid), shareId(Y.uid, X.uid)]) {
      expect((await db().doc(`location_shares/${id}`).get()).data()).toMatchObject({ status: 'ended', end_reason: 'account_deleted' });
    }
    await expect(adminAuth().getUser(X.uid)).rejects.toMatchObject({ code: 'auth/user-not-found' });
    // ACL düğümleri (mezar taşı dahil) silinir: uid çifti RTDB'de kalmaz.
    for (const id of [shareId(X.uid, Y.uid), shareId(Y.uid, X.uid)]) {
      expect((await rtdb().ref(`share_acl/${id}`).once('value')).exists(), id).toBe(false);
    }
    expect((await db().doc(`deleted_users/${X.uid}`).get()).exists).toBe(true);
    // Hâlâ geçerli eski ID token'ı ile hayalet profil oluşturulamaz.
    const ghost = await callError('user_bootstrap', { display_name: 'Hayalet' }, X);
    expect(ghost.status).toBe('UNAUTHENTICATED');
    expect((await db().doc(`users/${X.uid}`).get()).exists).toBe(false);
  });
});

describe('kimlik ve tekrar oynatma', () => {
  it("ayırıcı '_' içeren uid callable'larda reddedilir", async () => {
    const uid = `bad_${Date.now()}`;
    await adminAuth().createUser({ uid, phoneNumber: randomPhone() });
    const token = await adminAuth().createCustomToken(uid);
    const res = await fetch(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, returnSecureToken: true }),
    });
    const { idToken } = (await res.json()) as { idToken: string };
    const e = await callError('user_bootstrap', {}, { idToken });
    expect(e.status).toBe('UNAUTHENTICATED');
    expect((await db().doc(`users/${uid}`).get()).exists).toBe(false);
  });

  it('aynı op_id başka bir istekle kullanılamaz', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    const op = opId();
    await call('friend_request_send', { op_id: op, via: 'invite_code', invite_code: Y.invite_code }, X);
    const e = await callError('friend_request_send', { op_id: op, via: 'phone', phone_e164: randomPhone() }, X);
    expect(e.status).toBe('INVALID_ARGUMENT');
    const e2 = await callError('invite_code_regenerate', { op_id: op }, X);
    expect(e2.status).toBe('INVALID_ARGUMENT');
    // Aynı istekle tekrar: kayıtlı yanıt.
    const again = await call('friend_request_send', { op_id: op, via: 'invite_code', invite_code: Y.invite_code }, X);
    expect(again.status).toBe('sent');
  });
});
