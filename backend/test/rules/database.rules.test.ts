/**
 * RTDB kuralları: canlı konum yalnızca aktif, süresi dolmamış ACL'nin alıcısına, yalnızca gönderenden.
 * ACL düğümleri Admin SDK ile (kurallar atlanarak) hazırlanır; yazmalar istemci kimliğiyle denenir.
 */
import { randomUUID } from 'node:crypto';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { SERVER_TIMESTAMP, shareId } from '@konum/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rtdb } from '../../functions/src/admin';
import {
  type LiveTarget,
  allowBattery,
  anonDb,
  cleanupRulesEnv,
  clientDb,
  deliveredFor,
  fanoutFor,
  livePathOf,
  loadDatabaseRules,
} from '../helpers/emulator';

const uid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

interface Pair extends LiveTarget {
  id: string;
}

/** Aktif ACL'li bir çift hazırlar. */
async function seedPair(opts: { expiresInMs?: number | null; status?: 'active' | 'ended' } = {}): Promise<Pair> {
  const sender = uid('s');
  const receiver = uid('r');
  const id = shareId(sender, receiver);
  const expires_at = opts.expiresInMs === null ? null : Date.now() + (opts.expiresInMs ?? 3_600_000);
  const share_mode = expires_at === null ? 'indefinite' : 'timed';
  const acl: Record<string, unknown> =
    opts.status === 'ended'
      ? { status: 'ended', version: 2, ended_at: Date.now() }
      : { sender_id: sender, receiver_id: receiver, status: 'active', share_mode, version: 1 };
  if (expires_at !== null && opts.status !== 'ended') acl.expires_at = expires_at;
  await rtdb().ref(`share_acl/${id}`).set(acl);
  await allowBattery(sender);
  return { id, sender_id: sender, receiver_id: receiver, share_mode, expires_at };
}

beforeAll(async () => {
  await loadDatabaseRules();
});

afterAll(async () => {
  await cleanupRulesEnv();
});

describe('okuma', () => {
  it('yabancı başkasının gelen kutusunu okuyamaz', async () => {
    const p = await seedPair();
    await rtdb().ref(livePathOf(p)).set({ ...deliveredFor(p), server_ts: Date.now() });
    const stranger = await clientDb(uid('x'));
    await assertFails(stranger.ref(`live_locations/${p.receiver_id}`).once('value'));
    await assertFails(stranger.ref(livePathOf(p)).once('value'));
    // Gönderen de alıcının kutusunu okuyamaz (yalnızca yazar).
    const sender = await clientDb(p.sender_id);
    await assertFails(sender.ref(livePathOf(p)).once('value'));
    await assertFails((await anonDb()).ref(livePathOf(p)).once('value'));
  });

  it('alıcı yalnızca kendi gelen kutusunu okur', async () => {
    const p = await seedPair();
    await rtdb().ref(livePathOf(p)).set({ ...deliveredFor(p), server_ts: Date.now() });
    const receiver = await clientDb(p.receiver_id);
    const snap = await assertSucceeds(receiver.ref(`live_locations/${p.receiver_id}`).once('value'));
    expect(snap.child(p.id).child('sender_id').val()).toBe(p.sender_id);
    await assertFails(receiver.ref(`live_locations/${uid('other')}`).once('value'));
    await assertFails(receiver.ref('live_locations').once('value'));
  });

  it('share_acl istemciye kapalı (okuma ve yazma)', async () => {
    const p = await seedPair();
    for (const who of [p.sender_id, p.receiver_id]) {
      const db = await clientDb(who);
      await assertFails(db.ref(`share_acl/${p.id}`).once('value'));
      await assertFails(db.ref(`share_acl/${p.id}`).set({ sender_id: p.sender_id, receiver_id: p.receiver_id, status: 'active', version: 99 }));
    }
  });
});

