/**
 * Faz 7: ilk açılış izin akışı ve İzin & Gizlilik Merkezi modeli (saf; bkz. docs/PHASE7.md §4–§5).
 *
 * İlk açılış (Güvenlik Sözleşmesi onayından SONRA, bir kez; her adım "Şimdi değil" ile geçilebilir):
 *   welcome → location (Kullanırken) → location_always (Her zaman'a yükseltme rehberi) → notifications (tam izin:
 *   uyarı + ses + rozet; iOS zaman duyarlı / kritik) → battery_share (onay anahtarı) → camera_photos → done
 *
 * Faz 3 ilkesi korunur: akış hiçbir paylaşımı ENGELLEMEZ; atlanan izinler ihtiyaç anında (`permissionFlow.ts`)
 * yeniden istenir ve Gizlilik Merkezi'nden her an yönetilir. Sistem istemi bir kez reddedilince (canAskAgain =
 * false) yalnızca ayarlar açılır. Android 11+ "Her zaman" yalnızca sistem ayarlarından verilir.
 */
import type { PermState } from './permissionFlow';

export const ONBOARDING_VERSION = 1;
export const ONBOARDING_STORAGE_KEY = 'konum.onboarding.v1';

export const ONBOARDING_STEPS = ['welcome', 'location', 'location_always', 'notifications', 'battery_share', 'camera_photos', 'done'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** `limited` = iOS "Seçili fotoğraflar". */
export type MediaPermState = PermState | 'limited';

export interface PermissionSnapshot {
  platform: 'ios' | 'android' | 'web';
  /** iOS ana sürüm ya da Android API düzeyi. */
  osVersion: number;
  foreground: PermState;
  foregroundCanAskAgain: boolean;
  background: PermState;
  backgroundCanAskAgain: boolean;
  /** iOS tam doğruluk / Android FINE; null = bilinmiyor. */
  precise: boolean | null;
  notifications: PermState;
  notificationsCanAskAgain: boolean;
  /** iOS: zaman duyarlı bildirim ayarı açık mı (null = bilinmiyor / Android). */
  timeSensitive: boolean | null;
  /** iOS: kritik uyarı izni (yalnızca Apple yetkisiyle); null = yok / bilinmiyor. */
  criticalAlerts: boolean | null;
  camera: PermState;
  cameraCanAskAgain: boolean;
  photos: MediaPermState;
  photosCanAskAgain: boolean;
  motion: PermState | null;
  /** Yalnızca Android. */
  batteryOptimization: 'unrestricted' | 'optimized' | 'unknown' | null;
}

export type OnboardingAction = 'info' | 'system_prompt' | 'open_settings' | 'in_app_toggle' | 'none';

export interface OnboardingStepPlan {
  step: OnboardingStep;
  action: OnboardingAction;
}

export interface OnboardingInput {
  perms: PermissionSnapshot;
  /** Gizlilik tercihi kaydedildi mi (pil anahtarı bir kez soruldu). */
  batteryShareDecided: boolean;
  /** Bu akışta tamamlanan ya da "Şimdi değil" denen adımlar. */
  done: readonly OnboardingStep[];
}

/** Android 11+ (API 30) arka plan konumu yalnızca ayarlardan. */
const androidBackgroundViaSettings = (p: PermissionSnapshot) => p.platform === 'android' && p.osVersion >= 30;

/** Sıradaki adım; hepsi tamamsa `done`. Saf ve deterministik. */
export function nextOnboardingStep(input: OnboardingInput): OnboardingStepPlan {
  const { perms: p, done } = input;
  const pending = (s: OnboardingStep) => !done.includes(s);

  if (pending('welcome')) return { step: 'welcome', action: 'info' };

  if (pending('location') && p.foreground !== 'granted') {
    return { step: 'location', action: p.foreground === 'undetermined' || p.foregroundCanAskAgain ? 'system_prompt' : 'open_settings' };
  }

  if (pending('location_always') && p.foreground === 'granted' && p.background !== 'granted' && p.platform !== 'web') {
    if (androidBackgroundViaSettings(p)) return { step: 'location_always', action: 'open_settings' };
    return { step: 'location_always', action: p.background === 'undetermined' || p.backgroundCanAskAgain ? 'system_prompt' : 'open_settings' };
  }

  if (pending('notifications') && p.notifications !== 'granted') {
    return { step: 'notifications', action: p.notifications === 'undetermined' || p.notificationsCanAskAgain ? 'system_prompt' : 'open_settings' };
  }

  if (pending('battery_share') && !input.batteryShareDecided) return { step: 'battery_share', action: 'in_app_toggle' };

  if (pending('camera_photos') && (p.camera === 'undetermined' || p.photos === 'undetermined')) {
    return { step: 'camera_photos', action: 'system_prompt' };
  }

  return { step: 'done', action: 'none' };
}

/** İlerleme çubuğu: kaçıncı adım / toplam (welcome ve done sayılmaz). */
export function onboardingProgress(step: OnboardingStep): { index: number; total: number } {
  const visible = ONBOARDING_STEPS.filter((s) => s !== 'welcome' && s !== 'done');
  const i = visible.indexOf(step as (typeof visible)[number]);
  return { index: i < 0 ? (step === 'done' ? visible.length : 0) : i + 1, total: visible.length };
}

export const ONBOARDING_TEXT: Record<Exclude<OnboardingStep, 'done'>, { title: string; body: string; primary: string; settingsPrimary?: string }> = {
  welcome: {
    title: 'Birkaç izinle hazırsın',
    body: 'Konumunu yalnızca sen başlattığında ve seçtiğin kişilerle paylaşırız. Şimdi gereken izinleri tek tek anlatacağız; istediğini sonra da verebilirsin.',
    primary: 'Başla',
  },
  location: {
    title: 'Konum izni',
    body: 'Paylaşım başlattığında konumunu arkadaşlarına iletebilmemiz için "Uygulamayı Kullanırken" iznini ver. Paylaşım yokken konumun gönderilmez.',
    primary: 'Konum iznini ver',
    settingsPrimary: 'Ayarlarda aç',
  },
  location_always: {
    title: 'Uzun paylaşımlar için "Her zaman"',
    body: 'Uygulama kapalıyken de paylaşımın sürmesi, bölge (ev / iş) bildirimleri ve "yola çıktı" uyarıları için konum iznini "Her Zaman" yap. Pilini korumak için hareketsizken GPS kapanır.',
    primary: '"Her zaman"a yükselt',
    settingsPrimary: 'Ayarlarda "Her zaman izin ver"',
  },
  notifications: {
    title: 'Bildirimler',
    body: 'Acil durum (SOS) alarmları kilit ekranında sesli çalar; "Ayşe eve girdi" gibi bölge ve hareket uyarıları, etkinlik davetleri ve hatırlatmaları anında gelir.',
    primary: 'Bildirimlere izin ver',
    settingsPrimary: 'Ayarlarda bildirimleri aç',
  },
  battery_share: {
    title: 'Pil durumunu paylaşmak ister misin?',
    body: 'Açarsan konumunu paylaştığın kişiler pil yüzdeni görür ve pilin %15\'in altına inince haber alır. Kapalıyken pil bilgisi hiç gönderilmez. Sonra Gizlilik Merkezi\'nden değiştirebilirsin.',
    primary: 'Kaydet',
  },
  camera_photos: {
    title: 'Kamera ve fotoğraflar',
    body: 'Profil fotoğrafı çekmek ya da galeriden seçmek için. Yalnızca seçtiğin fotoğraf yüklenir.',
    primary: 'İzin ver',
  },
};

// --- İzin & Gizlilik Merkezi satırları -----------------------------------------------------------

export type CenterRowId = 'location' | 'precise' | 'notifications' | 'sos_alerts' | 'camera' | 'photos' | 'motion' | 'battery_optimization';
export type CenterTone = 'ok' | 'warn' | 'off';
export type CenterAction = 'request' | 'settings' | null;

export interface CenterRow {
  id: CenterRowId;
  title: string;
  status: string;
  tone: CenterTone;
  detail: string;
  action: CenterAction;
  actionLabel: string | null;
}

const askOrSettings = (state: PermState, canAsk: boolean): CenterAction => (state === 'granted' ? null : state === 'undetermined' || canAsk ? 'request' : 'settings');

/** Gizlilik Merkezi'nin "İzinler" bölümü. Web demoda yalnızca anlamlı satırlar. */
export function permissionCenterRows(p: PermissionSnapshot): CenterRow[] {
  const rows: CenterRow[] = [];

  // Konum
  {
    const always = p.background === 'granted';
    const fg = p.foreground === 'granted';
    const action: CenterAction = !fg ? askOrSettings(p.foreground, p.foregroundCanAskAgain) : always ? null : androidBackgroundViaSettings(p) || !p.backgroundCanAskAgain ? 'settings' : 'request';
    rows.push({
      id: 'location',
      title: 'Konum',
      status: always ? 'Her zaman' : fg ? 'Uygulamayı kullanırken' : p.foreground === 'undetermined' ? 'Sorulmadı' : 'Kapalı',
      tone: always ? 'ok' : fg ? 'warn' : 'off',
      detail: always
        ? 'Uzun paylaşımlar, bölge bildirimleri ve "yola çıktı" uyarıları uygulama kapalıyken de çalışır.'
        : fg
          ? 'Kısa paylaşımlar çalışır. Uygulama kapalıyken sürmesi ve bölge bildirimleri için "Her zaman" gerekir.'
          : 'Konum paylaşımı için gerekli.',
      action,
      actionLabel: action === null ? null : !fg ? (action === 'request' ? 'İzin ver' : 'Ayarları aç') : '"Her zaman"a yükselt',
    });
  }

  if (p.foreground === 'granted' && p.precise === false) {
    rows.push({
      id: 'precise',
      title: 'Tam konum',
      status: 'Yaklaşık',
      tone: 'warn',
      detail: 'Arkadaşların seni birkaç kilometrelik bir alanda görür. Tam konum için ayarlardan "Tam Konum"u aç.',
      action: 'settings',
      actionLabel: 'Ayarları aç',
    });
  }

  // Bildirimler
  {
    const on = p.notifications === 'granted';
    const action = askOrSettings(p.notifications, p.notificationsCanAskAgain);
    rows.push({
      id: 'notifications',
      title: 'Bildirimler',
      status: on ? 'Açık' : p.notifications === 'undetermined' ? 'Sorulmadı' : 'Kapalı',
      tone: on ? 'ok' : 'off',
      detail: on ? 'SOS alarmı, bölge ve hareket uyarıları, etkinlik davetleri ve hatırlatmaları.' : 'Kapalıyken SOS alarmı ve davetler sana ulaşamaz.',
      action,
      actionLabel: action === null ? null : action === 'request' ? 'İzin ver' : 'Ayarları aç',
    });
    if (on && p.platform === 'ios') {
      const critical = p.criticalAlerts === true;
      const ts = p.timeSensitive !== false;
      rows.push({
        id: 'sos_alerts',
        title: 'SOS alarmı',
        status: critical ? 'Kritik uyarı' : ts ? 'Zaman duyarlı' : 'Normal',
        tone: critical || ts ? 'ok' : 'warn',
        detail: critical
          ? 'Sessiz modda ve Odak açıkken de alarm sesiyle çalar.'
          : ts
            ? 'Odak modlarını aşar ve kilit ekranında kalır. Sessiz moddayken alarm sesi duyulmaz.'
            : 'Zaman duyarlı bildirimler kapalı: Odak açıkken SOS gecikebilir.',
        action: critical || ts ? null : 'settings',
        actionLabel: critical || ts ? null : 'Ayarları aç',
      });
    }
  }

  if (p.platform !== 'web') {
    const camAction = askOrSettings(p.camera, p.cameraCanAskAgain);
    rows.push({
      id: 'camera',
      title: 'Kamera',
      status: p.camera === 'granted' ? 'Açık' : p.camera === 'undetermined' ? 'Sorulmadı' : 'Kapalı',
      tone: p.camera === 'granted' ? 'ok' : 'off',
      detail: 'Yalnızca profil fotoğrafı çekerken kullanılır.',
      action: camAction,
      actionLabel: camAction === null ? null : camAction === 'request' ? 'İzin ver' : 'Ayarları aç',
    });
    const photoAction: CenterAction = p.photos === 'granted' ? null : p.photos === 'limited' ? 'settings' : askOrSettings(p.photos, p.photosCanAskAgain);
    rows.push({
      id: 'photos',
      title: 'Fotoğraflar',
      status: p.photos === 'granted' ? 'Tüm fotoğraflar' : p.photos === 'limited' ? 'Seçili fotoğraflar' : p.photos === 'undetermined' ? 'Sorulmadı' : 'Kapalı',
      tone: p.photos === 'granted' || p.photos === 'limited' ? 'ok' : 'off',
      detail: 'Profil fotoğrafını galeriden seçmek için. Yalnızca seçtiğin fotoğraf yüklenir.',
      action: photoAction,
      actionLabel: photoAction === null ? null : photoAction === 'request' ? 'İzin ver' : 'Ayarları aç',
    });
    if (p.motion !== null) {
      rows.push({
        id: 'motion',
        title: 'Hareket ve etkinlik',
        status: p.motion === 'granted' ? 'Açık' : p.motion === 'undetermined' ? 'Sorulmadı' : 'Kapalı',
        tone: p.motion === 'granted' ? 'ok' : 'off',
        detail: 'Hareketsizken GPS\'i kapatıp pili korur ve "yola çıktı" anını doğru yakalar. İsteğe bağlıdır.',
        action: p.motion === 'granted' ? null : p.motion === 'undetermined' ? 'request' : 'settings',
        actionLabel: p.motion === 'granted' ? null : p.motion === 'undetermined' ? 'İzin ver' : 'Ayarları aç',
      });
    }
  }

  if (p.platform === 'android' && p.batteryOptimization === 'optimized') {
    rows.push({
      id: 'battery_optimization',
      title: 'Pil optimizasyonu',
      status: 'Kısıtlı',
      tone: 'warn',
      detail: 'Uzun paylaşımlarda telefon uygulamayı uyutabilir. "Kısıtlama yok" seçersen paylaşım kesilmez.',
      action: 'settings',
      actionLabel: 'Ayarları aç',
    });
  }

  return rows;
}

/** Merkezin üstündeki özet: "2 izin eksik" ya da "Tüm izinler tamam". */
export function permissionCenterSummary(rows: readonly CenterRow[]): { missing: number; text: string } {
  const missing = rows.filter((r) => r.tone !== 'ok').length;
  return { missing, text: missing === 0 ? 'Tüm izinler tamam' : `${missing} ayar dikkat istiyor` };
}
