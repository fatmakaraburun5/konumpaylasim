/**
 * Faz 6: widget'la ilgili push'ların arka plan (başsız) işlenmesi — push.ts `setBackgroundMessageHandler` çağırır.
 *
 * Widget'tan / kilit ekranından başlatılan 1 saatlik paylaşım sunucuda oluşur (`widget_quick_share`); uygulama o
 * sırada kapalıdır ve kalıcı yayın hedeflerinde bu paylaşım YOKTUR. Sunucu ardından gönderenin cihazlarına
 *   - sessiz `resume_tracking` (session_ids = yeni paylaşımın oturumu) ve
 *   - görünür `quick_share_started` (share_id, to_name, expires_at; koordinat yok)
 * gönderir. Faz 3 `resumeTracking` kalıcı hedef yoksa hiçbir şey yapmaz; bu yüzden önce burada:
 *   1. Push'taki oturum / paylaşım kalıcı hedeflerde varsa → bir şey yapılmaz (resumeTracking devam eder).
 *   2. Uygulama oturumu canlıysa (dinleyiciler + widgetSync çalışıyor) → koordinatör hedefleri kendisi yazar.
 *   3. Aksi hâlde (başsız): Firebase oturumu geri yüklenir, gönderdiğim paylaşımlar SUNUCUDAN okunur
 *      (`fetchOutgoingShares`, önbellek değil), yalnızca push'ta adı geçen, aktif, süresi dolmamış ve bu cihazda
 *      durdurma niyeti olmayan paylaşımlar kalıcı hedeflere eklenir. Takibi `resumeTracking` başlatır.
 * Kullanıcının durdurduğu paylaşıma asla geri dönülmez (`isShareBlocked`). Android'de görünür bildirim yükü
 * (`quick_share_started`) arka planda JS'e ulaşmayabilir; güvenilir tetik `resume_tracking`'dir.
 * [Varsayım: cihazda doğrulanmalı] iOS sessiz push'u sistem kısıtlayabilir; uygulama açılınca dinleyici yakalar.
 *
 * `widget_refresh`: oturum canlıysa kısıtlamayı aşan bir eşitleme; başsızsa yalnızca widget yeniden çizilir
 * (depolar boşken snapshot YAZILMAZ: favoriler silinmiş gibi görünmesin).
 *
 * Faz 8: yayın kesme anahtarı (görünmez mod / onay kapısı) açıksa hiçbir paylaşım benimsenmez.
 */
import { isExpired, type SessionId, type ShareId, type UserId } from '@konum/core';
import type { ShareDoc } from '../../lib/schemas';
import { authStore } from '../../state/authStore';
import { loadTargets, updateTargets, type PersistedTarget } from '../../state/persist';
import { hydratePublishHold, isPublishHeld } from '../../state/publishHold';
import { hydrateStopIntents, isShareBlocked } from '../../state/stopIntents';
import { fetchOutgoingShares } from '../firebase/sharesRepo';
import { probeFirebaseAuth } from '../location/pipeline';
import { resumeTracking } from '../location/resume';
import { parseF6Data } from '../notifications/f6Push';
import { reload as reloadWidgets } from './widgetBridge';
import { requestWidgetSync, widgetSync } from './widgetSync';

export interface AdoptWanted {
  sessionIds: readonly SessionId[];
  shareIds: readonly ShareId[];
}

/** Saf: sunucudaki gönderdiğim paylaşımlardan kalıcı hedeflere eklenecekler. */
export function selectAdoptableShares(
  docs: readonly ShareDoc[],
  opts: { uid: UserId; wanted: AdoptWanted; have: ReadonlySet<ShareId>; blocked: (id: ShareId) => boolean; now: number },
): PersistedTarget[] {
  const sessions = new Set(opts.wanted.sessionIds);
  const shares = new Set(opts.wanted.shareIds);
  const out: PersistedTarget[] = [];
  for (const d of docs) {
    if (d.sender_id !== opts.uid || d.receiver_id === opts.uid) continue;
    if (!sessions.has(d.session_id) && !shares.has(d.share_id)) continue;
    if (d.status !== 'active' || isExpired(d, opts.now)) continue;
    if (opts.have.has(d.share_id) || opts.blocked(d.share_id)) continue;
    out.push({
      share_id: d.share_id,
      receiver_id: d.receiver_id,
      share_mode: d.share_mode,
      expires_at: d.expires_at,
      session_id: d.session_id,
      started_at: d.started_at,
      version: d.version,
    });
  }
  return out;
}

