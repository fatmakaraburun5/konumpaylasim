/**
 * Faz 6: favori kişiler. Sıralı liste `users/{uid}.favorite_ids` (yalnızca sahibi okur, `favorites_set` callable yazar).
 *  - Sıra = widget sırası; İLK favori tek tuşla paylaşımın varsayılan hedefidir.
 *  - En çok `FAVORITES_LIMIT` kişi (büyük widget 4 kişi gösterir).
 *  - Arkadaşlık kaldırma / engelleme / hesap silme, uid'i KARŞI tarafın listesinden de siler (backend).
 */
import { z } from 'zod';
import type { UserId } from './model';

export const FAVORITES_LIMIT = 4;

const uid = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const FavoritesSetRequestSchema = z.object({
  op_id: z.uuid(),
  /** Sıralı, tekrarsız. Sunucu kabul edilmiş arkadaş olmayanları sessizce atar (`sanitizeFavorites`). */
  favorite_ids: z
    .array(uid)
    .max(FAVORITES_LIMIT)
    .refine((a) => new Set(a).size === a.length, { message: 'Favori listesinde tekrar var' }),
});
export type FavoritesSetRequest = z.input<typeof FavoritesSetRequestSchema>;

export type FavoritesSetResponse = { favorite_ids: UserId[] };
export const FavoritesSetResponseSchema: z.ZodType<FavoritesSetResponse> = z.object({
  favorite_ids: z.array(uid).max(FAVORITES_LIMIT),
});

/** Yıldız: listede varsa çıkarır, yoksa sona ekler; sınır doluysa liste değişmez ve `error: 'limit'`. */
export function toggleFavorite(list: readonly UserId[], id: UserId): { list: UserId[]; error: 'limit' | null } {
  if (list.includes(id)) return { list: list.filter((x) => x !== id), error: null };
  if (list.length >= FAVORITES_LIMIT) return { list: [...list], error: 'limit' };
  return { list: [...list, id], error: null };
}

/** Arkadaş olmayanları atar, tekrarları siler (ilk geçen kalır), sınırda keser. Sıra korunur. */
export function sanitizeFavorites(list: readonly UserId[], acceptedFriendIds: ReadonlySet<UserId>): UserId[] {
  const out: UserId[] = [];
  for (const id of list) {
    if (out.length >= FAVORITES_LIMIT) break;
    if (acceptedFriendIds.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Sıralama düzenleyici: `delta` -1 yukarı, +1 aşağı. Sınır dışına taşmaz. */
export function moveFavorite(list: readonly UserId[], id: UserId, delta: number): UserId[] {
  const i = list.indexOf(id);
  if (i < 0) return [...list];
  const j = Math.min(list.length - 1, Math.max(0, i + delta));
  const out = [...list];
  out.splice(i, 1);
  out.splice(j, 0, id);
  return out;
}

/** Tek tuşla paylaşımın varsayılan hedefi: ilk favori. */
export const defaultFavorite = (list: readonly UserId[]): UserId | null => list[0] ?? null;

export const FAVORITE_LIMIT_TEXT = `En fazla ${FAVORITES_LIMIT} favori seçebilirsin`;
