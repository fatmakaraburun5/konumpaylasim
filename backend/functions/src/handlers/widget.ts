/**
 * Faz 6: ana ekran / kilit ekranı widget'ı ve Android hızlı ayar kutucuğundan TEK TUŞLA 1 saatlik paylaşım —
 * `widget_token_issue`, `widget_token_revoke`, `widget_quick_share` — ve widget yenileme uyandırması.
 *
 * Kimlik modeli (core `quickShare.ts`):
 *  - Widget uzantısı (iOS) / AppWidget alıcısı (Android) Firebase Auth oturumuna ve App Check'e erişemez. Uygulama
 *    oturum açıkken `widget_token_issue` (oturum + App Check) ile CİHAZA ÖZEL token alır: 32 bayt, base64url 43
 *    karakter. Sunucu yalnızca `widget_tokens/{sha256Hex(token)}` saklar; düz token yalnızca o yanıtta döner ve
 *    `ops` kaydına / loglara YAZILMAZ. Bu yüzden `widget_token_issue` `runOp` kullanmaz: her çağrı (aynı `op_id`
 *    ile tekrar dahil) aynı cihazın önceki token'larını iptal edip YENİ token verir (yanıtı kaybolan tekrarda eski
 *    token'ı kimse görmemiştir; Faz 2 bağlantı token yenilemesiyle aynı mantık). Günlük üretim sınırı vardır.
 *  - `widget_token_revoke` (oturum): `device_id` ya da `null` = tümü (çıkış). Hesap silme token'ları siler.
 *  - `widget_quick_share` (oturum / App Check YOK; yetki = token): token yalnızca sahibinin FAVORİLERİNE 1 saatlik
 *    paylaşım başlatabilir / uzatabilir. Kontrol sırası: token yok / iptal → `token_invalid`; süresi dolmuş →
 *    `token_expired`; profil yok / hesap siliniyor → `token_invalid`; hedef favori değil → `not_favorite`; kabul
 *    edilmiş + engelsiz arkadaş değil → `not_friend`; token başına saatte `perTokenPerHour` başarılı çağrı →
 *    `rate_limited` (`retry_after_ms`). Karar core `quickShareExpiry`: aktif paylaşım varsa bitiş = max(mevcut,
 *    şimdi + 60 dk) → `extended` / `already_active`; yoksa `share_start` ile AYNI iç fonksiyon
 *    (`writeShareStarts`) → `started`. `op_id` token sahibi başına tekilleştirilir (`runOp`; istek özeti token
 *    özetini içerir, düz token'ı değil).
 *  - Başarıdan sonra (en iyi çaba): gönderenin cihazlarına Faz 3 sessiz `resume_tracking` (uygulama arka planda
 *    takibi başlatsın) ve görünür `quick_share_started` ("Ayşe ile 1 saatlik paylaşım başladı"; koordinat YOK).
 *    Alıcının widget'ı `share_acl_reconciler` tetikleyicisindeki `notifyWidgetRefresh` ile yenilenir.
 *  - Faz 8 (core `canShareLocation`): oturumsuz çağrı olduğu için callable ön kapısı yoktur; denetimler burada,
 *    transaction içinde: profil → güncel onay (`consent_required`) → görünmez değil (`invisible_mode`; görünmez
 *    kullanıcıya ASLA `resume_tracking` gitmez) → favori → arkadaş → `location_view` izni (`not_permitted`). Uzatma
 *    ve "zaten aktif" dalları da aynı denetimden geçer; hızlı paylaşım izin YAZMAZ.
 */
import {
  CALLABLES,
  DAY,
  HOUR,
  QUICK_SHARE_LIMITS,
  WIDGET_QUICK_SHARE_ENDPOINT,
  type EpochMs,
  type UserId,
  type WidgetQuickShareRequestSchema,
  type WidgetQuickShareResponse,
  type WidgetTokenIssueRequestSchema,
  type WidgetTokenIssueResponse,
  type WidgetTokenRevokeRequestSchema,
  type WidgetTokenRevokeResponse,
  canShareLocation,
  consentRequired,
  generateWidgetToken,
  isInvisible,
  quickShareExpiry,
  shareId,
  widgetTokenHash,
} from '@konum/core';
import { type DocumentReference, Timestamp, type Transaction } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import type { z } from 'zod';
import { readAclVersions } from '../acl';
import { db } from '../admin';
import type { CallCtx } from '../callable';
import { COL, type ShareDoc, type UserDoc, type WidgetTokenDoc, favoriteIdsOf, isUsableProfile, refs } from '../docs';
import { fail } from '../errors';
import { callerAccess, consentFail, isFriend, pairInput, readCaller } from '../graph';
import { readRateLimit, runOp, writeRateLimit } from '../ops';
import { type PushSender, buildQuickShareStartedPush, buildResumeTrackingPush, buildWidgetRefreshPush, sendPushToUser } from '../push';
import { chunk, isServerUid, nodeRandom } from '../util';
import { readStartCandidates, writeShareStarts } from './shares';

