/**
 * core `contracts.ts` içinde şeması OLMAYAN callable'lar için yerel şemalar ve yanıt tipleri.
 * Aynı kurallar: alanlar yalnızca eklenir, her komut `op_id` (UUID v4) taşır.
 * Bunların core'a taşınması `core_requests` olarak raporlandı.
 */
import type { EpochMs, OutgoingShareView, RequestId, SessionId, ShareId, UserProfile } from '@konum/core';
import { z } from 'zod';
import { SERVER_UID_RE } from './util';

const opId = z.uuid();
/** Sunucu uid biçimi: core'unkinden dar (`_` yok, bkz. util.ts). */
const uid = z.string().regex(SERVER_UID_RE);
const docId = z.string().min(1).max(300);

/** [Varsayım] görünen ad 1–40 karakter. */
const displayName = z.string().trim().min(1).max(40);

export const UserBootstrapSchema = z.object({
  /** Bootstrap doğası gereği idempotenttir; op_id isteğe bağlıdır. */
  op_id: opId.optional(),
  display_name: displayName.optional(),
  /**
   * Yalnızca projenin Storage kovasındaki `avatars/{uid}/...` nesnesi (sunucuda ayrıca doğrulanır, bkz. user.ts).
   * Serbest https adresi kabul edilmez: arkadaşın uygulaması resmi yüklerken üçüncü bir sunucuya IP sızardı.
   */
  avatar_url: z.url({ protocol: /^https$/ }).max(2048).nullable().optional(),
});

export const InviteCodeRegenerateSchema = z.object({ op_id: opId });

/**
 * İptal iki yoldan: `outgoing_id` (giden istek listesinden; hedef bilinmeden) ya da `friendship_id`.
 * İkisinde de kayıt yok / üye değilsin / zaten iptal → AYNI yanıt (sosyal grafik kâhini yok).
 */
export const FriendRequestCancelSchema = z.union([
  z.object({ op_id: opId, outgoing_id: z.string().regex(/^[0-9a-f]{32}$/) }),
  z.object({ op_id: opId, friendship_id: docId }),
]);

export const FriendshipRemoveSchema = z.object({ op_id: opId, friendship_id: docId });

export const UserBlockSchema = z.object({ op_id: opId, user_id: uid });

export const UserUnblockSchema = z.object({ op_id: opId, user_id: uid });

/** Yanlışlıkla silmeye karşı açık onay. */
export const AccountDeleteSchema = z.object({ op_id: opId, confirm: z.literal(true) });

// --- yanıtlar ----------------------------------------------------------------

export interface UserBootstrapResponse {
  user: UserProfile;
  created: boolean;
  server_now: EpochMs;
}

export interface InviteCodeRegenerateResponse {
  invite_code: string;
  server_now: EpochMs;
}

export interface FriendRequestRespondResponse {
  friendship_id: string;
  status: 'accepted' | 'declined';
  server_now: EpochMs;
}

export interface FriendRequestCancelResponse {
  /** İstekte verilen kimlik (friendship_id ya da outgoing_id) aynen döner. */
  friendship_id?: string;
  outgoing_id?: string;
  status: 'cancelled';
  server_now: EpochMs;
}

export interface FriendshipRemoveResponse {
  friendship_id: string;
  status: 'removed';
  server_now: EpochMs;
}

/** Hedef var olsun olmasın aynı yanıt. */
export interface UserBlockResponse {
  status: 'blocked';
  server_now: EpochMs;
}

export interface UserUnblockResponse {
  status: 'unblocked';
  server_now: EpochMs;
}

/** share_revoke: paylaşım zaten bitmiş olsa da aynı yanıt (idempotent). */
export interface ShareRevokeResponse {
  share_id: ShareId;
  status: 'ended';
  server_now: EpochMs;
}

export interface LocationRequestSendResponse {
  request_id: RequestId;
  status: 'pending';
  expires_at: EpochMs;
  server_now: EpochMs;
}

export interface LocationRequestRespondResponse {
  request_id: RequestId;
  status: 'accepted' | 'declined';
  session_id: SessionId | null;
  share: OutgoingShareView | null;
  server_now: EpochMs;
}

export interface AccountDeleteResponse {
  status: 'deleted';
  server_now: EpochMs;
}

// ---------------------------------------------------------------------------
// Faz 3: `battery_low_notify` şeması ve yanıtı core `contracts.ts`'e taşındı (tek kaynak); geriye dönük adlar.
// ---------------------------------------------------------------------------

export {
  BatteryLowNotifyRequestSchema as BatteryLowNotifySchema,
  type BatteryLowNotifyResponse,
} from '@konum/core';
