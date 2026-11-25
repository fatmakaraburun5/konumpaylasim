/**
 * Faz 6: favori kişiler — `favorites_set`.
 *
 * Veri: `users/{uid}.favorite_ids` (sıralı, en çok core `FAVORITES_LIMIT`; belge yalnızca sahibine açık). Sıra = widget
 * sırası; ilk favori tek tuşla paylaşımın (`widget_quick_share`) varsayılan hedefidir.
 *
 *  - İstek tüm listeyi taşır (sıralı, tekrarsız; şema `FavoritesSetRequestSchema`). Kabul edilmiş + engelsiz arkadaş
 *    OLMAYAN kimlikler (kendisi, yabancı, engelli, sunucu uid biçimine uymayan) SESSİZCE düşer (core
 *    `sanitizeFavorites`); yanıt saklanan listeyi döner. Profil yoksa / hesap siliniyorsa `failed-precondition`.
 *  - Arkadaşlık kaldırma / engelleme (graph.ts `readPairF4Cleanup`), pasif hesap sıfırlaması ve hesap silme
 *    (`removeFromFavorites`) uid'i karşı tarafın listesinden de çıkarır.
 */
import {
  CALLABLES,
  type FavoritesSetRequestSchema,
  type FavoritesSetResponse,
  type UserId,
  sanitizeFavorites,
} from '@konum/core';
import { FieldValue } from 'firebase-admin/firestore';
import type { z } from 'zod';
import { db } from '../admin';
import type { CallCtx } from '../callable';
import { COL, refs } from '../docs';
import { canShare, readCaller, readPairStates } from '../graph';
import { runOp } from '../ops';
import { chunk, isServerUid, unique } from '../util';

export async function favoritesSet(ctx: CallCtx, data: z.output<typeof FavoritesSetRequestSchema>): Promise<FavoritesSetResponse> {
  const candidates = unique(data.favorite_ids).filter((u) => u !== ctx.uid && isServerUid(u));
  return runOp(ctx, data.op_id, CALLABLES.favoritesSet, data, async (tx) => {
    await readCaller(tx, ctx.uid);
    const pairs = await readPairStates(tx, ctx.uid, candidates);
    const friends = new Set<UserId>(
      candidates.filter((_, i) => {
        const p = pairs[i];
        return p !== undefined && canShare(p);
      }),
    );
    const list = sanitizeFavorites(data.favorite_ids, friends);
    tx.update(refs.user(ctx.uid), { favorite_ids: list });
    return { response: { favorite_ids: list } };
  });
}

/** Hesap silme / pasif hesap sıfırlaması: uid'i herkesin favori listesinden çıkarır. Dönüş: güncellenen belge sayısı. */
export async function removeFromFavorites(uid: UserId): Promise<number> {
  const snap = await db().collection(COL.users).where('favorite_ids', 'array-contains', uid).get();
  for (const part of chunk(snap.docs, 400)) {
    const batch = db().batch();
    for (const d of part) batch.update(d.ref, { favorite_ids: FieldValue.arrayRemove(uid) });
    await batch.commit();
  }
  return snap.size;
}