/** Ürün sınırları. [Varsayım] */
export const WIDGET_TOKEN_LIMITS = {
  /** Kullanıcı başına günde en çok token üretimi (yenileme + yeniden kurulum). */
  issuePerDay: 20,
  /** Kullanıcı başına aynı anda en çok aktif token (cihaz); fazlası en eskiden iptal edilir. */
  maxActivePerUser: 5,
  /** İptal edilen / süresi dolan token belgesi bu kadar sonra TTL ile silinir. */
  purgeAfterMs: DAY,
} as const;

const ISSUE_RATE_KEY = 'widget_token';

export interface WidgetDeps {
  /** Testler sahte gönderici verir; varsayılan FCM. */
  send?: PushSender;
}

function revokeFields(now: EpochMs) {
  return { revoked: true, revoked_at: now, purge_at: Timestamp.fromMillis(now + WIDGET_TOKEN_LIMITS.purgeAfterMs) };
}

const isLive = (t: WidgetTokenDoc, now: EpochMs) => !t.revoked && t.expires_at > now;

// ---------------------------------------------------------------------------
// widget_token_issue (oturum + App Check)
// ---------------------------------------------------------------------------

export async function widgetTokenIssue(
  ctx: CallCtx,
  data: z.output<typeof WidgetTokenIssueRequestSchema>,
): Promise<WidgetTokenIssueResponse> {
  const token = generateWidgetToken(nodeRandom);
  const hash = widgetTokenHash(token);
  const expiresAt = ctx.now + QUICK_SHARE_LIMITS.tokenTtlMs;
  await db().runTransaction(async (tx) => {
    await readCaller(tx, ctx.uid);
    const rl = await readRateLimit(tx, ctx.uid, ISSUE_RATE_KEY, WIDGET_TOKEN_LIMITS.issuePerDay, DAY, ctx.now);
    const mine = await tx.get(db().collection(COL.widgetTokens).where('uid', '==', ctx.uid));
    const live = mine.docs
      .map((d) => ({ ref: d.ref, t: d.data() as WidgetTokenDoc }))
      .filter((x) => x.t.uid === ctx.uid && isLive(x.t, ctx.now));
    // Aynı cihazın eski token'ları + sınırı aşan en eski diğer cihazlar iptal.
    const same = live.filter((x) => x.t.device_id === data.device_id);
    const others = live.filter((x) => x.t.device_id !== data.device_id).sort((a, b) => b.t.created_at - a.t.created_at);
    const overflow = others.slice(Math.max(0, WIDGET_TOKEN_LIMITS.maxActivePerUser - 1));

    for (const x of [...same, ...overflow]) tx.update(x.ref, revokeFields(ctx.now));
    const doc: WidgetTokenDoc = {
      uid: ctx.uid,
      device_id: data.device_id,
      created_at: ctx.now,
      expires_at: expiresAt,
      last_used_at: null,
      uses: { window_start: ctx.now, count: 0 },
      revoked: false,
      revoked_at: null,
      purge_at: Timestamp.fromMillis(expiresAt + WIDGET_TOKEN_LIMITS.purgeAfterMs),
    };
    tx.create(refs.widgetToken(hash), doc);
    writeRateLimit(tx, rl, DAY);
  });
  return { token, expires_at: expiresAt, endpoint_path: WIDGET_QUICK_SHARE_ENDPOINT };
}

// ---------------------------------------------------------------------------
// widget_token_revoke (oturum)
// ---------------------------------------------------------------------------

