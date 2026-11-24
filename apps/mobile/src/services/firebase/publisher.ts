/**
 * Konum yayıncısı: normalize örnek → core `buildPackets` → `toFanoutUpdate` → RTDB `update(map)`.
 *
 *  - Hedef yoksa HİÇBİR ŞEY yazılmaz (ağ çağrısı da yapılmaz).
 *  - Çok yollu yazma atomiktir: tek bir yol reddedilirse hepsi reddedilir (PERMISSION_DENIED).
 *    Bu durumda paylaşım listesi Firestore'dan (sunucu doğrusu) tazelenir ve artık aktif olmayan
 *    hedefler çıkarılarak BİR KEZ yeniden denenir. Yerelde olmayan hedef asla eklenmez
 *    (kesişim): kullanıcının durdurduğu bir oturum sunucu yanıtı gecikse de geri gelmez.
 *  - Alıcı kopyalarında `receiver_ids` yoktur (core `toDeliveredWrite`); `v` ve `share_id` vardır.
 *  - Kesme anahtarı: `isAllowed` HER yazmadan hemen önce (yeniden deneme dahil) sorulur. Tazeleme
 *    beklenirken kullanıcı "Durdur"a basarsa o paylaşıma paket gitmez (sunucu henüz durdurmamış olsa bile).
 */
import {
  buildPackets,
  isExpired,
  toFanoutUpdate,
  type ActivityState,
  type DeliveredLocationWrite,
  type DeviceStatus,
  type EpochMs,
  type NormalizedSample,
  type PacketExtras,
  type PublishTarget,
  type ShareId,
  type UserId,
} from '@konum/core';
import { isPermissionDenied } from '../../lib/errors';

export interface PublisherDeps {
  write: (map: Record<string, DeliveredLocationWrite>) => Promise<void>;
  /** Sunucudaki güncel aktif hedefler (Firestore'dan, önbelleksiz). */
  refreshTargets: () => Promise<PublishTarget[]>;
  /** Bu paylaşıma ŞU AN yazılabilir mi (kullanıcı durdurmadı mı)? Verilmezse hepsine izin. */
  isAllowed?: (shareId: ShareId) => boolean;
}

export interface PublishInput {
  sample: NormalizedSample;
  device: DeviceStatus;
  senderId: UserId;
  targets: readonly PublishTarget[];
  now: EpochMs;
  activity?: ActivityState;
  /** Faz 3: `hb` (gönderenin o anki kalp atışı) vb. isteğe bağlı paket alanları. */
  extras?: PacketExtras;
}

export type PublishResult =
  /** `blocked`: yazılacak hedefler kullanıcı tarafından durduruldu (kesme anahtarı). */
  | { status: 'skipped'; reason: 'no_targets' | 'blocked'; dropped: ShareId[] }
  | { status: 'published'; targets: PublishTarget[]; paths: string[]; retried: boolean; dropped: ShareId[] }
  /** Tazeleme sonrası yazılacak hedef kalmadı: takip kapatılmalı. */
  | { status: 'no_active_targets'; dropped: ShareId[] }
  | { status: 'failed'; error: unknown; targets: PublishTarget[]; dropped: ShareId[] };

function buildMap(input: PublishInput, targets: readonly PublishTarget[]) {
  const packets = buildPackets(input.sample, input.device, input.senderId, targets, input.now, input.activity, input.extras);
  return toFanoutUpdate(packets);
}

export async function publishSample(input: PublishInput, deps: PublisherDeps): Promise<PublishResult> {
  const allowed = (t: PublishTarget) => deps.isAllowed?.(t.share_id) ?? true;
  const unexpired = input.targets.filter((t) => !isExpired(t, input.now));
  const live = unexpired.filter(allowed);
  const map = buildMap(input, live);
  const paths = Object.keys(map);
  if (paths.length === 0) return { status: 'skipped', reason: unexpired.length > live.length ? 'blocked' : 'no_targets', dropped: [] };

  try {
    await deps.write(map);
    return { status: 'published', targets: [...live], paths, retried: false, dropped: [] };
  } catch (e) {
    if (!isPermissionDenied(e)) return { status: 'failed', error: e, targets: [...live], dropped: [] };
  }

  // PERMISSION_DENIED: sunucu doğrusunu al, reddedilen (artık aktif olmayan) hedefleri çıkar, bir kez dene.
  let fresh: PublishTarget[];
  try {
    fresh = await deps.refreshTargets();
  } catch (e) {
    return { status: 'failed', error: e, targets: [...live], dropped: [] };
  }
  const freshById = new Map(fresh.map((t) => [t.share_id, t] as const));
  const kept: PublishTarget[] = [];
  const dropped: ShareId[] = [];
  for (const t of live) {
    const f = freshById.get(t.share_id);
    if (f && !isExpired(f, input.now)) kept.push(f);
    else dropped.push(t.share_id);
  }
  if (kept.length === 0) return { status: 'no_active_targets', dropped };

  // Tazeleme beklenirken "Durdur"a basıldıysa: yeniden denemeye girmeden kesme anahtarına tekrar bak.
  const keptAllowed = kept.filter(allowed);
  if (keptAllowed.length === 0) return { status: 'skipped', reason: 'blocked', dropped };
  const retryMap = buildMap(input, keptAllowed);
  const retryPaths = Object.keys(retryMap);
  if (retryPaths.length === 0) return { status: 'no_active_targets', dropped };
  try {
    await deps.write(retryMap);
    return { status: 'published', targets: keptAllowed, paths: retryPaths, retried: true, dropped };
  } catch (e) {
    // [Varsayım] İkinci ret: büyük olasılıkla `share_acl` aynası henüz yazılmadı; bir sonraki örnekte yeniden denenir.
    return { status: 'failed', error: e, targets: keptAllowed, dropped };
  }
}
