/**
 * Arkadaşlık ve engelleme.
 *
 *  - `friendships/{min_uid}_{max_uid}` deterministik: eşzamanlı karşılıklı istekler aynı belgeye düşer;
 *    ikinci transaction `pending` + `requested_by == karşı taraf` görür ve kabul eder.
 *  - friend_request_send hedef var olsun olmasın, engelli olsun olmasın, kendisi olsun olmasın AYNI yanıtı döner
 *    VE isteyenin görebildiği AYNI izi bırakır: `users/{uid}/outgoing_requests/{oid}` (maskeli etiket).
 *    Bekleyen arkadaşlık belgesini isteyen OKUYAMAZ (yalnızca hedef okur, kural: `target_id == ben`); böylece
 *    numaranın kayıtlı olup olmadığı, hedefin uid'i ve "beni engelledi / reddetti / arkadaşlıktan çıkardı"
 *    ayrımı isteyene sızmaz. Kabul edilince arkadaşlık iki üyeye de görünür ve giden kayıt silinir.
 *  - Hız sınırı hedeften bağımsız olarak her denemede sayılır.
 *  - Bekleyen istekte `member_profiles` yalnızca isteyenin ADINI taşır (avatar yok); hedefin profili ve
 *    isteyenin güncel profili kabulde yazılır.
 *  - friend_request_cancel / friendship_remove / friend_request_respond: "kayıt yok", "üye değilsin" ve
 *    (respond'da) "kendi bekleyen isteğin" AYNI sonucu verir: üçüncü kişi iki uid'in arkadaş olup olmadığını öğrenemez.
 *  - friendship_remove / user_block: iki yöndeki paylaşımlar biter (`friendship_removed`), bekleyen konum
 *    istekleri iptal olur. Engel ayrıca engellenen telefonun HMAC'ini tutar: engellenen hesabını silip aynı
 *    numarayla yeniden kayıt olsa da engelleyene istek gönderemez.
 */
import {
  CALLABLES,
  type FriendRequestRespondSchema,
  type FriendRequestSendResponse,
  type FriendRequestSendSchema,
  HOUR,
  type UserId,
  formatInviteCode,
  friendshipId,
  maskPhone,
  normalizeInviteCode,
  sortedPair,
} from '@konum/core';
import { type DocumentReference, Timestamp } from 'firebase-admin/firestore';
import type { z } from 'zod';
import type { AclSource } from '../acl';
import { db } from '../admin';
import type { CallCtx } from '../callable';
import { LIMITS } from '../config';
import {
  COL,
  type FriendshipDoc,
  type IndexDoc,
  type OutgoingLinkDoc,
  type OutgoingRequestDoc,
  type PhoneBlockDoc,
  type UserDoc,
  type UserPrivateDoc,
  isUsableProfile,
  pendingProfile,
  publicProfile,
  refs,
} from '../docs';
import { fail } from '../errors';
import { needsProfile, readCaller, readPairCascade, readPairF4Cleanup, writePairCascade, writePairF4Cleanup } from '../graph';
import { readRateLimit, runOp, writeRateLimit } from '../ops';
import { buildFriendRequestPush, sendPushToUser } from '../push';
import type {
  FriendRequestCancelResponse,
  FriendRequestCancelSchema,
  FriendRequestRespondResponse,
  FriendshipRemoveResponse,
  FriendshipRemoveSchema,
  UserBlockResponse,
  UserBlockSchema,
  UserUnblockResponse,
  UserUnblockSchema,
} from '../schemas';
import { assertDocId, assertUid, outgoingId, phoneHmac } from '../util';

/** "Yok" ile "üye değilsin" ile "senin göremediğin bekleyen istek" aynı hatayı verir. */
const notFound = () => fail('invalid_argument', { httpsCode: 'not-found', message: 'Kayıt bulunamadı' });

/** Kabul edilen arkadaşlığa bağlı giden istek kayıtları (iki yön): transaction okuma aşaması. */
async function readLinksFor(tx: FirebaseFirestore.Transaction, fid: string) {
  const snap = await tx.get(db().collection(COL.outgoingLinks).where('friendship_id', '==', fid));
  return snap.docs.map((d) => ({ ref: d.ref, link: d.data() as OutgoingLinkDoc }));
}

