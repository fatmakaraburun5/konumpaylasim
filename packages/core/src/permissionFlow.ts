/**
 * Faz 3: kullanıcıyı sıkmayan, mağaza politikalarına uygun izin adımı planlayıcısı (saf).
 *
 * İlkeler:
 *  - İzin yalnızca İHTİYAÇ ANINDA istenir (ilk paylaşım başlatılırken), uygulama açılışında değil.
 *  - Kısa ön plan paylaşımı ASLA engellenmez: "Kullanırken" izni yeter. iOS'ta arka plan konum modu +
 *    mavi gösterge, Android'de `foregroundServiceType="location"` kalıcı bildirimli servis, ekran kilitliyken
 *    de akışı sürdürür (servis ön plandayken başlatıldığı için arka plan izni gerekmez).
 *  - `Always` / `ACCESS_BACKGROUND_LOCATION` yalnızca süre ≥ 8 saat, gün sonu, haftalık, süresiz ya da paylaşım
 *    sırasında uygulama arka plana gittiyse istenir; önce uygulama içi açıklama (Google Play "prominent
 *    disclosure" ve Apple kademeli yükseltme), sonra sistem istemi / ayarlar.
 *    Neden gerekli: uygulama öldürülünce yeniden uyanma (iOS bölge izleme / önemli değişiklik), uyku çiti
 *    (geofence) ve Android 10+'da arka plandan konum başlatma.
 *  - Reddedilen ya da "Şimdi değil" denen adım 7 gün içinde yeniden sorulmaz; aynı oturumda gösterilen adım
 *    tekrarlanmaz.
 *  - Android 11+ (API 30+) arka plan izni yalnızca sistem ayarlarından verilebilir ("Her zaman izin ver").
 *  - Pil optimizasyonu ipucu yalnızca Android'de, yalnızca haftalık/süresiz paylaşımda.
 */
import type { ShareMode } from './duration';
import { DAY, HOUR, type EpochMs } from './time';

export type PermState = 'granted' | 'denied' | 'undetermined' | 'restricted';

export type PermissionStep =
  | 'when_in_use'
  | 'notifications'
  | 'always_rationale'
  | 'always_request'
  | 'android_background_settings'
  | 'battery_optimization_hint'
  | 'precise_hint'
  | 'done';

/** Bekleme süresi takibi yapılan izin türleri (`lastDeniedAt` anahtarları). */
/** Faz 3: `motion` = hareket etkinliği izni (iOS Motion & Fitness, Android ACTIVITY_RECOGNITION); planlayıcı sırasına girmez, istemci ek adımıdır. */
export type PermissionKind = 'foreground' | 'background' | 'notifications' | 'battery' | 'precise' | 'motion';

export const PERMISSION_REASK_COOLDOWN_MS = 7 * DAY;
/** Bu süre ve üstü süreli paylaşım arka plan izni ister. */
export const LONG_SHARE_MIN_MS = 8 * HOUR;

export interface PermissionFlowInput {
  platform: 'ios' | 'android';
  /** iOS ana sürüm (17, 18 …) ya da Android API düzeyi (29, 30, 34 …). */
  osVersion: number;
  foreground: PermState;
  /** expo-location `canAskAgain` (ön plan); false = yalnızca ayarlar. */
  foregroundCanAskAgain?: boolean;
  background: PermState;
  backgroundCanAskAgain?: boolean;
  notifications: PermState;
  /** iOS accuracyAuthorization === full / Android FINE verildi. null = bilinmiyor. */
  preciseLocation: boolean | null;
  /** Yalnızca Android. */
  batteryOptimization?: 'unrestricted' | 'optimized' | 'unknown';
  /** Başlatılan/sürmekte olan paylaşımın modu; null = paylaşım yok (hiçbir şey sorulmaz). */
  shareMode: ShareMode | null;
  /** `timed` için seçilen süre. */
  durationMs?: number | null;
  /** Paylaşım sürerken uygulama arka plana gitti (bir sonraki ön plana gelişte sorulur). */
  wentBackgroundDuringShare?: boolean;
  /** Uygulama içi açıklama gösterildi ve kullanıcı "Devam" dedi. */
  hasSeenRationale?: { always?: boolean };
  /** Kullanıcının reddettiği / "Şimdi değil" dediği an. */
  lastDeniedAt?: Partial<Record<PermissionKind, EpochMs | null>>;
  /** Bu oturumda (bu paylaşım başlatma akışında) zaten gösterilmiş adımlar. */
  shownThisSession?: readonly PermissionStep[];
  now: EpochMs;
}

