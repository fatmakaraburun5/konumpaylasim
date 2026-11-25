/**
 * İNCELEME → regresyon testleri. İlk incelemede her biri bir gizlilik açığını gösteriyordu; düzeltmelerden
 * sonra geçmeleri gerekir. Sorgular mobilin kurallarca izin verilen biçimidir (kısıtsız `member_ids` sorgusu
 * artık reddedilir; bkz. `myFriendshipDocs`).
 *
 *  1. Sosyal grafik kâhini: üçüncü kişi friend_request_cancel / friendship_remove ile iki uid'in
 *     arkadaş (ya da bekleyen istekli) olup olmadığını öğrenir.
 *  2. Numara kayıt kâhini: friend_request_send yanıtı aynı, ama isteyen kendi `friendships` sorgusunda
 *     hedefin uid'ini görür.
 *  3. Engel kâhini: kayıtlı olduğu bilinen eski arkadaşa telefonla istek → engellediyse belge oluşmaz.
 *  4. Engellenen, `location_shares.end_reason == 'blocked'` alanından engellendiğini okur.
 *  5. avatar_url serbest https adresi: yabancı, bekleyen istekte hedefin cihazına izleme pikseli koyar.
 */
import { assertFails } from '@firebase/rules-unit-testing';
import { friendshipId, shareId } from '@konum/core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type TestUser,
  call,
  callError,
  cleanupRulesEnv,
  clientFirestore,
  newUser,
  opId,
  randomPhone,
  signInWithPhone,
} from '../helpers/emulator';
import { befriend, outcome, start } from './helpers';

afterAll(async () => {
  await cleanupRulesEnv();
});

/**
 * Kullanıcının görebildiği TÜM arkadaşlık belgeleri: kurallar yalnızca iki sorguya izin verir
 * (kabul edilmiş: member_ids + status; bekleyen: target_id == ben). Eski kısıtsız sorgu reddedilmelidir.
 */
async function myFriendshipDocs(u: TestUser) {
  const fs = await clientFirestore(u.uid);
  await assertFails(fs.collection('friendships').where('member_ids', 'array-contains', u.uid).get());
  const [accepted, incoming] = await Promise.all([
    fs.collection('friendships').where('member_ids', 'array-contains', u.uid).where('status', '==', 'accepted').get(),
    fs.collection('friendships').where('target_id', '==', u.uid).where('status', '==', 'pending').get(),
  ]);
  return [...accepted.docs, ...incoming.docs].map((d) => d.data() as { member_ids: string[]; status: string });
}

/** İsteyenin giden istek görünümü: maskeli etiketler, hedef uid'i yok. */
async function myOutgoing(u: TestUser) {
  const fs = await clientFirestore(u.uid);
  const snap = await fs.collection(`users/${u.uid}/outgoing_requests`).get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

/** Zaman ve kimlik dışındaki biçim: iki giden kayıt ayırt edilebilir mi? */
const shape = (o: Record<string, unknown>) => `${Object.keys(o).sort().join(',')}|${String(o.via)}`;

describe('sosyal grafik kâhini (üçüncü kişi)', () => {
  it('friend_request_cancel: A–B arkadaşlığı var/yok ayrımı yabancıya görünmemeli', async () => {
    const [A, B, C, Z] = await Promise.all([newUser('A'), newUser('B'), newUser('C'), newUser('Z')]);
    await befriend(A, B);
    // C, A ve B'nin uid'lerini biliyor (ör. ortak arkadaş; uid'ler share_id / request_id / push verisinde dolaşır).
    const existing = await outcome('friend_request_cancel', { op_id: opId(), friendship_id: friendshipId(A.uid, B.uid) }, C);
    const missing = await outcome('friend_request_cancel', { op_id: opId(), friendship_id: friendshipId(A.uid, Z.uid) }, C);
    // İlk incelemede: existing = error:NOT_FOUND, missing = ok:cancelled → C, A ile B'nin arkadaş olduğunu öğreniyordu.
    expect(existing).toBe(missing);
  });

  it('friendship_remove: aynı kâhin', async () => {
    const [A, B, C, Z] = await Promise.all([newUser('A'), newUser('B'), newUser('C'), newUser('Z')]);
    await befriend(A, B);
    const existing = await outcome('friendship_remove', { op_id: opId(), friendship_id: friendshipId(A.uid, B.uid) }, C);
    const missing = await outcome('friendship_remove', { op_id: opId(), friendship_id: friendshipId(A.uid, Z.uid) }, C);
    expect(existing).toBe(missing);
  });
});

describe('telefon kayıt kâhini', () => {
  it('isteyen, hedefin kayıtlı olup olmadığını (ve uid’ini) kendi friendships sorgusundan öğrenmemeli', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    await call('friend_request_send', { op_id: opId(), via: 'phone', phone_e164: randomPhone() }, X);
    await call('friend_request_send', { op_id: opId(), via: 'phone', phone_e164: Y.phone }, X);
    const docs = await myFriendshipDocs(X);
    // İlk incelemede: bekleyen belge member_ids içinde Y.uid ile görünüyordu → numara kayıtlı + uid sızıyordu.
    expect(docs.filter((d) => d.member_ids.includes(Y.uid))).toHaveLength(0);
    // Bekleyen belgeyi doğrudan okumak da reddedilir.
    await assertFails((await clientFirestore(X.uid)).doc(`friendships/${friendshipId(X.uid, Y.uid)}`).get());
    // Giden görünüm: iki istek aynı biçimde, Y'nin uid'i yok.
    const out = await myOutgoing(X);
    expect(out).toHaveLength(2);
    expect(new Set(out.map(shape)).size).toBe(1);
    expect(JSON.stringify(out)).not.toContain(Y.uid);
  });

  it('engel kâhini: "beni engelledi" ile "arkadaşlıktan çıkardı" ayırt edilmemeli', async () => {
    const [X, Y, Z] = await Promise.all([newUser('X'), newUser('Yblocker'), newUser('Zunfriend')]);
    await befriend(X, Y);
    await befriend(X, Z);
    await call('user_block', { op_id: opId(), user_id: X.uid }, Y);
    await call('friendship_remove', { op_id: opId(), friendship_id: friendshipId(X.uid, Z.uid) }, Z);
    // X ikisinin de kayıtlı olduğunu biliyor; telefonla yeniden istek gönderir.
    await call('friend_request_send', { op_id: opId(), via: 'phone', phone_e164: Y.phone }, X);
    await call('friend_request_send', { op_id: opId(), via: 'phone', phone_e164: Z.phone }, X);
    const docs = await myFriendshipDocs(X);
    const seesY = docs.some((d) => d.member_ids.includes(Y.uid));
    const seesZ = docs.some((d) => d.member_ids.includes(Z.uid));
    // İlk incelemede: seesZ = true, seesY = false → X, Y'nin kendisini engellediğini öğreniyordu.
    expect(seesY).toBe(seesZ);
    const out = await myOutgoing(X);
    expect(out).toHaveLength(2);
    expect(new Set(out.map(shape)).size).toBe(1);
  });
});