/** Giden kayıt + bağlantısını siler (yazma aşaması). */
function deleteLinks(tx: FirebaseFirestore.Transaction, links: { ref: DocumentReference; link: OutgoingLinkDoc }[]) {
  for (const l of links) {
    tx.delete(l.ref);
    tx.delete(refs.outgoingRequest(l.link.requester_id, l.link.outgoing_id));
  }
}

// ---------------------------------------------------------------------------
// friend_request_send
// ---------------------------------------------------------------------------

export async function friendRequestSend(
  ctx: CallCtx,
  data: z.output<typeof FriendRequestSendSchema>,
): Promise<FriendRequestSendResponse> {
  let lookupRef: DocumentReference;
  let lookupValue: string;
  let label: string;
  if (data.via === 'invite_code') {
    const code = normalizeInviteCode(data.invite_code);
    // Biçim hatası hedefin varlığıyla ilgili bilgi taşımaz (biçim herkesçe bilinir).
    if (!code) throw fail('invalid_argument', { extra: { field: 'invite_code' } });
    lookupRef = refs.inviteCode(code);
    lookupValue = code;
    label = formatInviteCode(code);
  } else {
    lookupRef = refs.phoneIndex(data.phone_e164);
    lookupValue = data.phone_e164;
    label = maskPhone(data.phone_e164);
  }
  const oid = outgoingId(ctx.uid, data.via, lookupValue);

  return runOp(ctx, data.op_id, CALLABLES.friendRequestSend, data, async (tx) => {
    // Okuma 1: hedeften BAĞIMSIZ kontroller (hata verebilenler yalnızca bunlar).
    const [meSnap, mePrivSnap] = await tx.getAll(refs.user(ctx.uid), refs.userPrivate(ctx.uid));
    const me = meSnap?.data() as UserDoc | undefined;
    if (!isUsableProfile(me)) throw needsProfile();
    const rl = await readRateLimit(tx, ctx.uid, 'friend_request', LIMITS.friendRequestPerHour, HOUR, ctx.now);
    const response: FriendRequestSendResponse = { status: 'sent', server_now: ctx.now };

    // Okuma 2: hedef. Bundan sonra hiçbir dal hata vermez; hepsi aynı yanıtı ve aynı görünür izi bırakır.
    const idx = (await tx.get(lookupRef)).data() as IndexDoc | undefined;
    const target = idx?.user_id && idx.user_id !== ctx.uid ? idx.user_id : null;

    type Plan =
      | { kind: 'none' }
      | { kind: 'create'; doc: FriendshipDoc }
      | { kind: 'refresh'; id: string }
      | { kind: 'accept'; id: string; existing: FriendshipDoc; them: UserDoc; links: { ref: DocumentReference; link: OutgoingLinkDoc }[] };
    let plan: Plan = { kind: 'none' };

    if (target) {
      const [fSnap, b1, b2, targetSnap, targetPrivSnap] = await tx.getAll(
        refs.friendship(ctx.uid, target),
        refs.block(ctx.uid, target),
        refs.block(target, ctx.uid),
        refs.user(target),
        refs.userPrivate(target),
      );
      const myPhone = (mePrivSnap?.data() as UserPrivateDoc | undefined)?.phone_e164 ?? ctx.phone_e164;
      const targetPhone = (targetPrivSnap?.data() as UserPrivateDoc | undefined)?.phone_e164 ?? null;
      // Telefon engeli: hedef benim NUMARAMI engellemiş (eski hesabımı) ya da ben onun numarasını engellemişim.
      const phoneBlockRefs = [
        ...(myPhone ? [refs.phoneBlock(target, phoneHmac(myPhone))] : []),
        ...(targetPhone ? [refs.phoneBlock(ctx.uid, phoneHmac(targetPhone))] : []),
      ];
      const pb = phoneBlockRefs.length ? await tx.getAll(...phoneBlockRefs) : [];
      const blocked = Boolean(b1?.exists || b2?.exists || pb.some((s) => s.exists));
      const them = targetSnap?.data() as UserDoc | undefined;

      if (!blocked && isUsableProfile(them)) {
        const id = friendshipId(ctx.uid, target);
        const existing = fSnap?.exists ? (fSnap.data() as FriendshipDoc) : null;
        if (!existing) {
          plan = {
            kind: 'create',
            doc: {
              id,
              member_ids: sortedPair(ctx.uid, target),
              status: 'pending',
              requested_by: ctx.uid,
              target_id: target,
              via: data.via,
              member_profiles: { [ctx.uid]: pendingProfile(me) },
              created_at: ctx.now,
              updated_at: ctx.now,
              accepted_at: null,
            },
          };
        } else if (existing.status === 'pending' && existing.requested_by === target) {
          // Karşılıklı istek: otomatik kabul (karşı tarafın giden kayıtları da silinir).
          plan = { kind: 'accept', id, existing, them, links: await readLinksFor(tx, id) };
        } else if (existing.status === 'pending') {
          plan = { kind: 'refresh', id }; // zaten benim bekleyen isteğim
        }
        // Zaten arkadaş: no-op (giden kaydı yine yazılır; numaranın bir arkadaşa ait olduğu sızmasın).
      }
    }

    // --- yazmalar ---
    writeRateLimit(tx, rl, HOUR);
    const expires_at = ctx.now + LIMITS.outgoingRequestTtlMs;
    const writeOutgoing = (friendship_id: string | null) => {
      tx.set(refs.outgoingRequest(ctx.uid, oid), {
        id: oid,
        via: data.via,
        label,
        created_at: ctx.now,
        expires_at,
        purge_at: Timestamp.fromMillis(expires_at),
      } satisfies OutgoingRequestDoc);
      tx.set(refs.outgoingLink(ctx.uid, oid), {
        requester_id: ctx.uid,
        outgoing_id: oid,
        friendship_id,
        created_at: ctx.now,
        purge_at: Timestamp.fromMillis(expires_at),
      } satisfies OutgoingLinkDoc);
    };

    switch (plan.kind) {
      case 'create': {
        const doc = plan.doc;
        tx.set(refs.friendshipById(doc.id), doc);
        writeOutgoing(doc.id);
        const name = me.display_name;
        const to = doc.target_id as UserId;
        return {
          response,
          after: async () => {
            await sendPushToUser(to, buildFriendRequestPush(name, doc.id));
          },
        };
      }
      case 'refresh':
        writeOutgoing(plan.id);
        return { response };
      case 'accept': {
        tx.update(refs.friendshipById(plan.id), {
          status: 'accepted',
          member_profiles: { [ctx.uid]: publicProfile(me), [target as UserId]: publicProfile(plan.them) },
          updated_at: ctx.now,
          accepted_at: ctx.now,
        });
        deleteLinks(tx, plan.links);
        // Kabul edilen istek giden listede kalmaz (arkadaş listesinde görünür).
        tx.delete(refs.outgoingRequest(ctx.uid, oid));
        tx.delete(refs.outgoingLink(ctx.uid, oid));
        return { response };
      }
      case 'none':
        writeOutgoing(null);
        return { response };
    }
  });
}