describe('gönderen yazması', () => {
  it('geçerli paket (core buildPackets + toFanoutUpdate) kabul edilir', async () => {
    const p = await seedPair();
    const sender = await clientDb(p.sender_id);
    await assertSucceeds(sender.ref().update(fanoutFor(p.sender_id, [p])));
    const stored = (await rtdb().ref(livePathOf(p)).once('value')).val();
    expect(stored.share_id).toBe(p.id);
    expect(stored).not.toHaveProperty('receiver_ids');
    expect(Math.abs(stored.server_ts - Date.now())).toBeLessThan(10_000);
  });

  it('süresiz paylaşım: ACL ve paket expires_at taşımaz', async () => {
    const p = await seedPair({ expiresInMs: null });
    const sender = await clientDb(p.sender_id);
    const v = deliveredFor(p);
    expect(v).not.toHaveProperty('expires_at');
    await assertSucceeds(sender.ref(livePathOf(p)).set(v));
    await assertFails(sender.ref(livePathOf(p)).set({ ...v, expires_at: Date.now() + 60_000 }));
  });

  it('ACL yoksa reddedilir', async () => {
    const sender = uid('s');
    const receiver = uid('r');
    const t: LiveTarget = { sender_id: sender, receiver_id: receiver, share_mode: 'timed', expires_at: Date.now() + 60_000 };
    await assertFails((await clientDb(sender)).ref(livePathOf(t)).set(deliveredFor(t)));
  });

  it('ended mezar taşından sonra reddedilir', async () => {
    const p = await seedPair();
    const sender = await clientDb(p.sender_id);
    await assertSucceeds(sender.ref(livePathOf(p)).set(deliveredFor(p)));
    await rtdb().ref(`share_acl/${p.id}`).set({ status: 'ended', version: 2, ended_at: Date.now() });
    await assertFails(sender.ref(livePathOf(p)).set(deliveredFor(p)));
  });

  it('expires_at geçtikten sonra reddedilir', async () => {
    const p = await seedPair({ expiresInMs: -1_000 });
    // core buildPackets süresi dolmuş hedefi zaten atlar; kuralı sınamak için paketi elle bozuyoruz.
    const v = { ...deliveredFor({ ...p, expires_at: Date.now() + 60_000 }), expires_at: p.expires_at };
    await assertFails((await clientDb(p.sender_id)).ref(livePathOf(p)).set(v));
  });

  it('sahte sender_id reddedilir', async () => {
    const p = await seedPair();
    const sender = await clientDb(p.sender_id);
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), sender_id: uid('spoof') }));
    // Başka biri (ACL'deki gönderen değil) kendi kimliğiyle de yazamaz.
    const impostor = uid('i');
    await assertFails((await clientDb(impostor)).ref(livePathOf(p)).set({ ...deliveredFor(p), sender_id: impostor }));
  });

  it('receiver_ids alanı reddedilir', async () => {
    const p = await seedPair();
    await assertFails((await clientDb(p.sender_id)).ref(livePathOf(p)).set({ ...deliveredFor(p), receiver_ids: [p.receiver_id] }));
  });

  it('bilinmeyen alan reddedilir', async () => {
    const p = await seedPair();
    await assertFails((await clientDb(p.sender_id)).ref(livePathOf(p)).set({ ...deliveredFor(p), altitude: 120 }));
  });

  it('share_id uyuşmazlığı reddedilir', async () => {
    const p = await seedPair();
    await assertFails((await clientDb(p.sender_id)).ref(livePathOf(p)).set({ ...deliveredFor(p), share_id: `${p.sender_id}_${uid('z')}` }));
  });

  it('başka bir alıcının yoluna yazma reddedilir', async () => {
    const p = await seedPair();
    const other = uid('o');
    const sender = await clientDb(p.sender_id);
    // Aynı share_id başka alıcının kutusunda: ACL'nin receiver_id'si tutmaz.
    await assertFails(sender.ref(`live_locations/${other}/${p.id}`).set(deliveredFor(p)));
  });

  it('bayat (2 dk+) ya da ileri tarihli (60 sn+) timestamp reddedilir', async () => {
    const p = await seedPair();
    const sender = await clientDb(p.sender_id);
    await assertFails(sender.ref(livePathOf(p)).set(deliveredFor(p, Date.now() - 3 * 60_000)));
    await assertFails(sender.ref(livePathOf(p)).set(deliveredFor(p, Date.now() + 2 * 60_000)));
    await assertSucceeds(sender.ref(livePathOf(p)).set(deliveredFor(p, Date.now() - 30_000)));
  });

  it('Faz 3: kuyruktan (q: 1) gelen nokta 24 sa içinde eski olabilir; daha yeni noktanın üstüne yazamaz', async () => {
    const p = await seedPair();
    const sender = await clientDb(p.sender_id);
    const now = Date.now();
    const queued = (ts: number) => ({ ...deliveredFor(p, ts), q: 1, recorded_at: ts - 500, hb: 120_000 });
    // q yoksa eski timestamp reddedilir; q: 1 ile kabul edilir.
    await assertFails(sender.ref(livePathOf(p)).set(deliveredFor(p, now - 10 * 60_000)));
    await assertSucceeds(sender.ref(livePathOf(p)).set(queued(now - 10 * 60_000)));
    // Daha eski kuyruk noktası mevcut noktayı ezemez; daha yenisi ezer.
    await assertFails(sender.ref(livePathOf(p)).set(queued(now - 20 * 60_000)));
    await assertSucceeds(sender.ref(livePathOf(p)).set(queued(now - 5 * 60_000)));
    // Taze pencere (2 dk) kuyruk noktası için baypas DEĞİL: q: 1 ise "düğümden yeni" kuralı her zaman geçerli.
    await assertSucceeds(sender.ref(livePathOf(p)).set(queued(now - 30_000)));
    await assertFails(sender.ref(livePathOf(p)).set(queued(now - 60_000)));
    // 24 saatten eski kuyruk noktası ve geçersiz q / hb reddedilir.
    await rtdb().ref(livePathOf(p)).remove();
    await assertFails(sender.ref(livePathOf(p)).set(queued(now - 25 * 3_600_000)));
    await assertFails(sender.ref(livePathOf(p)).set({ ...queued(now - 60_000), q: 2 }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), hb: 500 }));
    // Canlı paket hb ile kabul edilir; q alanını taşımayan tam yazma kuyruk işaretini kaldırır.
    await assertSucceeds(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), hb: 900_000 }));
    const snap = await rtdb().ref(livePathOf(p)).once('value');
    expect(snap.child('hb').val()).toBe(900_000);
    expect(snap.child('q').exists()).toBe(false);
  });

  it('expires_at ACL ile aynı olmalı; eksikse reddedilir', async () => {
    const p = await seedPair();
    const sender = await clientDb(p.sender_id);
    const v = deliveredFor(p);
    await assertFails(sender.ref(livePathOf(p)).set({ ...v, expires_at: (p.expires_at as number) + 60_000 }));
    const { expires_at: _drop, ...noExpiry } = v;
    await assertFails(sender.ref(livePathOf(p)).set(noExpiry));
  });

  it('share_mode ACL ile aynı olmalı (paket başka bir paylaşım modunu iddia edemez)', async () => {
    const p = await seedPair();
    const sender = await clientDb(p.sender_id);
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), share_mode: 'weekly' }));
    await assertSucceeds(sender.ref(livePathOf(p)).set(deliveredFor(p)));
  });

  it('ACL değişince (uzatma) eski expires_at taşıyan kısmi güncelleme reddedilir', async () => {
    const p = await seedPair();
    const sender = await clientDb(p.sender_id);
    await assertSucceeds(sender.ref(livePathOf(p)).set(deliveredFor(p)));
    const extended = (p.expires_at as number) + 3_600_000;
    await rtdb().ref(`share_acl/${p.id}`).update({ expires_at: extended, version: 2 });
    // Birleşik paket hâlâ eski expires_at'i taşır: alt alan güncellemesi reddedilir.
    await assertFails(sender.ref(livePathOf(p)).update({ lat: 40.5, timestamp: Date.now(), server_ts: SERVER_TIMESTAMP }));
    // Yeni expires_at ile tam paket kabul edilir.
    await assertSucceeds(sender.ref(livePathOf(p)).set(deliveredFor({ ...p, expires_at: extended })));
  });

  it('server_ts istemci saati olamaz', async () => {
    const p = await seedPair();
    await assertFails((await clientDb(p.sender_id)).ref(livePathOf(p)).set({ ...deliveredFor(p), server_ts: Date.now() - 5_000 }));
  });

  it('tip ve aralık kontrolleri', async () => {
    const p = await seedPair();
    const sender = await clientDb(p.sender_id);
    const v = deliveredFor(p);
    const bad: Record<string, unknown>[] = [
      { v: 2 },
      { lat: 91 },
      { lng: '28.9' },
      { accuracy: -1 },
      { accuracy: 5_000 },
      { speed_mps: 500 },
      { heading: 360 },
      { battery_pct: 50.5 },
      { battery_pct: 101 },
      { is_charging: 'true' },
      { activity_state: 'flying' },
      { share_mode: 'forever' },
      { timestamp: Date.now() + 0.5 },
    ];
    for (const patch of bad) {
      await assertFails(sender.ref(livePathOf(p)).set({ ...v, ...patch, server_ts: SERVER_TIMESTAMP }));
    }
    await assertSucceeds(sender.ref(livePathOf(p)).set({ ...v, battery_pct: 100, is_charging: true, heading: 0, speed_mps: 0 }));
  });

  it('Faz 7: pil paylaşımı kapalıysa battery_pct / is_charging yazılamaz, pilsiz paket geçer', async () => {
    const p = await seedPair();
    await allowBattery(p.sender_id, false);
    const sender = await clientDb(p.sender_id);
    const { battery_pct: _b, is_charging: _c, ...noBattery } = deliveredFor(p);
    await assertFails(sender.ref(livePathOf(p)).set({ ...noBattery, battery_pct: 50 }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...noBattery, is_charging: false }));
    await assertSucceeds(sender.ref(livePathOf(p)).set(noBattery));
    // Ayna istemciye kapalı: gönderen kendi aynasını açamaz.
    await assertFails(sender.ref(`privacy/${p.sender_id}`).set({ battery_share: true }));
    await assertSucceeds(sender.ref(`privacy/${p.sender_id}`).once('value'));
  });

  it('kısmi yazma: eski server_ts ile alt alan, zorunlu alan silme ve bilinmeyen alt alan reddedilir', async () => {
    const p = await seedPair();
    const sender = await clientDb(p.sender_id);
    await assertSucceeds(sender.ref(livePathOf(p)).set(deliveredFor(p)));
    await assertFails(sender.ref(`${livePathOf(p)}/lat`).set(40));
    await assertFails(sender.ref(livePathOf(p)).update({ lat: null }));
    await assertFails(sender.ref(livePathOf(p)).update({ altitude: 3, server_ts: SERVER_TIMESTAMP }));
    // Taze zaman damgalarıyla kısmi güncelleme tam paketle eşdeğerdir: kabul.
    await assertSucceeds(sender.ref(livePathOf(p)).update({ lat: 40.5, timestamp: Date.now(), server_ts: SERVER_TIMESTAMP }));
  });

  it('çok yollu yazmada tek geçersiz yol tüm güncellemeyi düşürür', async () => {
    const a = await seedPair();
    const other: LiveTarget = { ...a, receiver_id: uid('r2') }; // ACL'i yok
    const sender = await clientDb(a.sender_id);
    await assertFails(sender.ref().update(fanoutFor(a.sender_id, [a, other])));
    expect((await rtdb().ref(livePathOf(a)).once('value')).exists()).toBe(false);
  });
});