describe('engellenen engeli öğrenmemeli', () => {
  it('engellenen alıcı paylaşım belgesinde end_reason=blocked okumamalı', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    await befriend(X, Y);
    await start(X, [Y]);
    await call('user_block', { op_id: opId(), user_id: Y.uid }, X); // X, alıcı Y'yi engeller
    const snap = await (await clientFirestore(Y.uid)).doc(`location_shares/${shareId(X.uid, Y.uid)}`).get();
    // İlk incelemede: 'blocked' → Y engellendiğini anlıyordu (friendship_remove'dan ayırt edilebilir).
    expect(snap.data()?.end_reason).not.toBe('blocked');
  });
});

describe('avatar_url izleme pikseli', () => {
  it('yabancının bekleyen isteğindeki avatar adresi saldırgan alan adına işaret etmemeli', async () => {
    const victim = await newUser('Kurban');
    const auth = await signInWithPhone(randomPhone());
    // Serbest https adresi artık reddedilir (yalnızca projenin Storage kovasındaki avatars/{uid}/...).
    const bad = await callError(
      'user_bootstrap',
      { display_name: 'Saldırgan', gender: 'male', avatar_url: 'https://tracker.attacker.example/p.gif?t=victim' },
      auth,
    );
    expect(bad.status).toBe('INVALID_ARGUMENT');
    // Başkasının avatar yolu da reddedilir.
    // Faz 6: dosya adı core AVATAR_FILE_RE ({13 hane}.jpg).
    const other = `https://firebasestorage.googleapis.com/v0/b/demo-konum.firebasestorage.app/o/avatars%2F${victim.uid}%2F1732500000000.jpg?alt=media`;
    expect((await callError('user_bootstrap', { display_name: 'Saldırgan', gender: 'male', avatar_url: other }, auth)).status).toBe('INVALID_ARGUMENT');
    const own = `https://firebasestorage.googleapis.com/v0/b/demo-konum.firebasestorage.app/o/avatars%2F${auth.uid}%2F1732500000000.jpg?alt=media`;
    await call('user_bootstrap', { display_name: 'Saldırgan', gender: 'male', avatar_url: own }, auth);
    await call('friend_request_send', { op_id: opId(), via: 'phone', phone_e164: victim.phone }, auth);
    const fs = await clientFirestore(victim.uid);
    const snap = await fs.doc(`friendships/${friendshipId(auth.uid, victim.uid)}`).get();
    const url = (snap.data()?.member_profiles?.[auth.uid]?.avatar_url ?? null) as string | null;
    // İlk incelemede: hedefin uygulaması istek kartını çizerken saldırganın sunucusuna IP + zaman sızdırıyordu
    // ve yalnızca numara KAYITLIYSA tetikleniyordu. Bekleyen istekte avatar hiç kopyalanmaz.
    expect(url).toBeNull();
  });
});
