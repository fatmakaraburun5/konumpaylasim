/**
 * Faz 3: izin adımı planlayıcısının mobil bağlantısı. Karar core `nextPermissionStep`'tedir; burada yalnızca
 * girdi kurulur (permissionsStore + izin hafızası + paylaşım bağlamı) ve adımın sonucu hafızaya işlenir.
 *
 * Mağaza politikası notları:
 *  - Apple: "Her Zaman" yalnızca "Kullanırken" verildikten SONRA ve ihtiyaç anında (uzun paylaşım / paylaşım
 *    sürerken arka plana gidildi) istenir; önce uygulama içi açıklama. iOS yükseltme penceresini bir kez gösterir,
 *    sonrası Ayarlar. [Varsayım: iOS 17/18 davranışı]
 *  - Google Play: arka plan konumu için uygulama içi "belirgin açıklama" (prominent disclosure) sistem isteminden
 *    ÖNCE gösterilir; Android 11+ (API 30+) arka plan izni yalnızca ayarlardan verilir ("Her zaman izin ver").
 *    Play Console'da arka plan konum beyanı + video gerekir. [Varsayım]
 *  - Pil optimizasyonu: yalnızca Android, yalnızca haftalık/süresiz; doğrudan istem yok, ayar ekranı.
 */
import {
  nextPermissionStep,
  resolveDuration,
  type DurationChoice,
  type EpochMs,
  type PermissionFlowInput,
  type PermissionStep,
  type PermissionStepResult,
  type PermState as CorePermState,
  type ShareMode,
} from '@konum/core';
import { Platform } from 'react-native';
import type { BatteryOptimization } from '../../services/location/batteryOptimization';
import type { PermState } from '../../state/permissionsStore';
import type { PermissionMemory } from '../../state/permissionFlowState';

export interface ShareContext {
  shareMode: ShareMode | null;
  durationMs?: number | null;
  wentBackgroundDuringShare?: boolean;
}

export interface PermissionSnapshot {
  foreground: PermState;
  foregroundCanAskAgain: boolean;
  background: PermState;
  backgroundCanAskAgain: boolean;
  notifications: PermState;
  preciseLocation: boolean | null;
  batteryOptimization: BatteryOptimization;
}

/** Paylaşım seçiminden bağlam (mod + süre). */
export function shareContextOf(choice: DurationChoice | null, now: EpochMs): ShareContext {
  if (!choice) return { shareMode: null };
  const r = resolveDuration(choice, now);
  return { shareMode: r.share_mode, durationMs: r.expires_at === null ? null : r.expires_at - now };
}

const toCore = (s: PermState): CorePermState => (s === 'unknown' ? 'undetermined' : s);

/** iOS ana sürüm / Android API düzeyi. */
export function platformInfo(): { platform: 'ios' | 'android'; osVersion: number } {
  if (Platform.OS === 'android') return { platform: 'android', osVersion: typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version) || 34 };
  // Web demo iOS akışını simüle eder.
  const v = typeof Platform.Version === 'string' ? parseInt(Platform.Version, 10) : Number(Platform.Version);
  return { platform: 'ios', osVersion: Number.isFinite(v) && v > 0 ? v : 17 };
}

export function buildPermissionInput(
  p: PermissionSnapshot,
  memory: PermissionMemory,
  ctx: ShareContext,
  shownThisSession: readonly PermissionStep[],
  now: EpochMs,
  platform = platformInfo(),
): PermissionFlowInput {
  return {
    platform: platform.platform,
    osVersion: platform.osVersion,
    foreground: toCore(p.foreground),
    foregroundCanAskAgain: p.foregroundCanAskAgain,
    background: toCore(p.background),
    backgroundCanAskAgain: p.backgroundCanAskAgain,
    notifications: toCore(p.notifications),
    preciseLocation: p.preciseLocation,
    batteryOptimization: p.batteryOptimization,
    shareMode: ctx.shareMode,
    durationMs: ctx.durationMs ?? null,
    wentBackgroundDuringShare: ctx.wentBackgroundDuringShare ?? false,
    hasSeenRationale: memory.hasSeenRationale,
    lastDeniedAt: memory.lastDeniedAt,
    shownThisSession,
    now,
  };
}

export function planPermissionStep(
  p: PermissionSnapshot,
  memory: PermissionMemory,
  ctx: ShareContext,
  shownThisSession: readonly PermissionStep[],
  now: EpochMs,
  platform = platformInfo(),
): PermissionStepResult {
  return nextPermissionStep(buildPermissionInput(p, memory, ctx, shownThisSession, now, platform));
}

/** Arka plan yükseltme adımları (engellemeyen şeritte de gösterilebilir). */
export const BACKGROUND_STEPS: ReadonlySet<PermissionStep> = new Set(['always_rationale', 'always_request', 'android_background_settings']);

const MODE_RANK: Record<ShareMode, number> = { timed: 0, until_end_of_day: 1, weekly: 2, indefinite: 3 };

/**
 * Süren paylaşımlardan (arkadaş + bağlantı) en "uzun" olanın bağlamı: arka plan izni gerekip gerekmediğine
 * bu karar verir. Süresiz > haftalık > gün sonu > en uzun kalan süreli.
 */
export function activeShareContext(
  shares: readonly { share_mode: ShareMode; expires_at: EpochMs | null }[],
  now: EpochMs,
  wentBackgroundDuringShare = false,
): ShareContext {
  let best: { share_mode: ShareMode; expires_at: EpochMs | null } | null = null;
  for (const s of shares) {
    if (!best) best = s;
    else if (MODE_RANK[s.share_mode] !== MODE_RANK[best.share_mode]) best = MODE_RANK[s.share_mode] > MODE_RANK[best.share_mode] ? s : best;
    else if ((s.expires_at ?? Infinity) > (best.expires_at ?? Infinity)) best = s;
  }
  if (!best) return { shareMode: null, wentBackgroundDuringShare };
  return { shareMode: best.share_mode, durationMs: best.expires_at === null ? null : Math.max(0, best.expires_at - now), wentBackgroundDuringShare };
}