describe('silme', () => {
  it('gönderen ACL aktifken kendi kopyasını silebilir; mezar taşından sonra silemez', async () => {
    const p = await seedPair();
    const sender = await clientDb(p.sender_id);
    await assertSucceeds(sender.ref(livePathOf(p)).set(deliveredFor(p)));
    await assertSucceeds(sender.ref(livePathOf(p)).remove());

    await assertSucceeds(sender.ref(livePathOf(p)).set(deliveredFor(p)));
    await rtdb().ref(`share_acl/${p.id}`).set({ status: 'ended', version: 2, ended_at: Date.now() });
    await assertFails(sender.ref(livePathOf(p)).remove());
  });

  it('alıcı ve yabancı yazamaz/silemez', async () => {
    const p = await seedPair();
    await rtdb().ref(livePathOf(p)).set({ ...deliveredFor(p), server_ts: Date.now() });
    for (const who of [p.receiver_id, uid('x')]) {
      const db = await clientDb(who);
      await assertFails(db.ref(livePathOf(p)).remove());
      await assertFails(db.ref(livePathOf(p)).set({ ...deliveredFor(p), sender_id: who }));
    }
  });
});

// ---------------------------------------------------------------------------
// Faz 4: durum notu (canlı paket) ve ping kutusu
// ---------------------------------------------------------------------------

