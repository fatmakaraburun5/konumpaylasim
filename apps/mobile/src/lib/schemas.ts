/**
 * Okuma tarafı şemaları: Firestore belgeleri ve callable yanıtları.
 * core yalnızca TypeScript arayüzlerini veriyor (LocationShare, Friendship, UserProfile, *Response);
 * çalışma zamanı doğrulaması için yerel zod şemaları burada. (core_requests: bunlar core'a taşınmalı.)
 *
 * Kural: tüm zaman damgaları epoch ms (core `time.ts`). Savunma amaçlı Firestore `Timestamp`
 * gelirse de epoch ms'e çevrilir; bozuk belge sessizce atlanır.
 */
import {
  FAVORITES_LIMIT,
  GenderSchema,
  ProfileFieldsF6Schema,
  SHARE_MODES,
  type Friendship,
  type OutgoingShareView,
  type ShareEndReason,
  type ShareMode,
  type UserProfile,
} from '@konum/core';
import { z } from 'zod';

const toMillis = (v: unknown): unknown => {
  if (v && typeof v === 'object') {
    const t = v as { toMillis?: () => number; seconds?: number; nanoseconds?: number };
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
  }
  return v;
};

const epochMs = z.preprocess(toMillis, z.number().int().nonnegative());
const epochMsOrNull = z.preprocess((v) => (v === undefined ? null : toMillis(v)), z.number().int().nonnegative().nullable());

const END_REASONS = [
  'stopped_by_sender',
  'revoked_by_receiver',
  'expired',
  'friendship_removed',
  'blocked',
  'account_deleted',
] as const satisfies readonly ShareEndReason[];
// Derleme zamanı tamlık denetimi: core'a yeni bir neden eklenirse burada hata verir.
type _MissingEndReason = Exclude<ShareEndReason, (typeof END_REASONS)[number]>;
const _endReasonsComplete: _MissingEndReason extends never ? true : false = true;
void _endReasonsComplete;

const shareMode = z.enum(SHARE_MODES as [ShareMode, ...ShareMode[]]);
const uid = z.string().min(1).max(128);

export const OutgoingShareViewSchema: z.ZodType<OutgoingShareView> = z.object({
  share_id: z.string().min(1),
  session_id: z.string().min(1),
  receiver_id: uid,
  status: z.enum(['active', 'ended']),
  share_mode: shareMode,
  started_at: epochMs,
  expires_at: epochMsOrNull,
  end_reason: z.enum(END_REASONS).nullable().catch(null),
  version: z.number().int().nonnegative(),
});

/** Firestore `location_shares/{sender_id}_{receiver_id}` belgesinden istemcinin kullandığı alanlar. */
export interface ShareDoc extends OutgoingShareView {
  sender_id: string;
  ended_at: number | null;
}

export const ShareDocSchema: z.ZodType<ShareDoc> = z.object({
  share_id: z.string().min(1),
  session_id: z.string().min(1),
  sender_id: uid,
  receiver_id: uid,
  status: z.enum(['active', 'ended']),
  share_mode: shareMode,
  started_at: epochMs,
  expires_at: epochMsOrNull,
  ended_at: epochMsOrNull,
  end_reason: z.enum(END_REASONS).nullable().catch(null),
  version: z.number().int().nonnegative(),
});

/** Faz 6: bilinmeyen / bozuk cinsiyet değeri eski hesap gibi `null` sayılır (çerçeve gri). */
const genderOrNull = GenderSchema.nullable().default(null).catch(null);
const urlOrNull = z.string().nullable().default(null).catch(null);

/** Faz 6: sıralı favoriler; bozuk kimlikler ve tekrarlar atılır, en çok `FAVORITES_LIMIT`. */
const favoriteIds = z.preprocess((v) => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) if (typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x) && !out.includes(x)) out.push(x);
  return out.slice(0, FAVORITES_LIMIT);
}, z.array(z.string()));