export async function widgetTokenRevoke(
  ctx: CallCtx,
  data: z.output<typeof WidgetTokenRevokeRequestSchema>,
): Promise<WidgetTokenRevokeResponse> {
  return runOp(ctx, data.op_id, CALLABLES.widgetTokenRevoke, data, async (tx) => {
    const mine = await tx.get(db().collection(COL.widgetTokens).where('uid', '==', ctx.uid));
    const targets = mine.docs.filter((d) => {
      const t = d.data() as WidgetTokenDoc;
      return t.uid === ctx.uid && !t.revoked && (data.device_id === null || t.device_id === data.device_id);
    });
    for (const d of targets) tx.update(d.ref, revokeFields(ctx.now));
    return { response: { revoked: targets.length } };
  });
}

/** Hesap silme: kullanıcının tüm widget token belgeleri silinir (iptal kaydı da kalmaz). */
export async function deleteWidgetTokensOf(uid: UserId): Promise<number> {
  const snap = await db().collection(COL.widgetTokens).where('uid', '==', uid).get();
  for (const part of chunk(snap.docs, 400)) {
    const batch = db().batch();
    for (const d of part) batch.delete(d.ref);
    await batch.commit();
  }
  return snap.size;
}

// ---------------------------------------------------------------------------
// widget_quick_share (oturumsuz; yetki = token)
// ---------------------------------------------------------------------------

interface TokenCheck {
  ref: DocumentReference;
  doc: WidgetTokenDoc;
}

function checkToken(t: WidgetTokenDoc | undefined, now: EpochMs): WidgetTokenDoc {
  if (!t || t.revoked || !isServerUid(t.uid)) throw fail('token_invalid');
  if (t.expires_at <= now) throw fail('token_expired');
  return t;
}

/** Token başına saatlik sabit pencere (belgenin `uses` alanı). */
function usesWindow(t: WidgetTokenDoc, now: EpochMs): { window_start: EpochMs; count: number } {
  const w = t.uses;
  const inWindow = w && typeof w.window_start === 'number' && now - w.window_start < HOUR;
  return inWindow ? { window_start: w.window_start, count: w.count ?? 0 } : { window_start: now, count: 0 };
}

export async function widgetQuickShare(
  data: z.output<typeof WidgetQuickShareRequestSchema>,
  opts: WidgetDeps & { now?: EpochMs } = {},
): Promise<WidgetQuickShareResponse> {
  const now = opts.now ?? Date.now();
  const send = opts.send ?? sendPushToUser;
  const hash = widgetTokenHash(data.token);

  // Ön okuma: token sahibi `runOp` anahtarı için gerekir (transaction içinde yeniden doğrulanır).
  const pre = checkToken((await refs.widgetToken(hash).get()).data() as WidgetTokenDoc | undefined, now);
  const owner = pre.uid;
  const to = data.to_uid;
  if (!isServerUid(to) || to === owner) throw fail('not_favorite');
  const ctx: CallCtx = { uid: owner, phone_e164: null, now };
  const aclVersions = await readAclVersions([shareId(owner, to)]);

  const response = await runOp(
    ctx,
    data.op_id,
    CALLABLES.widgetQuickShare,
    { to_uid: to, source: data.source, token_hash: hash },
    async (tx: Transaction) => {
      const tokSnap = await tx.get(refs.widgetToken(hash));
      const tok: TokenCheck = { ref: tokSnap.ref, doc: checkToken(tokSnap.data() as WidgetTokenDoc | undefined, now) };
      if (tok.doc.uid !== owner) throw fail('token_invalid');
      const userSnap = await tx.get(refs.user(owner));
      const user = userSnap.data() as UserDoc | undefined;
      if (!isUsableProfile(user)) throw fail('token_invalid');
      if (consentRequired(user.consent)) throw consentFail();
      if (isInvisible(user)) throw fail('invisible_mode');
      if (!favoriteIdsOf(user).includes(to)) throw fail('not_favorite');
      const [cand] = await readStartCandidates(tx, owner, [to]);
      if (!cand || !isFriend(cand.pair)) throw fail('not_friend');
      if (!canShareLocation(pairInput(cand.pair, callerAccess(user)))) throw fail('not_permitted');
      const uses = usesWindow(tok.doc, now);
      if (uses.count >= QUICK_SHARE_LIMITS.perTokenPerHour) {
        throw fail('rate_limited', { extra: { retry_after_ms: uses.window_start + HOUR - now } });
      }
      const toName = cand.pair.friendship?.member_profiles?.[to]?.display_name ?? '';
      const decision = quickShareExpiry(cand.existing, now);

      // --- yazmalar ---
      tx.update(tok.ref, { last_used_at: now, uses: { window_start: uses.window_start, count: uses.count + 1 } });
      let share: ShareDoc;
      let effects: ShareDoc[] = [];
      if (decision.status === 'started') {
        const w = writeShareStarts(tx, user, [cand], { share_mode: decision.share_mode, expires_at: decision.expires_at }, now, aclVersions);
        const started = w.started[0];
        if (!started) throw fail('not_friend');
        share = started;
        effects = [started];
      } else if (decision.status === 'extended') {
        const cur = cand.existing as ShareDoc;
        share = {
          ...cur,
          share_mode: decision.share_mode,
          expires_at: decision.expires_at,
          version: cur.version + 1,
          extended_count: (cur.extended_count ?? 0) + 1,
          updated_at: now,
        };
        tx.update(refs.shareById(share.share_id), {
          share_mode: share.share_mode,
          expires_at: share.expires_at,
          version: share.version,
          extended_count: share.extended_count,
          updated_at: share.updated_at,
        });
        effects = [share];
      } else {
        share = cand.existing as ShareDoc;
      }
      const res: WidgetQuickShareResponse = {
        status: decision.status,
        share_id: share.share_id,
        expires_at: share.expires_at,
        to_name: toName.slice(0, 80),
      };
      const plan = { to_name: res.to_name, response: res, session_id: share.session_id };
      return { response: res, shareEffects: effects, after: () => afterQuickShare(owner, plan, send, now) };
    },
  );
  logger.info('widget hızlı paylaşım', { status: response.status, source: data.source });
  return { ...response };
}