// ---------------------------------------------------------------------------
// friend_request_respond / friend_request_cancel
// ---------------------------------------------------------------------------

export async function friendRequestRespond(
  ctx: CallCtx,
  data: z.output<typeof FriendRequestRespondSchema>,
): Promise<FriendRequestRespondResponse> {
  assertDocId(data.friendship_id, 'friendship_id');
  return runOp<FriendRequestRespondResponse>(ctx, data.op_id, CALLABLES.friendRequestRespond, data, async (tx) => {
    const ref = refs.friendshipById(data.friendship_id);
    const snap = await tx.get(ref);
    const f = snap.exists ? (snap.data() as FriendshipDoc) : null;
    // Sıra önemli: yok / üye değil → kabul edilmiş (iki üye de görür) → kendi bekleyen isteğim (isteyen
    // bekleyen belgeyi göremez; "yok" ile aynı yanıt).
    if (!f || !f.member_ids.includes(ctx.uid)) throw notFound();
    if (f.status !== 'pending') {
      throw fail('invalid_argument', { httpsCode: 'failed-precondition', message: 'İstek artık beklemede değil', extra: { status: f.status } });
    }
    if (f.requested_by === ctx.uid) throw notFound();
    const other = f.requested_by;
    const [meSnap, otherSnap, b1, b2] = await tx.getAll(
      refs.user(ctx.uid),
      refs.user(other),
      refs.block(ctx.uid, other),
      refs.block(other, ctx.uid),
    );
    const me = meSnap?.data() as UserDoc | undefined;
    const them = otherSnap?.data() as UserDoc | undefined;
    const blocked = Boolean(b1?.exists || b2?.exists);
    const links = await readLinksFor(tx, f.id);

    if (data.accept && !blocked && isUsableProfile(me) && isUsableProfile(them)) {
      tx.update(ref, {
        status: 'accepted',
        // İsteyenin güncel profili (avatar dahil) ve benim profilim kabulde yazılır.
        member_profiles: { [other]: publicProfile(them), [ctx.uid]: publicProfile(me) },
        updated_at: ctx.now,
        accepted_at: ctx.now,
      });
      deleteLinks(tx, links);
      return { response: { friendship_id: f.id, status: 'accepted', server_now: ctx.now } };
    }
    // Ret: belge silinir (isteyen yeniden isteyebilir); isteyene bildirim yok. Giden kaydı kendi süresince
    // "gönderildi" olarak kalır: isteyen reddi, engeli ve kayıtsız numarayı ayırt edemez.
    tx.delete(ref);
    return { response: { friendship_id: f.id, status: 'declined', server_now: ctx.now } };
  });
}

