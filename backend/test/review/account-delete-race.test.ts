/**
 * İNCELEME → regresyon testi. İlk incelemede account_delete önce aktif paylaşımları sorgulayıp bitiriyor,
 * arkadaşlıkları DAHA SONRA siliyordu: bu pencerede bir arkadaşın share_start'ı silinen hesaba AKTİF bir
 * paylaşım açabiliyordu. Düzeltme: önce çit (`deleted_users` + `users.deleting`), sonra arkadaşlıklar, sonra
 * iki geçişte paylaşımlar. Pencereye düşen share_start ya atlanır ya da ikinci geçişte biter; ikisi de kabul.
 *
 * Yarışı deterministik yapmak için account_delete süreç içinde çalıştırılır ve `applyShareEffects`
 * (paylaşımları bitirdikten hemen sonra çağrılan adım) sarmalanarak arkadaşın gerçek share_start
 * çağrısı (Functions emülatörü) tam o pencereye yerleştirilir. Üretim kodu değiştirilmez.
 */
import { assertFails } from '@firebase/rules-unit-testing';
import { type OutgoingShareView, shareId } from '@konum/core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { db, rtdb } from '../../functions/src/admin';
import { accountDelete } from '../../functions/src/handlers/user';
import { cleanupRulesEnv, newUser } from '../helpers/emulator';
import { befriend, start, writeLive } from './helpers';

const hook = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }));

vi.mock('../../functions/src/acl', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../functions/src/acl')>();
  return {
    ...orig,
    applyShareEffects: async (shares: Parameters<typeof orig.applyShareEffects>[0]) => {
      await orig.applyShareEffects(shares);
      const fn = hook.fn;
      hook.fn = null;
      if (fn) await fn();
    },
  };
});

afterAll(async () => {
  await cleanupRulesEnv();
});

describe('account_delete yarışı', () => {
  it('silme sırasında arkadaşın başlattığı paylaşım silinen hesaba aktif kalmamalı', async () => {
    const [X, Y] = await Promise.all([newUser('Silinen'), newUser('Arkadas')]);
    await befriend(X, Y);
    // X'in aktif bir paylaşımı olsun: silme ilk geçişte applyShareEffects çağırır (kanca orada).
    await start(X, [Y]);

    let ran = false;
    let late: OutgoingShareView | undefined;
    let skipped: string[] = [];
    hook.fn = async () => {
      ran = true;
      // İlk geçişteki paylaşımlar bitirildi: Y yeni bir süresiz paylaşım başlatmayı dener.
      const r = await start(Y, [X], { kind: 'indefinite' });
      late = r.shares[0];
      skipped = r.skipped_receiver_ids;
    };
    await accountDelete({ uid: X.uid, phone_e164: X.phone, now: Date.now() }, { op_id: crypto.randomUUID(), confirm: true });

    expect(ran, 'kanca çalışmadı').toBe(true);
    const doc = (await db().doc(`location_shares/${shareId(Y.uid, X.uid)}`).get()).data();
    const acl = (await rtdb().ref(`share_acl/${shareId(Y.uid, X.uid)}`).once('value')).val();
    if (late) {
      // Pencereye düştü: ikinci geçiş bitirmiş olmalı.
      await assertFails(writeLive(Y, late));
      expect(doc?.status).toBe('ended');
    } else {
      expect(skipped).toContain(X.uid);
      expect(doc?.status ?? 'none').not.toBe('active');
    }
    // Her iki durumda: aktif ACL yok (hesap silmede düğümler de silinir).
    expect(acl?.status ?? null).not.toBe('active');
    expect((await db().doc(`location_shares/${shareId(X.uid, Y.uid)}`).get()).data()?.status).toBe('ended');
  });
});