/** Gönderenin cihazlarına sessiz uyandırma + görünür onay (en iyi çaba; `runOp` yalnızca ilk çalıştırmada çağırır). */
async function afterQuickShare(
  owner: UserId,
  plan: { to_name: string; response: WidgetQuickShareResponse; session_id: string },
  send: PushSender,
  now: EpochMs,
): Promise<void> {
  const res = await Promise.allSettled([
    send(owner, buildResumeTrackingPush([plan.session_id], 1, now)),
    send(owner, buildQuickShareStartedPush(plan.to_name, plan.response, now)),
  ]);
  const failed = res.filter((r) => r.status === 'rejected').length;
  if (failed) logger.warn('widget hızlı paylaşım: gönderene bildirim gönderilemedi', { failed });
}

// ---------------------------------------------------------------------------
// widget_refresh: favorim bana paylaşımı başlattı / durdurdu / bitti
// ---------------------------------------------------------------------------

type ShareLike = Pick<ShareDoc, 'sender_id' | 'receiver_id' | 'status'> & Partial<Pick<ShareDoc, 'audience'>>;

/**
 * Saf karar: paylaşımın AKTİFLİĞİ değiştiyse (başladı / bitti, neden ne olursa olsun) alıcının widget'ı yenilenmeli.
 * Uzatma, duraksama kaydı gibi yazmalar alıcının widget'ında görünen durumu değiştirmez → null.
 */
export function widgetRefreshFor(before: ShareLike | null | undefined, after: ShareLike | null | undefined): { receiver: UserId; from: UserId } | null {
  const was = before?.status === 'active';
  const is = after?.status === 'active';
  if (was === is) return null;
  const s = after ?? before;
  if (!s || (s.audience !== undefined && s.audience !== 'friend')) return null;
  if (!isServerUid(s.receiver_id) || !isServerUid(s.sender_id)) return null;
  return { receiver: s.receiver_id, from: s.sender_id };
}

/**
 * Alıcı paylaşanı favorilerinde tutuyorsa (ve hesabı silinmiyorsa) yalnızca veri `widget_refresh` gönderir.
 * Hata fırlatmaz (tetikleyici yeniden denemesi ACL uzlaştırması içindir).
 */
export async function notifyWidgetRefresh(
  before: ShareLike | null | undefined,
  after: ShareLike | null | undefined,
  deps: WidgetDeps & { now?: EpochMs } = {},
): Promise<boolean> {
  const t = widgetRefreshFor(before, after);
  if (!t) return false;
  try {
    const u = (await refs.user(t.receiver).get()).data() as UserDoc | undefined;
    if (!isUsableProfile(u) || !favoriteIdsOf(u).includes(t.from)) return false;
    await (deps.send ?? sendPushToUser)(t.receiver, buildWidgetRefreshPush(t.from, deps.now ?? Date.now()));
    return true;
  } catch (err) {
    logger.warn('widget yenileme bildirimi gönderilemedi', { err: String(err) });
    return false;
  }
}