describe('Faz 4', () => {
  it('durum notu: note + note_exp birlikte kabul; tek başına, boş ya da 60 karakterden uzun reddedilir', async () => {
    const p = await seedPair();
    const sender = await clientDb(p.sender_id);
    const exp = Date.now() + 3_600_000;
    await assertSucceeds(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), note: '☕ Kahve molasındayım', note_exp: exp }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), note: 'Tek başına' }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), note_exp: exp }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), note: '', note_exp: exp }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), note: 'x'.repeat(61), note_exp: exp }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), note: 'ok', note_exp: 'yarın' }));
  });

  it('Faz 9: photo_id + photo_exp birlikte (≤ 61 dk ileri); dest_name + dest_state birlikte; dest_eta yalnızca near', async () => {
    const p = await seedPair();
    const sender = await clientDb(p.sender_id);
    const photo = { photo_id: 'AbCdEfGhIjKlMnOpQr_-', photo_exp: Date.now() + 3_600_000 };
    await assertSucceeds(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), ...photo, dest_name: 'Ev', dest_state: 'near', dest_eta: 1 }));
    await assertSucceeds(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), dest_name: 'Ev', dest_state: 'en_route' }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), photo_id: photo.photo_id }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), photo_exp: photo.photo_exp }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), photo_id: 'kisa', photo_exp: photo.photo_exp }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), ...photo, photo_exp: Date.now() + 2 * 3_600_000 }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), dest_name: 'Ev' }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), dest_name: 'x'.repeat(31), dest_state: 'near' }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), dest_name: 'Ev', dest_state: 'yakın' }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), dest_name: 'Ev', dest_state: 'arrived', dest_eta: 1 }));
    await assertFails(sender.ref(livePathOf(p)).set({ ...deliveredFor(p), dest_name: 'Ev', dest_state: 'near', dest_eta: 121 }));
  });

  it('ping_inbox: yalnızca alıcı okur ve siler; kimse yazamaz; ping_expiry kapalı', async () => {
    const to = uid('r');
    const path = `ping_inbox/${to}/p1`;
    await rtdb().ref(path).set({ ping_id: 'p1', from: 'f', kind: 'here', sent_at: Date.now(), expires_at: Date.now() + 60_000 });
    await rtdb().ref('ping_expiry/p1').set({ to, from: 'f', expires_at: Date.now() + 60_000 });
    const me = await clientDb(to);
    const stranger = await clientDb(uid('x'));
    await assertSucceeds(me.ref(`ping_inbox/${to}`).once('value'));
    await assertFails(stranger.ref(`ping_inbox/${to}`).once('value'));
    await assertFails(stranger.ref(path).remove());
    await assertFails(me.ref(`ping_inbox/${to}/p2`).set({ ping_id: 'p2', from: to, kind: 'here' }));
    await assertFails(me.ref(path).update({ kind: 'on_way' }));
    await assertFails(me.ref('ping_expiry').once('value'));
    await assertSucceeds(me.ref(path).remove());
  });
});
