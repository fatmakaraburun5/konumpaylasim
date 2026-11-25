/**
 * İNCELEME → regresyon testleri (ilk incelemede işaretli testler başarısızdı; düzeltmelerden sonra geçmeleri gerekir).
 *
 *  1. Süre dolunca son paket, tarama çalışana kadar eski alıcıya okunuyordu (okuma yalnızca kimliğe bağlı;
 *     BACKEND_SPEC §5'teki task-queue silmesi yoktu). Düzeltme: her süreli sürüm için `expires_at` anına
 *     Cloud Tasks görevi (`shareexpirytask` → `handleExpiryTask`) son paketi siler; dakikalık tarama yedektir.
 *     İlk testin "hiçbir sunucu işi olmadan okuma kural gereği kesilsin" biçimi REDDEDİLDİ: mobil tüm gelen
 *     kutusunu (`live_locations/{uid}`) dinler, RTDB'de üst düğümde verilen okuma alt düğümde geri alınamaz;
 *     kuralla kesmek ACL'li alt düğüm dinleyicilerine geçiş (mobil + core) gerektirir. Test görevle yeniden yazıldı.
 *  2. Ayna kaybı (callable aynası + retry:false tetikleyici başarısız) hiçbir periyodik iş tarafından
 *     onarılmaz: süresiz paylaşımda durdurulmuş paylaşıma yazma SONSUZA kadar kabul edilir.
 *  3. Paketteki share_mode ACL'ye bağlı değil (gönderen "süresiz" diye yalan söyleyebilir).
 *  4. account_delete sonrası share_acl/{gönderen}_{alıcı} mezar taşı uid çiftini sonsuza dek tutar.
 *  5. location_request_respond kabulü mevcut süresiz paylaşımı sessizce 1 saate indirir.
 *  6. Cihaz token kuralı `updated_at is int`; sunucu saati farkı kesirli gelirse token kaydı sessizce reddedilir.
 */
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { type OutgoingShareView, shareId } from '@konum/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, rtdb } from '../../functions/src/admin';
import { handleExpiryTask, sweepExpired } from '../../functions/src/handlers/sweeper';
import {
  call,
  cleanupRulesEnv,
  clientDb,
  clientFirestore,
  deliveredFor,
  livePathOf,
  loadDatabaseRules,
  newUser,
  opId,
} from '../helpers/emulator';
import { befriend, sleep, start, writeLive } from './helpers';

beforeAll(async () => {
  await loadDatabaseRules();
});

afterAll(async () => {
  await cleanupRulesEnv();
});

const aclOf = async (id: string) => (await rtdb().ref(`share_acl/${id}`).once('value')).val();

