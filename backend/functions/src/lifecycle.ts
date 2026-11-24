/**
 * Toplu paylaşım bitirme (süre dolumu görevi ve taraması, hesap silme, pasif hesap süreci).
 * Her parça transaction içinde YENİDEN OKUNARAK bitirilir: sorgu ile commit arasında uzatılan bir paylaşım
 * yanlışlıkla bitirilmez. Bitirmeyle aynı transaction'da `acl_pending` işareti yazılır.
 */
import type { EpochMs, ShareEndReason } from '@konum/core';
import { writeAclPending } from './acl';
import { db } from './admin';
import { COL, type ShareDoc, endedShare, refs } from './docs';
import { endFields } from './graph';
import { chunk, unique } from './util';

export async function endSharesById(
  ids: readonly string[],
  decide: (s: ShareDoc) => ShareEndReason | null,
  now: EpochMs,
  chunkSize = 100,
): Promise<ShareDoc[]> {
  const out: ShareDoc[] = [];
  for (const part of chunk(unique(ids), chunkSize)) {
    const ended = await db().runTransaction(async (tx) => {
      const snaps = await tx.getAll(...part.map((id) => refs.shareById(id)));
      const res: ShareDoc[] = [];
      for (const snap of snaps) {
        if (!snap.exists) continue;
        const s = snap.data() as ShareDoc;
        const reason = decide(s);
        if (!reason) continue;
        const e = endedShare(s, reason, now);
        if (!e) continue;
        tx.update(snap.ref, endFields(e));
        writeAclPending(tx, e, now);
        res.push(e);
      }
      return res;
    });
    out.push(...ended);
  }
  return out;
}

/** Kullanıcının iki yöndeki aktif paylaşımlarının kimlikleri. */
export async function activeShareIdsOf(uid: string): Promise<string[]> {
  const shares = db().collection(COL.shares);
  const [out, inc] = await Promise.all([
    shares.where('sender_id', '==', uid).where('status', '==', 'active').get(),
    shares.where('receiver_id', '==', uid).where('status', '==', 'active').get(),
  ]);
  return [...out.docs, ...inc.docs].map((d) => d.id);
}
