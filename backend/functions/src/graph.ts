/**
 * Sosyal grafik yardımcıları (transaction içinde okunur).
 *
 * Faz 8: "kabul edilmiş arkadaşlık ve engel yok" (`isFriend`) hiçbir etkileşim için TEK BAŞINA yeterli değildir.
 * Her etkileşim, verinin sahibinin ya da alıcının verdiği YÖNLÜ izne (`permission_grants/{granter}_{grantee}`)
 * dayanır; karar core `access.ts` matris fonksiyonlarıyla verilir (`canShareLocation`, `canPing`, …). `readPairStates`
 * iki yöndeki izin belgesini de okur; `pairInput` çiftin durumunu matris girdisine çevirir.
 * Onay (KVKK) kapısı `readCaller` içindedir: güncel sürüm onaylanmadan veri işleyen işlem açılmaz
 * (`consent_required`); koruyucu işlemler `{ consent: false }` ile çağırır (core `consentExemptCall`).
 */
import {
  CONSENT_VERSION,
  type EpochMs,
  type PairAccessInput,
  type PermissionGrantDoc,
  type ShareEndReason,
  type UserId,
  consentRequired,
  isInvisible,
  parsePermissionGrantDoc,
} from '@konum/core';
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
  favoriteIdsOf,
  isUsableProfile,
  purgeAt,
  refs,
} from './docs';
import { db } from './admin';
import { fail } from './errors';

export interface PairState {
  friendship: FriendshipDoc | null;
  blocked: boolean;
  /** Faz 8: benim karşı tarafa verdiğim izin (`permission_grants/{ben}_{o}`); yoksa null. */
  grantOut: PermissionGrantDoc | null;
  /** Faz 8: karşı tarafın bana verdiği izin (`permission_grants/{o}_{ben}`); yoksa null. */
  grantIn: PermissionGrantDoc | null;
}

/** Kabul edilmiş arkadaşlık VE iki yönde de engel yok (core matrisindeki `friend`). Tek başına izin DEĞİLDİR. */
export const isFriend = (p: Pick<PairState, 'friendship' | 'blocked'> | undefined): boolean =>
  p?.friendship?.status === 'accepted' && !p.blocked;

/** Çağıranın matris için gereken durumu: görünmez mi, güncel onayı var mı? */
export interface CallerAccess {
  invisible: boolean;
  consent: boolean;
}

export const callerAccess = (u: UserDoc): CallerAccess => ({ invisible: isInvisible(u), consent: !consentRequired(u.consent) });

/** Çift durumu → core `access.ts` matris girdisi (X = çağıran, Y = karşı taraf). */
export function pairInput(p: PairState | undefined, me: CallerAccess): PairAccessInput {
  return {
    friend: isFriend(p),
    grantXtoY: p?.grantOut ?? null,
    grantYtoX: p?.grantIn ?? null,
    invisibleX: me.invisible,
    consentX: me.consent,
  };
}

export const needsProfile = () =>
  fail('invalid_argument', { httpsCode: 'failed-precondition', message: 'Önce profil oluşturulmalı (user_bootstrap)' });

/** Faz 8: güncel Güvenlik Sözleşmesi / KVKK sürümü onaylanmamış (`extra.current_version`). */
export const consentFail = () => fail('consent_required', { extra: { current_version: CONSENT_VERSION } });

/** Onay kapısı: profilde güncel sürüm yoksa `consent_required`. */
export function assertConsent(u: Pick<UserDoc, 'consent'> | undefined): void {
  if (consentRequired(u?.consent)) throw consentFail();
}

export interface ReadCallerOptions {
  /**
   * false: onay kapısı atlanır. YALNIZCA koruyucu işlemler (durdurma / geri alma / engelleme / silme / görünmez olma /
   * onayı kabul ya da geri çekme; core `CONSENT_EXEMPT_CALLABLES`) verir. Varsayılan: onay şart.
   */
  consent?: boolean;
}

/**
 * Çağıranın profili (transaction okuma aşaması). Profil yoksa ya da hesap siliniyorsa yeni paylaşım,
 * istek ve engel oluşturulamaz: silinen hesabın hâlâ geçerli ID token'ı (≤ 1 sa) ile hayalet kayıt açılmaz.
 * Faz 8: güncel onay yoksa `consent_required` (callable sarmalayıcısındaki ön kapıya ek olarak transaction içinde:
 * eşzamanlı `consent_withdraw` ile yarışta da yeni paylaşım açılmaz).
 */
export async function readCaller(tx: Transaction, uid: UserId, opts: ReadCallerOptions = {}): Promise<UserDoc> {
  const snap = await tx.get(refs.user(uid));
  const u = snap.data() as UserDoc | undefined;
  if (!isUsableProfile(u)) throw needsProfile();
  if (opts.consent !== false) assertConsent(u);
  return u;
}

/** Birden çok karşı taraf için tek `getAll` (5 belge / kişi: arkadaşlık, iki engel, iki yöndeki izin). */
export async function readPairStates(tx: Transaction, me: UserId, others: readonly UserId[]): Promise<PairState[]> {
  if (others.length === 0) return [];
  const docRefs = others.flatMap((o) => [refs.friendship(me, o), refs.block(me, o), refs.block(o, me), refs.grant(me, o), refs.grant(o, me)]);
  const snaps = await tx.getAll(...docRefs);
  return others.map((_, i) => {
    const [f, b1, b2, gOut, gIn] = snaps.slice(i * 5, i * 5 + 5);
    return {
      friendship: f?.exists ? (f.data() as FriendshipDoc) : null,
      blocked: Boolean(b1?.exists || b2?.exists),
      grantOut: gOut?.exists ? parsePermissionGrantDoc(gOut.data()) : null,
      grantIn: gIn?.exists ? parsePermissionGrantDoc(gIn.data()) : null,
    };
  });
}