describe('süre dolumu: okuma kesilmesi', () => {
  it('expires_at anında süre dolumu görevi son paketi siler; eski alıcı okuyamaz', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    await befriend(X, Y);
    const s = (await start(X, [Y], { kind: 'preset', preset: 'm15' })).shares[0] as OutgoingShareView;
    await assertSucceeds(writeLive(X, s));
    // Benzetim: bitişe 1,5 sn kaldı (belge ve ACL aynı sürümde; görev bu sürüm için kuyrukta). Emülatörün görev
    // kuyruğu share_start görevini hemen (yük altında gecikmeli) gönderir; o görev bu kısaltılmış bitişi görüp
    // doğrudan çağrıyla yarışmasın diye benzetim yeni bir sürüm kullanır (eski sürümün görevi dokunmaz).
    const expires_at = Date.now() + 1_500;
    const version = s.version + 1;
    await rtdb().ref(`share_acl/${s.share_id}`).update({ expires_at, version });
    await db().doc(`location_shares/${s.share_id}`).update({ expires_at, version });
    const recv = await clientDb(Y.uid);
    const path = `live_locations/${Y.uid}/${s.share_id}`;
    expect((await recv.ref(path).once('value')).exists()).toBe(true);

    // Görev erken gelirse (≤ 30 sn) bitişi bekler, sonra bitirir.
    const outcome = await handleExpiryTask({ share_id: s.share_id, version });
    expect(outcome).toBe('expired');
    expect(Date.now()).toBeLessThan(expires_at + 5_000);
    expect((await recv.ref(path).once('value')).exists()).toBe(false);
    expect(await aclOf(s.share_id)).toMatchObject({ status: 'ended' });
    expect((await db().doc(`location_shares/${s.share_id}`).get()).data()).toMatchObject({ status: 'ended', end_reason: 'expired' });
    await assertFails(writeLive(X, { ...s, expires_at }));
  });

  it('görev sürüme bağlıdır: uzatılan paylaşımın eski görevi dokunmaz; çok erken görev bir şey yapmaz', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    await befriend(X, Y);
    const s = (await start(X, [Y], { kind: 'preset', preset: 'm15' })).shares[0] as OutgoingShareView;
    expect(await handleExpiryTask({ share_id: s.share_id, version: s.version }, (s.expires_at as number) - 120_000)).toBe('early');
    const ext = await call('share_extend', { op_id: opId(), session_id: s.session_id, minutes: 30 }, X);
    expect(await handleExpiryTask({ share_id: s.share_id, version: s.version }, (s.expires_at as number) + 1)).toBe('stale_version');
    expect((await db().doc(`location_shares/${s.share_id}`).get()).data()).toMatchObject({ status: 'active' });
    // Yeni sürümün görevi yeni bitişte kapatır.
    expect(await handleExpiryTask({ share_id: s.share_id, version: s.version + 1 }, ext.expires_at + 1)).toBe('expired');
    expect(await aclOf(s.share_id)).toMatchObject({ status: 'ended', version: s.version + 2 });
    // Belge zaten bitmişse görev yalnızca aynayı/kopyayı kesinleştirir.
    expect(await handleExpiryTask({ share_id: s.share_id, version: s.version + 1 })).toBe('not_active');
  });
});

describe('ayna kaybı onarılmıyor', () => {
  it('durdurulmuş süresiz paylaşım: ayna eski hâlde kaldıysa periyodik iş onu kapatmalı', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    await befriend(X, Y);
    const s = (await start(X, [Y], { kind: 'indefinite' })).shares[0] as OutgoingShareView;
    await assertSucceeds(writeLive(X, s));
    await call('share_stop', { op_id: opId(), session_id: s.session_id }, X);
    await sleep(2_000); // tetikleyiciler bitsin

    // Benzetim: share_stop'un aynası VE uzlaştırıcı başarısız oldu → ACL durdurma öncesi hâlde.
    await rtdb()
      .ref(`share_acl/${s.share_id}`)
      .set({ sender_id: X.uid, receiver_id: Y.uid, status: 'active', share_mode: s.share_mode, version: s.version });
    await rtdb().ref(livePathOf({ sender_id: X.uid, receiver_id: Y.uid })).set({ ...deliveredFor({ ...s, sender_id: X.uid }), server_ts: Date.now() });
    expect((await db().doc(`location_shares/${s.share_id}`).get()).data()?.status).toBe('ended');
    // Benzetim gerçekten açık: kayıp ayna yazmayı kabul ediyor.
    await assertSucceeds(writeLive(X, s));

    // Bakım işi: RTDB'deki aktif ACL'leri Firestore ile denetler (dakikalık zamanlayıcıda her 5 dk).
    const r = await sweepExpired({ now: Date.now(), audit: true });
    expect(r.reconciled_share_ids).toContain(s.share_id);

    await assertFails(writeLive(X, s));
    expect((await aclOf(s.share_id))?.status).toBe('ended');
    expect((await rtdb().ref(livePathOf({ sender_id: X.uid, receiver_id: Y.uid })).once('value')).exists()).toBe(false);
  });
});

