/**
 * Faz 4: yer notları — `place_note_upsert` / `place_note_delete` (Firestore `place_notes/{note_id}`).
 *
 * Durum notu ("☕ Kahve molasındayım") sunucuya hiç gelmez: cihaz canlı paketlere `note` + `note_exp` ekler
 * (RTDB kuralı doğrular). Burada yalnızca sabitlenen noktaya bırakılan notlar vardır.
 *
 *  - Metin ve emoji core `sanitizeNoteText` ile temizlenir; boş metin → `invalid_argument` (`field: text`).
 *  - `visible_to`: tekilleştirilir, kişinin kendisi atılır, kabul edilmemiş ya da engelli arkadaşlar SESSİZCE atılır
 *    (kimin arkadaş olduğu yanıttan öğrenilmez; yanıt yalnızca kabul edilen listeyi taşır). Boş = yalnızca sahibi.
 *    Faz 8 (core `noteAudienceAllowed`): yalnızca sahibin `location_view` izni verdiği arkadaşlar kalır; izin geri
 *    alınınca kişi sahibin notlarının kitlesinden çıkar (`permission_set`).
 *  - Yeni not: sahibin aktif not sayısı ≥ `NOTE_LIMITS.maxActivePlaceNotes` → `note_limit_reached`.
 *  - Düzenleme: not yoksa, süresi geçtiyse ya da sahibi değilse `note_not_found`; `created_at` korunur, süre
 *    `now + duration_ms` olarak yeniden başlar.
 *  - Silme: not yoksa `{deleted: false}` (idempotent); başkasının notu → `note_not_found`.
 *  - `purge_at` (TTL) = bitiş + pay; süpürücü süresi geçen notları zaten siler.
 */
import {
  CALLABLES,
  NOTE_LIMITS,
  type PlaceNoteDeleteRequestSchema,
  type PlaceNoteDeleteResponse,
  type PlaceNoteUpsertRequestSchema,
  type PlaceNoteUpsertResponse,
  type EpochMs,
  type UserId,
  isNoteActive,
  noteAudienceAllowed,
  sanitizeNoteText,
} from '@konum/core';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { z } from 'zod';
import { db } from '../admin';
import type { CallCtx } from '../callable';
import { LIMITS } from '../config';
import { COL, type PlaceNoteDoc, refs, toPlaceNote } from '../docs';
import { fail } from '../errors';
import { callerAccess, isFriend, pairInput, readCaller, readPairStates } from '../graph';
import { runOp } from '../ops';
import { assertDocId, chunk, isServerUid, unique } from '../util';

export async function placeNoteUpsert(ctx: CallCtx, data: z.output<typeof PlaceNoteUpsertRequestSchema>): Promise<PlaceNoteUpsertResponse> {
  const text = sanitizeNoteText(data.text);
  if (!text) throw fail('invalid_argument', { extra: { field: 'text' } });
  const emoji = data.emoji ? sanitizeNoteText(data.emoji, NOTE_LIMITS.maxEmojiChars) : null;
  if (data.note_id !== null) assertDocId(data.note_id, 'note_id');
  const audience: UserId[] = unique(data.visible_to).filter((u) => u !== ctx.uid && isServerUid(u));
  // Yeni belge kimliği transaction dışında (tekrar denemede aynı kalsın).
  const newId = data.note_id ?? refs.newPlaceNote().id;

  return runOp(ctx, data.op_id, CALLABLES.placeNoteUpsert, data, async (tx) => {
    const me = await readCaller(tx, ctx.uid);
    const ref = refs.placeNote(newId);
    let existing: PlaceNoteDoc | null = null;
    if (data.note_id !== null) {
      const snap = await tx.get(ref);
      const d = snap.data() as PlaceNoteDoc | undefined;
      if (!d || d.owner_id !== ctx.uid || !isNoteActive(d, ctx.now)) throw fail('note_not_found');
      existing = d;
    } else {
      // Tek alanlı eşitlik sorgusu (otomatik dizin); süresi geçmiş ama henüz süpürülmemiş notlar sayılmaz.
      const mine = await tx.get(db().collection(COL.placeNotes).where('owner_id', '==', ctx.uid));
      const active = mine.docs.filter((x) => isNoteActive(x.data() as PlaceNoteDoc, ctx.now)).length;
      if (active >= NOTE_LIMITS.maxActivePlaceNotes) throw fail('note_limit_reached');
    }
    const pairs = await readPairStates(tx, ctx.uid, audience);
    const access = callerAccess(me);
    const visible_to = audience.filter((_, i) => {
      const p = pairs[i];
      return isFriend(p) && noteAudienceAllowed(pairInput(p, access));
    });

    const expires_at = ctx.now + data.duration_ms;
    const doc: PlaceNoteDoc = {
      note_id: newId,
      owner_id: ctx.uid,
      emoji,
      text,
      position: { lat: data.position.lat, lng: data.position.lng, accuracy: data.position.accuracy ?? null },
      visible_to,
      created_at: existing?.created_at ?? ctx.now,
      updated_at: ctx.now,
      expires_at,
      purge_at: Timestamp.fromMillis(expires_at + LIMITS.placeNoteTtlGraceMs),
    };
    tx.set(ref, doc);
    return { response: { note: toPlaceNote(doc), server_now: ctx.now } };
  });
}

export async function placeNoteDelete(ctx: CallCtx, data: z.output<typeof PlaceNoteDeleteRequestSchema>): Promise<PlaceNoteDeleteResponse> {
  assertDocId(data.note_id, 'note_id');
  return runOp<PlaceNoteDeleteResponse>(ctx, data.op_id, CALLABLES.placeNoteDelete, data, async (tx) => {
    const ref = refs.placeNote(data.note_id);
    const snap = await tx.get(ref);
    const d = snap.data() as PlaceNoteDoc | undefined;
    if (!d) return { response: { note_id: data.note_id, deleted: false, server_now: ctx.now } };
    if (d.owner_id !== ctx.uid) throw fail('note_not_found');
    tx.delete(ref);
    return { response: { note_id: data.note_id, deleted: true, server_now: ctx.now } };
  });
}

// ---------------------------------------------------------------------------
// Bakım
// ---------------------------------------------------------------------------

/** Süresi geçen yer notlarını siler (tek alanlı `expires_at` aralığı; otomatik dizin). */
export async function sweepExpiredPlaceNotes(now: EpochMs, max: number = LIMITS.f4SweepMax): Promise<number> {
  const snap = await db().collection(COL.placeNotes).where('expires_at', '<=', now).orderBy('expires_at').limit(max).get();
  for (const part of chunk(snap.docs, 400)) {
    const batch = db().batch();
    for (const d of part) batch.delete(d.ref);
    await batch.commit();
  }
  return snap.size;
}

/** Hesap silme: kullanıcının yer notları silinir, başkalarının notlarının kitlesinden çıkarılır. */
export async function deletePlaceNotesOf(uid: UserId): Promise<void> {
  const col = db().collection(COL.placeNotes);
  const [own, shared] = await Promise.all([col.where('owner_id', '==', uid).get(), col.where('visible_to', 'array-contains', uid).get()]);
  for (const part of chunk(own.docs, 400)) {
    const batch = db().batch();
    for (const d of part) batch.delete(d.ref);
    await batch.commit();
  }
  for (const part of chunk(shared.docs.filter((d) => d.get('owner_id') !== uid), 400)) {
    const batch = db().batch();
    for (const d of part) batch.update(d.ref, { visible_to: FieldValue.arrayRemove(uid) });
    await batch.commit();
  }
}