export async function friendRequestCancel(
  ctx: CallCtx,
  data: z.output<typeof FriendRequestCancelSchema>,
): Promise<FriendRequestCancelResponse> {
  if ('outgoing_id' in data) {
    const oid = data.outgoing_id;
    return runOp(ctx, data.op_id, CALLABLES.friendRequestCancel, data, async (tx) => {
      const linkSnap = await tx.get(refs.outgoingLink(ctx.uid, oid));
      const link = linkSnap.data() as OutgoingLinkDoc | undefined;
      const fSnap = link?.friendship_id ? await tx.get(refs.friendshipById(link.friendship_id)) : null;
      const f = fSnap?.exists ? (fSnap.data() as FriendshipDoc) : null;
      // Yalnızca bu istekle oluşan, hâlâ bekleyen, benim isteğim olan belge silinir. Diğer her durum sessiz.
      if (f && f.status === 'pending' && f.requested_by === ctx.uid) tx.delete(fSnap!.ref);
      tx.delete(refs.outgoingRequest(ctx.uid, oid));
      tx.delete(refs.outgoingLink(ctx.uid, oid));
      return { response: { outgoing_id: oid, status: 'cancelled', server_now: ctx.now } satisfies FriendRequestCancelResponse };
    });
  }

  assertDocId(data.friendship_id, 'friendship_id');
  return runOp(ctx, data.op_id, CALLABLES.friendRequestCancel, data, async (tx) => {
    const ref = refs.friendshipById(data.friendship_id);
    const snap = await tx.get(ref);
    const f = snap.exists ? (snap.data() as FriendshipDoc) : null;
    const response: FriendRequestCancelResponse = { friendship_id: data.friendship_id, status: 'cancelled', server_now: ctx.now };
    // Yok ya da üye değilim: AYNI başarı yanıtı, yazma yok (sosyal grafik kâhini olmasın).
    if (!f || !f.member_ids.includes(ctx.uid)) return { response };
    if (f.status !== 'pending' || f.requested_by !== ctx.uid) {
      // Kabul ile iptal yarışını kabul kazandı ya da istek karşı taraftan: iki üye de bu belgeyi görür.
      throw fail('invalid_argument', { httpsCode: 'failed-precondition', message: 'İstek iptal edilemez', extra: { status: f.status } });
    }
    const links = await readLinksFor(tx, f.id);
    tx.delete(ref);
    deleteLinks(
      tx,
      links.filter((l) => l.link.requester_id === ctx.uid),
    );
    return { response };
  });
}

// ---------------------------------------------------------------------------
// friendship_remove
// ---------------------------------------------------------------------------

