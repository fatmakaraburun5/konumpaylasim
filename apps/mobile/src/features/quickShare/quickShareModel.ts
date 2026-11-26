/**
 * Faz 6: uygulama içi "1 sa" (tek tuşla 1 saatlik paylaşım) ve widget derin bağlantısı (`konum://quick-share`)
 * için saf karar fonksiyonları. Sunucunun widget çağrısıyla AYNI kural (core `quickShareExpiry`):
 *   - o kişiye aktif paylaşımım yoksa → yeni 60 dk'lık paylaşım (`share_start`, hazır süre h1) → `started`;
 *   - varsa ve 60 dk'dan erken bitiyorsa → aynı kişiye yeni 60 dk'lık oturum (sunucu belgeyi yeni oturumla
 *     değiştirir; aynı oturumdaki diğer alıcılar etkilenmez) → `extended`;
 *   - zaten ≥ 60 dk ya da süresizse → hiçbir şey yapılmaz → `already_active`.
 */
import {
  isExpired,
  QUICK_SHARE_DURATION,
  quickShareExpiry,
  type EpochMs,
  type ErrorCode,
  type OutgoingShareView,
  type QuickShareStatus,
  type SessionId,
  type SharingError,
  type SharingState,
  type UserId,
} from '@konum/core';
import type { StartResult } from '../../state/sharingStore';

/** Bu kişiye şu an aktif (bitmemiş, süresi dolmamış) giden paylaşımım. */
export function activeShareTo(state: Pick<SharingState, 'shares'>, uid: UserId, now: EpochMs): OutgoingShareView | null {
  let best: OutgoingShareView | null = null;
  for (const s of Object.values(state.shares)) {
    if (s.receiver_id !== uid || s.status !== 'active' || isExpired(s, now)) continue;
    if (!best || s.version > best.version || s.started_at > best.started_at) best = s;
  }
  return best;
}

export type QuickShareRunResult =
  | { ok: true; status: QuickShareStatus; expires_at: EpochMs | null; session_id: SessionId | null }
  | { ok: false; error: SharingError };

export interface QuickShareRunDeps {
  state: () => Pick<SharingState, 'shares'>;
  startShare: (receiverIds: readonly UserId[], choice: typeof QUICK_SHARE_DURATION) => Promise<StartResult>;
  /** Oturumun bitişi (callable yanıtından sonra). */
  sessionExpiry: (sessionId: SessionId) => EpochMs | null | undefined;
  now: () => EpochMs;
}

/** Uygulama içi tek tuş paylaşım: karar + gerekiyorsa `share_start`. */
export async function runQuickShare(to: UserId, deps: QuickShareRunDeps): Promise<QuickShareRunResult> {
  const t = deps.now();
  const cur = activeShareTo(deps.state(), to, t);
  const decision = quickShareExpiry(cur, t);
  if (decision.status === 'already_active') {
    return { ok: true, status: 'already_active', expires_at: cur?.expires_at ?? null, session_id: cur?.session_id ?? null };
  }
  const r = await deps.startShare([to], QUICK_SHARE_DURATION);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.skippedReceiverIds.includes(to)) return { ok: false, error: { code: 'not_friends', message: 'Bu kişi artık arkadaş listende değil' } };
  return { ok: true, status: cur ? 'extended' : 'started', expires_at: deps.sessionExpiry(r.sessionId) ?? decision.expires_at, session_id: r.sessionId };
}

// --- Derin bağlantı ekranı -----------------------------------------------------------------------------

export type QuickLinkPlan =
  /** Oturum / arkadaş listesi henüz yüklenmedi. */
  | { kind: 'wait' }
  | { kind: 'signed_out' }
  | { kind: 'not_friend' }
  | { kind: 'ready' };

/** Widget'tan gelen `konum://quick-share?to=…` için ilk karar (izin akışı ve çağrı bundan sonra). */
export function planQuickShareLink(s: {
  authStatus: 'initializing' | 'signedOut' | 'bootstrapping' | 'needsSecondFactor' | 'needsProfile' | 'ready';
  friendsLoaded: boolean;
  isFriend: boolean;
}): QuickLinkPlan {
  if (s.authStatus === 'signedOut') return { kind: 'signed_out' };
  if (s.authStatus !== 'ready' || !s.friendsLoaded) return { kind: 'wait' };
  return s.isFriend ? { kind: 'ready' } : { kind: 'not_friend' };
}

/** Hata → kart metni ve eylem: bağlantı yoksa "Tekrar dene", arkadaş değilse yalnızca "Kapat". */
export function quickShareFailureView(code: ErrorCode | 'permission_denied' | (string & {})): { text: string; retry: boolean } {
  switch (code) {
    case 'permission_denied':
      return { text: 'Konum izni olmadan paylaşım başlatılamaz. İzni açıp tekrar dene.', retry: true };
    case 'unavailable':
      return { text: 'Bağlantı yok. İnternet gelince tekrar dene.', retry: true };
    case 'rate_limited':
      return { text: 'Çok sık denendi. Biraz bekleyip tekrar dene.', retry: true };
    case 'not_friends':
    case 'not_friend':
      return { text: 'Bu kişiyle artık arkadaş değilsiniz.', retry: false };
    // Faz 8
    case 'not_permitted':
      return { text: 'Bu kişiye konum izni vermedin. Arkadaşlar > kişi > İzinler’den açabilirsin.', retry: false };
    case 'invisible_mode':
      return { text: 'Görünmez moddasın. Paylaşmak için önce görünür ol.', retry: false };
    case 'consent_required':
      return { text: 'Devam etmek için güncel sözleşmeyi onaylaman gerekiyor.', retry: false };
    default:
      return { text: 'Paylaşım başlatılamadı. Tekrar dene.', retry: true };
  }
}

export const QUICK_STATUS_TEXT: Record<QuickShareStatus, string> = {
  started: '1 saatlik paylaşım başladı',
  extended: 'Paylaşım 1 saate uzatıldı',
  already_active: 'Konumunu zaten görüyor',
};
