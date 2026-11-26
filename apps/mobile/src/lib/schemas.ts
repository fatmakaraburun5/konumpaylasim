/**
 * Okuma tarafı şemaları: Firestore belgeleri ve callable yanıtları.
 * core yalnızca TypeScript arayüzlerini veriyor (LocationShare, Friendship, UserProfile, *Response);
 * çalışma zamanı doğrulaması için yerel zod şemaları burada. (core_requests: bunlar core'a taşınmalı.)
 *
 * Kural: tüm zaman damgaları epoch ms (core `time.ts`). Savunma amaçlı Firestore `Timestamp`
 * gelirse de epoch ms'e çevrilir; bozuk belge sessizce atlanır.
 */
import {
  AccessScopeSchema,
  FAVORITES_LIMIT,
  GenderSchema,
  INVISIBLE_SNAPSHOT_MAX,
  ProfileFieldsF6Schema,
  RequestableScopeSchema,
  SHARE_MODES,
  type Friendship,
  type InvisibleSnapshotEntry,
  type InvisibleState,
  type OutgoingShareView,
  type ProfileConsent,
  type ShareEndReason,
  type ShareMode,
  type UserProfile,
  parsePrivacy,
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

// --- Faz 8: görünmez mod ve onay özeti (eski belgede yok → null; bozuk alan → null) ---

const SnapshotEntrySchema = z.object({
  receiver_id: uid,
  share_mode: shareMode,
  expires_at: epochMsOrNull,
  started_at: epochMs,
});

/** Anlık görüntü: bozuk kayıtlar tek tek atılır (geri yükleme listesi bütünüyle kaybolmasın). */
const snapshotEntries = z.preprocess((v) => {
  if (!Array.isArray(v)) return [];
  const out: InvisibleSnapshotEntry[] = [];
  for (const x of v) {
    const r = SnapshotEntrySchema.safeParse(x);
    if (r.success) out.push(r.data);
  }
  return out.slice(0, INVISIBLE_SNAPSHOT_MAX);
}, z.array(SnapshotEntrySchema));

export const InvisibleStateSchema: z.ZodType<InvisibleState> = z.object({
  on: z.boolean(),
  since: epochMsOrNull,
  snapshot: snapshotEntries,
  links_ended: z.number().int().nonnegative().default(0).catch(0),
});

export const ProfileConsentSchema: z.ZodType<ProfileConsent> = z.object({
  version: z.string().min(1).max(32),
  accepted_at: epochMs,
});

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
  // --- Faz 8 (eski belgede yoksa null: görünür, onay kapısı açılır) ---
  invisible: InvisibleStateSchema.nullable().default(null).catch(null),
  consent: ProfileConsentSchema.nullable().default(null).catch(null),
  // --- Faz 7 (eski belgede yoksa varsayılan: pil paylaşımı kapalı, hareket bildirimi açık) ---
  privacy: z.unknown().transform((v) => parsePrivacy(v)),
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
  /** Faz 8: `location_view` iznim olmadığı için atlanan alıcılar. */
  needs_grant_receiver_ids: z.array(z.string()).default([]),
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

// --- Faz 8: izin / görünmez mod / onay yanıtları (core yalnızca TS arayüzü veriyor) ---------------

const requestableScope = RequestableScopeSchema;
const accessScope = AccessScopeSchema;
/** Bilinmeyen kapsam (ileri sürüm) sessizce düşer. */
const scopeList = <T extends z.ZodType<string>>(item: T) =>
  z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => item.safeParse(x).success) : []), z.array(item));

export const PermissionRequestSendResponseSchema = z.object({
  status: z.enum(['sent', 'already_granted']),
  server_now: z.number(),
});

export const PermissionRequestRespondResponseSchema = z.object({
  granted_scopes: scopeList(requestableScope),
  declined_scopes: scopeList(requestableScope),
  share: z.object({ session_id: z.string().min(1), shares: sharesArray }).nullable().default(null),
  share_skipped: z.enum(['invisible', 'no_location_view']).nullable().default(null).catch(null),
  server_now: z.number(),
});

export const PermissionSetResponseSchema = z.object({
  grantee_id: uid,
  scopes: scopeList(accessScope),
  server_now: z.number(),
});

export const InvisibleSetResponseSchema = z.object({
  invisible: z.boolean(),
  restored_receiver_ids: z.array(z.string()).default([]),
  skipped_receiver_ids: z.array(z.string()).default([]),
  server_now: z.number(),
});

export const ConsentAcceptResponseSchema = z.object({
  consent: ProfileConsentSchema,
  server_now: z.number(),
});

export const ConsentWithdrawResponseSchema = z.object({
  consent: z.null().default(null),
  shares_ended: z.number().int().nonnegative().default(0),
  links_ended: z.number().int().nonnegative().default(0),
  server_now: z.number(),
});

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

// --- Konum İste ------------------------------------------------------------------------------

export const LocationRequestSendResponseSchema = z.object({
  request_id: z.string(),
  status: z.enum(['pending', 'already_sharing']),
  expires_at: z.number().nullable(),
  server_now: z.number(),
});

export const LocationRequestRespondResponseSchema = z.object({
  request_id: z.string(),
  status: z.enum(['approved', 'rejected']),
  session_id: z.string().nullable(),
  share: OutgoingShareViewSchema.nullable(),
  server_now: z.number(),
});

export const LocationRequestCancelResponseSchema = z.object({
  request_id: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']),
  server_now: z.number(),
});

/** Firestore `location_requests` belgesi (iki taraf okur). Eski durum adları (accepted/declined) yeniye çevrilir. */
export const LocationRequestDocSchema = z
  .object({
    request_id: z.string(),
    requester_id: z.string(),
    target_id: z.string(),
    status: z.preprocess(
      (v) => (v === 'accepted' ? 'approved' : v === 'declined' ? 'rejected' : v),
      z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']),
    ),
    created_at: z.number(),
    expires_at: z.number(),
    responded_at: z.number().nullable().default(null),
    share_id: z.string().nullable().default(null),
  })
  .loose();
export type LocationRequestDoc = z.output<typeof LocationRequestDocSchema>;
