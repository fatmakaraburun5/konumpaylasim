/**
 * Sosyal grafik yardımcıları (transaction içinde okunur).
 * Paylaşım için: kabul edilmiş arkadaşlık VE iki yönde de engel yok.
 */
import type { EpochMs, ShareEndReason, UserId } from '@konum/core';
import { type DocumentReference, FieldValue, type Transaction } from 'firebase-admin/firestore';
import type { AclSource } from './acl';
import {
  COL,
  type FriendshipDoc,
  type PlaceNoteDoc,
  type RequestDoc,
  type ShareDoc,
  type UserDoc,
  endedShare,
  isUsableProfile,
  purgeAt,
  refs,
} from './docs';
import { db } from './admin';
import { fail } from './errors';

export interface PairState {
  friendship: FriendshipDoc | null;
  blocked: boolean;
}

export const canShare = (p: PairState): boolean => p.friendship?.status === 'accepted' && !p.blocked;

export const needsProfile = () =>
  fail('invalid_argument', { httpsCode: 'failed-precondition', message: 'Önce profil oluşturulmalı (user_bootstrap)' });

/**
 * Çağıranın profili (transaction okuma aşaması). Profil yoksa ya da hesap siliniyorsa yeni paylaşım,
 * istek ve engel oluşturulamaz: silinen hesabın hâlâ geçerli ID token'ı (≤ 1 sa) ile hayalet kayıt açılmaz.
 */
export async function readCaller(tx: Transaction, uid: UserId): Promise<UserDoc> {
  const snap = await tx.get(refs.user(uid));
  const u = snap.data() as UserDoc | undefined;
  if (!isUsableProfile(u)) throw needsProfile();
  return u;
}

/** Birden çok karşı taraf için tek `getAll` (3 belge / kişi). */
export async function readPairStates(tx: Transaction, me: UserId, others: readonly UserId[]): Promise<PairState[]> {
  if (others.length === 0) return [];
  const docRefs = others.flatMap((o) => [refs.friendship(me, o), refs.block(me, o), refs.block(o, me)]);
  const snaps = await tx.getAll(...docRefs);
  return others.map((_, i) => {
    const [f, b1, b2] = [snaps[i * 3], snaps[i * 3 + 1], snaps[i * 3 + 2]];
    return {
      friendship: f?.exists ? (f.data() as FriendshipDoc) : null,
      blocked: Boolean(b1?.exists || b2?.exists),
    };
  });
}

export interface PairCascade {
  shares: ShareDoc[];
  pendingRequests: { ref: DocumentReference; doc: RequestDoc }[];
}

/** İki yöndeki paylaşımlar ve bekleyen konum istekleri (arkadaşlık kaldırma / engelleme). */
export async function readPairCascade(tx: Transaction, a: UserId, b: UserId): Promise<PairCascade> {
  const reqRefs = [refs.request(a, b), refs.request(b, a)];
  const snaps = await tx.getAll(refs.share(a, b), refs.share(b, a), ...reqRefs);
  const shares = snaps.slice(0, 2).filter((s) => s.exists).map((s) => s.data() as ShareDoc);
  const pendingRequests = snaps
    .slice(2)
    .map((s, i) => ({ ref: reqRefs[i] as DocumentReference, snap: s }))
    .filter((r) => r.snap.exists && (r.snap.data() as RequestDoc).status === 'pending')
    .map((r) => ({ ref: r.ref, doc: r.snap.data() as RequestDoc }));
  return { shares, pendingRequests };
}

/** Bitirme alanları (tam belge yerine yalnızca değişenler). */
export function endFields(e: ShareDoc) {
  return {
    status: e.status,
    ended_at: e.ended_at,
    end_reason: e.end_reason,
    version: e.version,
    updated_at: e.updated_at,
    purge_at: e.purge_at ?? null,
  };
}

/**
 * Aktif paylaşımları bitirir, bekleyen istekleri iptal eder. Biten paylaşımları döndürür (ACL için).
 *
 * Engelleme de bu fonksiyonu `friendship_removed` nedeniyle çağırır: paylaşım belgesini iki taraf 7 gün okur ve
 * `blocked` yazılsaydı engellenen, engellendiğini öğrenirdi. Engelleyen bunu kendi `blocks` kaydından bilir.
 * 'blocked' nedeni karşı tarafın okuyabildiği bir belgeye ASLA yazılmaz.
 */
export function writePairCascade(
  tx: Transaction,
  c: PairCascade,
  reason: Exclude<ShareEndReason, 'blocked'>,
  now: EpochMs,
): AclSource[] {
  const ended: AclSource[] = [];
  for (const s of c.shares) {
    const e = endedShare(s, reason, now);
    if (!e) continue;
    tx.update(refs.shareById(s.share_id), endFields(e));
    ended.push(e);
  }
  for (const r of c.pendingRequests) {
    tx.update(r.ref, { status: 'cancelled', updated_at: now, purge_at: purgeAt(now) });
  }
  return ended;
}

// ---------------------------------------------------------------------------
// Faz 4: arkadaşlık biterken (kaldırma / engelleme) acil kişi ve yer notu kitlesi temizliği
// ---------------------------------------------------------------------------

export interface PairF4Cleanup {
  /** `emergency_contacts` listesinden çıkarılacak karşı taraf. */
  contacts: { ref: DocumentReference; remove: UserId }[];
  /** `visible_to` listesinden çıkarılacak karşı taraf (yer notları). */
  notes: { ref: DocumentReference; remove: UserId }[];
}

/**
 * Okuma aşaması: iki kullanıcının acil kişi listelerinde ve yer notlarının kitlesinde karşı taraf var mı?
 * Sorgu `owner_id == a && visible_to array-contains b` bileşik dizin ister (firestore.indexes.json).
 */
export async function readPairF4Cleanup(tx: Transaction, a: UserId, b: UserId): Promise<PairF4Cleanup> {
  const [ua, ub] = await tx.getAll(refs.user(a), refs.user(b));
  const contacts: PairF4Cleanup['contacts'] = [];
  for (const [snap, other] of [
    [ua, b],
    [ub, a],
  ] as const) {
    const list = (snap?.data() as UserDoc | undefined)?.emergency_contacts;
    if (snap?.exists && Array.isArray(list) && list.includes(other)) contacts.push({ ref: snap.ref, remove: other });
  }
  const notesCol = db().collection(COL.placeNotes);
  const [na, nb] = await Promise.all([
    tx.get(notesCol.where('owner_id', '==', a).where('visible_to', 'array-contains', b)),
    tx.get(notesCol.where('owner_id', '==', b).where('visible_to', 'array-contains', a)),
  ]);
  const notes: PairF4Cleanup['notes'] = [
    ...na.docs.filter((d) => (d.data() as PlaceNoteDoc).owner_id === a).map((d) => ({ ref: d.ref, remove: b })),
    ...nb.docs.filter((d) => (d.data() as PlaceNoteDoc).owner_id === b).map((d) => ({ ref: d.ref, remove: a })),
  ];
  return { contacts, notes };
}

/** Yazma aşaması: karşı tarafı listelerden çıkarır (belge yoksa dokunmaz; okuma aşaması var olanları seçti). */
export function writePairF4Cleanup(tx: Transaction, c: PairF4Cleanup): void {
  for (const x of c.contacts) tx.update(x.ref, { emergency_contacts: FieldValue.arrayRemove(x.remove) });
  for (const x of c.notes) tx.update(x.ref, { visible_to: FieldValue.arrayRemove(x.remove) });
}