/** Saf: push verisi → aranan oturum / paylaşım kimlikleri (Faz 3 `resume_tracking` ya da `quick_share_started`). */
export function wantedFromPush(data: Record<string, unknown> | null | undefined): AdoptWanted | null {
  if (!data) return null;
  if (data.type === 'resume_tracking') {
    const ids = typeof data.session_ids === 'string' ? data.session_ids.split(',').filter((s) => /^[A-Za-z0-9_-]{1,128}$/.test(s)) : [];
    return ids.length ? { sessionIds: ids.slice(0, 20), shareIds: [] } : null;
  }
  const ev = parseF6Data(data);
  return ev?.type === 'quick_share_started' ? { sessionIds: [], shareIds: [ev.share_id] } : null;
}

const sessionLive = (): boolean => authStore.getState().status === 'ready' && widgetSync.isRunning();

/**
 * Push'taki paylaşım kalıcı hedeflerde yoksa sunucudan alıp ekler. Dönen: 'adopted' ise çağıran `resumeTracking`
 * çalıştırmalıdır (takip + tek ölçüm + kuyruk).
 */
export async function adoptSharesFromPush(wanted: AdoptWanted): Promise<'none' | 'live' | 'adopted'> {
  if (wanted.sessionIds.length === 0 && wanted.shareIds.length === 0) return 'none';
  if (sessionLive()) return 'live';
  await hydratePublishHold();
  if (isPublishHeld()) return 'none';
  const persisted = await loadTargets();
  const haveShares = new Set(persisted.targets.map((t) => t.share_id));
  const haveSessions = new Set(persisted.targets.map((t) => t.session_id).filter((s): s is string => !!s));
  if (wanted.shareIds.every((id) => haveShares.has(id)) && wanted.sessionIds.every((id) => haveSessions.has(id))) return 'none';
  const probe = await probeFirebaseAuth();
  if (probe.kind !== 'signed_in') return 'none';
  const uid = probe.uid;
  if (persisted.uid !== null && persisted.uid !== uid) return 'none';
  await hydrateStopIntents();
  const docs = await fetchOutgoingShares(uid);
  const now = Date.now() + persisted.serverOffsetMs;
  const add = selectAdoptableShares(docs, { uid, wanted, have: haveShares, blocked: isShareBlocked, now });
  if (add.length === 0) return 'none';
  let added = false;
  await updateTargets((latest) => {
    if (latest.uid !== null && latest.uid !== uid) return null;
    if (isPublishHeld()) return null;
    const have = new Set(latest.targets.map((t) => t.share_id));
    const fresh = add.filter((t) => !have.has(t.share_id) && !isShareBlocked(t.share_id));
    if (fresh.length === 0) return null;
    added = true;
    return { ...latest, uid, targets: [...latest.targets, ...fresh], notificationBody: latest.notificationBody || '1 saatlik hızlı paylaşım' };
  });
  return added ? 'adopted' : 'none';
}

/**
 * Arka plan işleyicisi (push.ts). `resume_tracking` için çağıran ayrıca `resumeTracking('push')` çalıştırır; burada
 * yalnızca eksik hedef eklenir. `quick_share_started` / `widget_refresh` burada tamamlanır.
 */
export async function handleWidgetBackgroundPush(data: Record<string, unknown> | null | undefined): Promise<void> {
  const wanted = wantedFromPush(data);
  if (wanted) {
    const r = await adoptSharesFromPush(wanted).catch(() => 'none' as const);
    if (data?.type === 'quick_share_started') {
      if (r === 'adopted') await resumeTracking('push').catch(() => undefined);
      refreshWidgets();
    }
    return;
  }
  const ev = parseF6Data(data);
  if (ev?.type === 'widget_refresh') refreshWidgets();
}

function refreshWidgets(): void {
  if (sessionLive()) requestWidgetSync('push');
  else reloadWidgets('all');
}
