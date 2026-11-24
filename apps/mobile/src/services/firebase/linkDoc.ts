/**
 * `link_shares/{link_id}` belgesi → bağlantı görünümü (saf; native ve web demo ortak).
 * Belgede `sender_id`, `audience`, `ended_at` gibi ek alanlar da olabilir; yalnızca core
 * `LinkShareView` alanları ve `ended_at` okunur. Zaman damgası savunma amaçlı epoch ms'e çevrilir.
 */
import { LINK_HASH_RE, MINUTE, SHARE_MODES, type EpochMs, type LinkEndReason, type LinkShareView, type ShareMode } from '@konum/core';
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

const LINK_END_REASONS = ['stopped_by_sender', 'expired', 'account_deleted'] as const satisfies readonly LinkEndReason[];

export interface LinkDoc extends LinkShareView {
  ended_at: EpochMs | null;
}

export const LinkDocSchema: z.ZodType<LinkDoc> = z.object({
  link_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  session_id: z.string().min(1).max(64),
  token_hash: z.string().regex(LINK_HASH_RE),
  status: z.enum(['active', 'ended']),
  share_mode: z.enum(SHARE_MODES as [ShareMode, ...ShareMode[]]),
  started_at: epochMs,
  expires_at: epochMsOrNull,
  ended_at: epochMsOrNull,
  end_reason: z.enum(LINK_END_REASONS).nullable().catch(null),
  version: z.number().int().nonnegative(),
  extended_count: z.number().int().nonnegative().catch(0),
});

export const toLinkView = (d: LinkShareView): LinkShareView => ({
  link_id: d.link_id,
  session_id: d.session_id,
  token_hash: d.token_hash,
  status: d.status,
  share_mode: d.share_mode,
  started_at: d.started_at,
  expires_at: d.expires_at,
  end_reason: d.end_reason,
  version: d.version,
  extended_count: d.extended_count,
});

/** [Varsayım] Faz 1 ile aynı: biten bağlantı kartı 10 dk görünür (mezar taşı Firestore'da daha uzun kalır). */
const RECENT_END_MS = 10 * MINUTE;

export function recentLinks(docs: readonly LinkDoc[], now: EpochMs): LinkDoc[] {
  return docs.filter((d) =>
    d.status === 'active'
      ? d.expires_at === null || d.expires_at > now - RECENT_END_MS
      : (d.ended_at ?? d.expires_at ?? 0) > now - RECENT_END_MS,
  );
}