export const UserProfileSchema: z.ZodType<UserProfile> = z.object({
  user_id: uid,
  display_name: z.string().default(''),
  avatar_url: urlOrNull,
  invite_code: z.string().default(''),
  created_at: epochMs,
  rtdb_instance: z.number().int().nonnegative().default(0),
  // --- Faz 6 (eski belgede yoksa varsayılan) ---
  gender: genderOrNull,
  avatar_thumb_url: urlOrNull,
  avatar_version: z.number().int().positive().nullable().default(null).catch(null),
  favorite_ids: favoriteIds,
});

const PublicProfileSchema = z.object({
  display_name: z.string().default(''),
  avatar_url: urlOrNull,
  // Faz 6: kabul edilmiş arkadaşlık kopyasında var; bekleyen istekte yok (gri çerçeve, baş harfler).
  gender: genderOrNull,
  avatar_thumb_url: urlOrNull,
});

export const FriendshipSchema: z.ZodType<Friendship> = z.object({
  id: z.string().min(1),
  member_ids: z.tuple([uid, uid]),
  status: z.enum(['pending', 'accepted']),
  requested_by: uid,
  via: z.enum(['invite_code', 'phone', 'qr']).catch('invite_code'),
  member_profiles: z.record(z.string(), PublicProfileSchema).default({}),
  created_at: epochMs,
  updated_at: epochMs,
});

/** `users/{uid}/outgoing_requests/{id}`: yalnızca sahibi okur, hedef uid'i yok (backend docs.ts OutgoingRequestDoc). */
export const OutgoingRequestSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/),
  via: z.enum(['invite_code', 'phone']),
  label: z.string().max(64),
  created_at: epochMs,
  expires_at: epochMs,
});

// --- callable yanıtları -------------------------------------------------------

const sharesArray = z.array(OutgoingShareViewSchema);

export const ShareStartResponseSchema = z.object({
  session_id: z.string().min(1),
  shares: sharesArray,
  skipped_receiver_ids: z.array(z.string()).default([]),
  server_now: z.number(),
});

export const ShareExtendResponseSchema = z.object({
  session_id: z.string().min(1),
  shares: sharesArray,
  expires_at: z.number(),
  share_mode: shareMode,
  server_now: z.number(),
});

export const ShareStopResponseSchema = z.object({
  session_id: z.string().min(1),
  shares: sharesArray,
  server_now: z.number(),
});

/** [Varsayım] core'da tanımlı değil: share_revoke yanıtı. */
export const ShareRevokeResponseSchema = z.object({ server_now: z.number().optional() }).loose();

export const FriendRequestSendResponseSchema = z.object({ status: z.literal('sent'), server_now: z.number() });

/** [Varsayım] core'da tanımlı değil: genel "tamam" yanıtı (respond / cancel / remove). */
export const OkResponseSchema = z.object({ server_now: z.number().optional() }).loose();

// --- user_bootstrap (core'da sözleşme yok) ----------------------------------------

/** [Varsayım: backend ile doğrulanmalı] İstek: idempotent; görünen ad yalnızca verilirse güncellenir. */
export const UserBootstrapRequestSchema = z.object({
  op_id: z.uuid(),
  display_name: z.string().trim().min(1).max(40).optional(),
  time_zone: z.string().min(1).max(64),
  /** Faz 6: Storage indirme adresi; `null` fotoğrafı kaldırır (küçük boy da). */
  avatar_url: z.url({ protocol: /^https$/ }).max(2048).nullable().optional(),
  /** Faz 6 (core `ProfileFieldsF6Schema`): `gender` oluşturmada zorunlu (sunucu `gender_required`), `avatar_thumb_url`. */
  ...ProfileFieldsF6Schema.shape,
});
export type UserBootstrapRequest = z.input<typeof UserBootstrapRequestSchema>;

/** [Varsayım] Yanıt profil içerebilir; içermezse `users/{uid}` dinleyicisi doğrudur. */
export const UserBootstrapResponseSchema = z
  .object({
    profile: UserProfileSchema.optional().catch(undefined),
    /** Backend `UserBootstrapResponse.user` (Faz 1 sözleşmesi). Bozuksa yok sayılır: dinleyici doğrudur. */
    user: UserProfileSchema.optional().catch(undefined),
    server_now: z.number().optional(),
  })
  .loose();