export interface PermissionStepResult {
  step: PermissionStep;
  /** Adım nasıl sunulur. */
  action: 'system_prompt' | 'in_app_sheet' | 'open_settings' | 'none';
  /** true = bu adım çözülmeden paylaşım başlayamaz (yalnızca ilk ön plan izni). */
  blocking: boolean;
  /** Şu anki izinlerle paylaşım çalışabilir mi (ön plan + kilit ekranı). */
  canShare: boolean;
  /** Uyku çiti / uygulama kapalıyken uyanma kullanılabilir mi (`TrackingPlanInput.canUseGeofence`). */
  canUseGeofence: boolean;
  reason: string;
}

const LONG_MODES: readonly ShareMode[] = ['until_end_of_day', 'weekly', 'indefinite'];

/** Paylaşım arka plan (Always) izni gerektiriyor mu? */
export function needsBackgroundPermission(input: Pick<PermissionFlowInput, 'shareMode' | 'durationMs' | 'wentBackgroundDuringShare'>): boolean {
  if (input.shareMode === null) return false;
  if (input.wentBackgroundDuringShare) return true;
  if (LONG_MODES.includes(input.shareMode)) return true;
  return input.shareMode === 'timed' && (input.durationMs ?? 0) >= LONG_SHARE_MIN_MS;
}

/** Platform arka plan iznini ayrı istiyor mu? Android 9 ve öncesinde ön plan izniyle birlikte gelir. */
function backgroundGranted(i: PermissionFlowInput): boolean {
  if (i.platform === 'android' && i.osVersion < 29) return i.foreground === 'granted';
  return i.background === 'granted';
}

function notificationsGranted(i: PermissionFlowInput): boolean {
  // Android 12 ve öncesinde bildirim izni çalışma zamanında istenmez.
  if (i.platform === 'android' && i.osVersion < 33) return true;
  return i.notifications === 'granted';
}

export function nextPermissionStep(input: PermissionFlowInput): PermissionStepResult {
  const shown = new Set(input.shownThisSession ?? []);
  const cooling = (k: PermissionKind) => {
    const at = input.lastDeniedAt?.[k];
    return typeof at === 'number' && input.now - at < PERMISSION_REASK_COOLDOWN_MS;
  };
  const canShare = input.foreground === 'granted';
  const canUseGeofence = canShare && backgroundGranted(input);
  const res = (step: PermissionStep, action: PermissionStepResult['action'], reason: string, blocking = false): PermissionStepResult => ({
    step,
    action,
    blocking,
    canShare,
    canUseGeofence,
    reason,
  });

  if (input.shareMode === null) return res('done', 'none', 'no_share');

  // 1) Ön plan ("Kullanırken"): tek engelleyici adım.
  if (input.foreground !== 'granted') {
    if (input.foreground === 'restricted') return res('done', 'none', 'foreground_restricted');
    if (shown.has('when_in_use')) return res('done', 'none', 'foreground_shown_this_session');
    if (input.foreground === 'undetermined') return res('when_in_use', 'system_prompt', 'foreground_needed', true);
    // Reddedilmiş: 7 gün içinde yeniden sorulmaz; UI yalnızca satır içi "Konum izni kapalı · Ayarlar" gösterir.
    if (cooling('foreground')) return res('done', 'none', 'foreground_denied_cooldown');
    const viaSettings = input.platform === 'ios' || input.foregroundCanAskAgain === false;
    return res('when_in_use', viaSettings ? 'open_settings' : 'system_prompt', 'foreground_denied_reask', true);
  }

  // 2) Bildirimler: bitiş uyarısı, "+30 dk" eylemi, Android 13+ kalıcı servis bildirimi görünürlüğü.
  if (!notificationsGranted(input) && input.notifications === 'undetermined' && !shown.has('notifications') && !cooling('notifications')) {
    return res('notifications', 'system_prompt', 'notifications_for_share_alerts');
  }

  // 3) Arka plan / Always: yalnızca uzun paylaşımda ya da paylaşım sırasında arka plana gidildiyse.
  if (needsBackgroundPermission(input) && !backgroundGranted(input) && input.background !== 'restricted' && !cooling('background')) {
    if (!input.hasSeenRationale?.always) {
      if (!shown.has('always_rationale')) return res('always_rationale', 'in_app_sheet', 'background_rationale_first');
    } else if (input.platform === 'ios') {
      if (!shown.has('always_request')) {
        // iOS yükseltme istemini yalnızca bir kez gösterir; sonrası Ayarlar.
        return res('always_request', input.background === 'undetermined' ? 'system_prompt' : 'open_settings', 'ios_always_upgrade');
      }
    } else if (input.osVersion >= 30) {
      if (!shown.has('android_background_settings')) return res('android_background_settings', 'open_settings', 'android11_background_via_settings');
    } else if (!shown.has('always_request')) {
      const viaSettings = input.background === 'denied' && input.backgroundCanAskAgain === false;
      return res('always_request', viaSettings ? 'open_settings' : 'system_prompt', 'android10_background_dialog');
    }
  }

  // 4) Pil optimizasyonu (Android, haftalık/süresiz): Doze/üretici pil yöneticisi servisi öldürmesin.
  if (
    input.platform === 'android' &&
    (input.shareMode === 'weekly' || input.shareMode === 'indefinite') &&
    input.batteryOptimization === 'optimized' &&
    !shown.has('battery_optimization_hint') &&
    !cooling('battery')
  ) {
    return res('battery_optimization_hint', 'open_settings', 'android_battery_optimization');
  }

  // 5) Yaklaşık konum: paylaşım çalışır ama 1–3 km sapar; bir kez nazikçe hatırlat.
  if (input.preciseLocation === false && !shown.has('precise_hint') && !cooling('precise')) {
    return res('precise_hint', 'system_prompt', 'approximate_location');
  }

  return res('done', 'none', canUseGeofence ? 'all_set' : 'foreground_only');
}

