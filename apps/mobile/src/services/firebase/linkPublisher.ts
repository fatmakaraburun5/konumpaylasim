/**
 * Bağlantı (QR) yayıncısı: normalize örnek → core `toLinkLiveUpdate` → RTDB `update(map)` (`link_live/{token_hash}`).
 * Faz 1 `publisher.ts` ile aynı kurallar; arkadaş fan-out'undan AYRI çağrıda yazılır (çok yollu yazma
 * atomiktir: biten bir bağlantının reddi arkadaşlara giden konumu düşürmesin).
 *
 *  - Hedef yoksa HİÇBİR ŞEY yazılmaz.
 *  - PERMISSION_DENIED (bağlantı durduruldu / süresi doldu / ACL yok): Firestore'dan tazelenir, artık aktif
 *    olmayan bağlantılar çıkarılıp BİR KEZ yeniden denenir. Yerelde olmayan hedef asla eklenmez (kesişim).
 *  - Kesme anahtarı `isAllowed` her yazmadan hemen önce (yeniden deneme dahil) sorulur.
 *  - Pakette yalnızca core `LINK_LIVE_FIELDS` vardır: sender_id, telefon, alıcı listesi YOK.
 */
import {
  isExpired,
  toLinkLiveUpdate,
  type DeviceStatus,
  type EpochMs,
  type LinkId,
  type LinkLiveLocationWrite,
  type LinkPublishTarget,
  type NormalizedSample,
  type PacketExtras,
} from '@konum/core';
import { isPermissionDenied } from '../../lib/errors';

export interface LinkPublisherDeps {
  write: (map: Record<string, LinkLiveLocationWrite>) => Promise<void>;
  /** Sunucudaki güncel aktif bağlantılar (Firestore'dan, önbelleksiz). `sender_name` yerelden korunur. */
  refreshTargets: () => Promise<Pick<LinkPublishTarget, 'link_id' | 'token_hash' | 'share_mode' | 'expires_at'>[]>;
  /** Bu bağlantıya ŞU AN yazılabilir mi (kullanıcı durdurmadı mı)? */
  isAllowed?: (linkId: LinkId) => boolean;
}

export interface LinkPublishInput {
  sample: NormalizedSample;
  device: DeviceStatus;
  targets: readonly LinkPublishTarget[];
  now: EpochMs;
  /** Faz 3: `hb` (bağlantılarda `recorded_at` yok). */
  extras?: Pick<PacketExtras, 'hb' | 'q'>;
}

export type LinkPublishResult =
  | { status: 'skipped'; reason: 'no_targets' | 'blocked'; dropped: LinkId[] }
  | { status: 'published'; targets: LinkPublishTarget[]; paths: string[]; retried: boolean; dropped: LinkId[] }
  | { status: 'no_active_targets'; dropped: LinkId[] }
  | { status: 'failed'; error: unknown; targets: LinkPublishTarget[]; dropped: LinkId[] };

export async function publishLinkSample(input: LinkPublishInput, deps: LinkPublisherDeps): Promise<LinkPublishResult> {
  const allowed = (t: LinkPublishTarget) => deps.isAllowed?.(t.link_id) ?? true;
  const unexpired = input.targets.filter((t) => !isExpired(t, input.now));
  const live = unexpired.filter(allowed);
  const map = toLinkLiveUpdate(input.sample, input.device, live, input.now, input.extras);
  const paths = Object.keys(map);
  if (paths.length === 0) return { status: 'skipped', reason: unexpired.length > live.length ? 'blocked' : 'no_targets', dropped: [] };

  try {
    await deps.write(map);
    return { status: 'published', targets: [...live], paths, retried: false, dropped: [] };
  } catch (e) {
    if (!isPermissionDenied(e)) return { status: 'failed', error: e, targets: [...live], dropped: [] };
  }

  let fresh: Awaited<ReturnType<LinkPublisherDeps['refreshTargets']>>;
  try {
    fresh = await deps.refreshTargets();
  } catch (e) {
    return { status: 'failed', error: e, targets: [...live], dropped: [] };
  }
  const freshById = new Map(fresh.map((t) => [t.link_id, t] as const));
  const kept: LinkPublishTarget[] = [];
  const dropped: LinkId[] = [];
  for (const t of live) {
    const f = freshById.get(t.link_id);
    if (f && f.token_hash === t.token_hash && !isExpired(f, input.now)) kept.push({ ...t, expires_at: f.expires_at, share_mode: f.share_mode });
    else dropped.push(t.link_id);
  }
  if (kept.length === 0) return { status: 'no_active_targets', dropped };

  const keptAllowed = kept.filter(allowed);
  if (keptAllowed.length === 0) return { status: 'skipped', reason: 'blocked', dropped };
  const retryMap = toLinkLiveUpdate(input.sample, input.device, keptAllowed, input.now, input.extras);
  const retryPaths = Object.keys(retryMap);
  if (retryPaths.length === 0) return { status: 'no_active_targets', dropped };
  try {
    await deps.write(retryMap);
    return { status: 'published', targets: keptAllowed, paths: retryPaths, retried: true, dropped };
  } catch (e) {
    // [Varsayım] İkinci ret: büyük olasılıkla `link_acl` aynası henüz yazılmadı; sonraki örnekte yeniden denenir.
    return { status: 'failed', error: e, targets: keptAllowed, dropped };
  }
}