describe('paket bütünlüğü', () => {
  it('share_mode ACL/paylaşımla uyuşmayan paket reddedilmeli', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    await befriend(X, Y);
    const s = (await start(X, [Y])).shares[0] as OutgoingShareView; // timed, 1 saat
    await assertFails(writeLive(X, s, { share_mode: 'indefinite' }));
  });

  it('uzatmadan sonra kısmi güncelleme eski expires_at ile kabul edilmemeli', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    await befriend(X, Y);
    const s = (await start(X, [Y], { kind: 'preset', preset: 'm15' })).shares[0] as OutgoingShareView;
    await assertSucceeds(writeLive(X, s));
    const ext = await call('share_extend', { op_id: opId(), session_id: s.session_id, minutes: 30 }, X);
    const path = livePathOf({ sender_id: X.uid, receiver_id: Y.uid });
    const sender = await clientDb(X.uid);
    const fresh = () => ({ lat: 40.1, timestamp: Date.now(), server_ts: { '.sv': 'timestamp' } });
    // Sunucu uzatmada saklanan paketi ACL'ye eşitler: alıcı yeni bitişi hemen görür, paket ACL ile hiç çelişmez.
    expect((await rtdb().ref(path).once('value')).val().expires_at).toBe(ext.expires_at);
    // Eski expires_at'i yeniden yazmaya çalışan kısmi ya da tam yazma reddedilir.
    await assertFails(sender.ref(path).update({ ...fresh(), expires_at: s.expires_at }));
    await assertFails(writeLive(X, s));
    // Kural, eşitlemeden bağımsız olarak BİRLEŞİK pakete bakar: saklanan paket eski bitişte kalmış olsa bile
    // expires_at'e dokunmayan "taze" kısmi güncelleme reddedilir (ilk incelemede kabul ediliyordu).
    await rtdb().ref(`${path}/expires_at`).set(s.expires_at);
    await assertFails(sender.ref(path).update(fresh()));
    // Yeni bitişle güncelleme kabul edilir ve saklanan paket ACL ile aynı olur.
    await assertSucceeds(sender.ref(path).update({ ...fresh(), expires_at: ext.expires_at }));
    expect((await rtdb().ref(path).once('value')).val().expires_at).toBe(ext.expires_at);
  });
});

describe('asgari veri', () => {
  it('account_delete sonrası uid çiftini taşıyan share_acl düğümü kalmamalı', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    await befriend(X, Y);
    await start(X, [Y]);
    await start(Y, [X]);
    await call('account_delete', { op_id: opId(), confirm: true }, X);
    expect(await aclOf(shareId(X.uid, Y.uid))).toBeNull();
    expect(await aclOf(shareId(Y.uid, X.uid))).toBeNull();
  });
});

describe('konum isteği kabulü', () => {
  it('mevcut süresiz paylaşım, isteğe varsayılan kabulle 1 saate inmemeli', async () => {
    const [X, Y] = await Promise.all([newUser('X'), newUser('Y')]);
    await befriend(X, Y);
    const before = (await start(Y, [X], { kind: 'indefinite' })).shares[0] as OutgoingShareView;
    expect(before.expires_at).toBeNull();
    const req = await call('location_request_send', { op_id: opId(), target_id: Y.uid }, X);
    const ok = await call('location_request_respond', { op_id: opId(), request_id: req.request_id, accept: true }, Y);
    // İlk incelemede: share_mode 'timed', expires_at = şimdi + 1 saat; Y'nin "Süresiz" oturumu da yeni oturuma taşınıyordu.
    expect(ok.share.expires_at).toBeNull();
  });
});

describe('cihaz token kuralı ↔ uygulama', () => {
  it('[Varsayım: doğrulanmalı] kesirli sunucu-saati farkıyla üretilen updated_at kabul edilmeli', async () => {
    // Uygulama updated_at = Date.now() + .info/serverTimeOffset (yuvarlanmadan). Fark kesirliyse RNFB double yollar.
    const X = await newUser('X');
    const fs = await clientFirestore(X.uid);
    await assertSucceeds(fs.doc(`devices/${X.uid}/tokens/tok-${Date.now()}`).set({ token: 'fcm-x', platform: 'ios', updated_at: Date.now() + 0.25 }));
  });
});