/** Uygulama içi açıklama metinleri (Türkçe). [Varsayım] metinler; mağaza incelemesi öncesi gözden geçirilecek. */
export const PERMISSION_COPY: Record<Exclude<PermissionStep, 'done'>, { title: string; body: string; cta: string; dismiss: string }> = {
  when_in_use: {
    title: 'Konumunu paylaşmak için izin gerekiyor',
    body: 'Konumun yalnızca seçtiğin kişilerle ve seçtiğin süre boyunca paylaşılır. Paylaşımı istediğin an durdurabilirsin.',
    cta: 'İzin ver',
    dismiss: 'Vazgeç',
  },
  notifications: {
    title: 'Paylaşım bildirimleri',
    body: 'Süre bitmeden haber verelim, tek dokunuşla uzatabil. Konumun bildirimlerde asla yer almaz.',
    cta: 'Bildirimlere izin ver',
    dismiss: 'Şimdi değil',
  },
  always_rationale: {
    title: 'Uzun paylaşım için arka plan konumu',
    body:
      'Haftalık ve süresiz paylaşımlarda, uygulama kapalıyken ya da ekran kilitliyken de konumun paylaşılmaya devam eder. ' +
      'Hareketsizken GPS kapanır, pilin korunur. Konum yalnızca paylaşım sürerken ve yalnızca seçtiğin kişilere gider.',
    cta: 'Devam',
    dismiss: 'Şimdi değil',
  },
  always_request: {
    title: '“Her Zaman” iznini seç',
    body: 'Açılan pencerede “Her Zaman İzin Ver”i seç. Ayarlar’dan istediğin zaman değiştirebilirsin.',
    cta: 'Devam',
    dismiss: 'Şimdi değil',
  },
  android_background_settings: {
    title: '“Her zaman izin ver”i seç',
    body: 'Android ayarlarında Konum izni → “Her zaman izin ver”. Paylaşım bitince konum kullanılmaz.',
    cta: 'Ayarlara git',
    dismiss: 'Şimdi değil',
  },
  battery_optimization_hint: {
    title: 'Paylaşımın kesilmesin',
    body: 'Bazı telefonlar pil tasarrufu için arka plandaki uygulamaları durdurur. Konum için “Kısıtlanmamış” seçersen haftalık paylaşım kesintisiz sürer.',
    cta: 'Ayarlara git',
    dismiss: 'Şimdi değil',
  },
  precise_hint: {
    title: 'Konumun yaklaşık paylaşılıyor',
    body: 'Karşı taraf seni 1–3 km sapmayla görür. Buluşmalar için “Tam Konum”u açabilirsin.',
    cta: 'Tam konumu aç',
    dismiss: 'Böyle kalsın',
  },
};