export async function friendshipRemove(
  ctx: CallCtx,
  data: z.output<typeof FriendshipRemoveSchema>,
): Promise<FriendshipRemoveResponse> {
  assertDocId(data.friendship_id, 'friendship_id');
  return runOp(ctx, data.op_id, CALLABLES.friendshipRemove, data, async (tx) => {
    const ref = refs.friendshipById(data.friendship_id);
    const snap = await tx.get(ref);
    const f = snap.exists ? (snap.data() as FriendshipDoc) : null;
    const response: FriendshipRemoveResponse = { friendship_id: data.friendship_id, status: 'removed', server_now: ctx.now };
    // Yok ya da üye değilim: AYNI başarı yanıtı, yazma yok.
    if (!f || !f.member_ids.includes(ctx.uid)) return { response };
    const other = f.member_ids[0] === ctx.uid ? f.member_ids[1] : f.member_ids[0];
    const cascade = await readPairCascade(tx, ctx.uid, other);
    const links = await readLinksFor(tx, f.id);
    // Faz 4: karşı taraf iki yönde de acil kişi listesinden ve yer notu kitlesinden çıkar.
    const f4 = await readPairF4Cleanup(tx, ctx.uid, other);

    tx.delete(ref);
    writePairF4Cleanup(tx, f4);
    // Yalnızca BENİM giden kayıtlarım silinir; karşı tarafınki kendi süresince kalır (ret ile aynı görünüm).
    deleteLinks(
      tx,
      links.filter((l) => l.link.requester_id === ctx.uid),
    );
    const ended = writePairCascade(tx, cascade, 'friendship_removed', ctx.now);
    return { response, shareEffects: ended };
  });
}

// ---------------------------------------------------------------------------
// user_block / user_unblock
// ---------------------------------------------------------------------------

export async function userBlock(ctx: CallCtx, data: z.output<typeof UserBlockSchema>): Promise<UserBlockResponse> {
  assertUid(data.user_id, 'user_id');
  if (data.user_id === ctx.uid) throw fail('invalid_argument');
  const other: UserId = data.user_id;
  return runOp(ctx, data.op_id, CALLABLES.userBlock, data, async (tx) => {
    await readCaller(tx, ctx.uid);
    const [blockSnap, fSnap, otherPrivSnap] = await tx.getAll(
      refs.block(ctx.uid, other),
      refs.friendship(ctx.uid, other),
      refs.userPrivate(other),
    );
    const cascade = await readPairCascade(tx, ctx.uid, other);
    const links = fSnap?.exists ? await readLinksFor(tx, fSnap.id) : [];
    const otherPhone = (otherPrivSnap?.data() as UserPrivateDoc | undefined)?.phone_e164 ?? null;
    const f4 = await readPairF4Cleanup(tx, ctx.uid, other);

    writePairF4Cleanup(tx, f4);
    const blockDocId = refs.block(ctx.uid, other).id;
    if (!blockSnap?.exists) tx.set(refs.block(ctx.uid, other), { blocker_id: ctx.uid, blocked_id: other, created_at: ctx.now });
    if (otherPhone) {
      tx.set(refs.phoneBlock(ctx.uid, phoneHmac(otherPhone)), {
        blocker_id: ctx.uid,
        block_id: blockDocId,
        created_at: ctx.now,
      } satisfies PhoneBlockDoc);
    }
    if (fSnap?.exists) tx.delete(refs.friendship(ctx.uid, other));
    deleteLinks(
      tx,
      links.filter((l) => l.link.requester_id === ctx.uid),
    );
    // Karşı tarafın okuyabildiği paylaşım belgesine 'blocked' yazılmaz (bkz. graph.ts).
    const ended: AclSource[] = writePairCascade(tx, cascade, 'friendship_removed', ctx.now);
    // Hedef hiç olmasa da aynı yanıt.
    return { response: { status: 'blocked', server_now: ctx.now } satisfies UserBlockResponse, shareEffects: ended };
  });
}

export async function userUnblock(ctx: CallCtx, data: z.output<typeof UserUnblockSchema>): Promise<UserUnblockResponse> {
  assertUid(data.user_id, 'user_id');
  if (data.user_id === ctx.uid) throw fail('invalid_argument');
  return runOp(ctx, data.op_id, CALLABLES.userUnblock, data, async (tx) => {
    const ref = refs.block(ctx.uid, data.user_id);
    const snap = await tx.get(ref);
    const phoneBlocks = await tx.get(db().collection(COL.phoneBlocks).where('block_id', '==', ref.id));
    if (snap.exists) tx.delete(ref);
    for (const d of phoneBlocks.docs) if ((d.data() as PhoneBlockDoc).blocker_id === ctx.uid) tx.delete(d.ref);
    // Arkadaşlık geri gelmez; yeniden istek gerekir.
    return { response: { status: 'unblocked', server_now: ctx.now } satisfies UserUnblockResponse };
  });
}