export interface PairCascade {
  /** Çiftin üyeleri (izin belgeleri iki yönde silinir). */
  pair: readonly [UserId, UserId];
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
  return { pair: [a, b], shares, pendingRequests };
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
 * Aktif paylaşımları bitirir, bekleyen istekleri iptal eder, Faz 8: iki yöndeki izin belgelerini (ve sunucuya özel
 * ret kayıtlarını) siler. Biten paylaşımları döndürür (ACL için).
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
  const [a, b] = c.pair;
  for (const [g, e] of [
    [a, b],
    [b, a],
  ] as const) {
    tx.delete(refs.grant(g, e));
    tx.delete(refs.permissionDecline(g, e));
  }
  return ended;
}

// ---------------------------------------------------------------------------
// Faz 4: arkadaşlık biterken (kaldırma / engelleme) acil kişi ve yer notu kitlesi temizliği
// (Faz 6: aynı adımda favori listeleri de temizlenir; Faz 8: aktif SOS alıcıları da)
// ---------------------------------------------------------------------------

export interface PairF4Cleanup {
  /** `emergency_contacts` listesinden çıkarılacak karşı taraf. */
  contacts: { ref: DocumentReference; remove: UserId }[];
  /** Faz 6: `favorite_ids` listesinden çıkarılacak karşı taraf (aynı kullanıcı belgeleri okunduğu için burada). */
  favorites: { ref: DocumentReference; remove: UserId }[];
  /** `visible_to` listesinden çıkarılacak karşı taraf (yer notları). */
  notes: { ref: DocumentReference; remove: UserId }[];
  /** Faz 8: karşı tarafın aktif SOS'unun `recipient_ids` listesinden çıkarılacak taraf (tam konumu okumayı bırakır). */
  sos: { ref: DocumentReference; remove: UserId }[];
}

/**
 * Okuma aşaması: iki kullanıcının acil kişi listelerinde ve yer notlarının kitlesinde karşı taraf var mı?
 * Sorgu `owner_id == a && visible_to array-contains b` bileşik dizin ister (firestore.indexes.json).
 */
export async function readPairF4Cleanup(tx: Transaction, a: UserId, b: UserId): Promise<PairF4Cleanup> {
  const [ua, ub] = await tx.getAll(refs.user(a), refs.user(b));
  const contacts: PairF4Cleanup['contacts'] = [];
  const favorites: PairF4Cleanup['favorites'] = [];
  for (const [snap, other] of [
    [ua, b],
    [ub, a],
  ] as const) {
    const u = snap?.data() as UserDoc | undefined;
    const list = u?.emergency_contacts;
    if (snap?.exists && Array.isArray(list) && list.includes(other)) contacts.push({ ref: snap.ref, remove: other });
    if (snap?.exists && favoriteIdsOf(u).includes(other)) favorites.push({ ref: snap.ref, remove: other });
  }
  const notesCol = db().collection(COL.placeNotes);
  const sosCol = db().collection(COL.sosAlerts);
  const [na, nb, sa, sb] = await Promise.all([
    tx.get(notesCol.where('owner_id', '==', a).where('visible_to', 'array-contains', b)),
    tx.get(notesCol.where('owner_id', '==', b).where('visible_to', 'array-contains', a)),
    tx.get(sosCol.where('sender_id', '==', a).where('status', '==', 'active')),
    tx.get(sosCol.where('sender_id', '==', b).where('status', '==', 'active')),
  ]);
  const notes: PairF4Cleanup['notes'] = [
    ...na.docs.filter((d) => (d.data() as PlaceNoteDoc).owner_id === a).map((d) => ({ ref: d.ref, remove: b })),
    ...nb.docs.filter((d) => (d.data() as PlaceNoteDoc).owner_id === b).map((d) => ({ ref: d.ref, remove: a })),
  ];
  const sosOf = (snap: FirebaseFirestore.QuerySnapshot, sender: UserId, other: UserId) =>
    snap.docs
      .filter((d) => d.get('sender_id') === sender && d.get('status') === 'active' && ((d.get('recipient_ids') as UserId[] | undefined) ?? []).includes(other))
      .map((d) => ({ ref: d.ref, remove: other }));
  return { contacts, favorites, notes, sos: [...sosOf(sa, a, b), ...sosOf(sb, b, a)] };
}

/** Yazma aşaması: karşı tarafı listelerden çıkarır (belge yoksa dokunmaz; okuma aşaması var olanları seçti). */
export function writePairF4Cleanup(tx: Transaction, c: PairF4Cleanup): void {
  for (const x of c.contacts) tx.update(x.ref, { emergency_contacts: FieldValue.arrayRemove(x.remove) });
  for (const x of c.favorites) tx.update(x.ref, { favorite_ids: FieldValue.arrayRemove(x.remove) });
  for (const x of c.notes) tx.update(x.ref, { visible_to: FieldValue.arrayRemove(x.remove) });
  for (const x of c.sos) tx.update(x.ref, { recipient_ids: FieldValue.arrayRemove(x.remove) });
}
