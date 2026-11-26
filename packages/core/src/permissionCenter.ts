/**
 * Faz 7: ilk açılış izin akışı ve İzin & Gizlilik Merkezi modeli (saf; bkz. docs/PHASE7.md §4–§5).
 *
 * İlk açılış (Güvenlik Sözleşmesi onayından SONRA, bir kez; her adım "Şimdi değil" ile geçilebilir):
 *   welcome → location (Kullanırken) → location_always (Her zaman'a yükseltme rehberi) → notifications (tam izin:
 *   uyarı + ses + rozet; iOS zaman duyarlı / kritik) → contacts (Faz 9: Rehber, SMS acil numarası seçmek için) →
 *   sms (Faz 9: çevrimdışı SOS SMS yedeğine AÇIK ONAY; uygulama içi) → battery_share (onay anahtarı) →
 *   camera_photos → done
 *
 * Faz 9 (`ONBOARDING_VERSION = 2`): v1 akışını bitirmiş kullanıcıya yalnızca yeni adımlar (`ONBOARDING_V2_STEPS`)
 * bir kez gösterilir; hoş geldin ekranı tekrarlanmaz.
 *
 * Faz 3 ilkesi korunur: akış hiçbir paylaşımı ENGELLEMEZ; atlanan izinler ihtiyaç anında (`permissionFlow.ts`)
 * yeniden istenir ve Gizlilik Merkezi'nden her an yönetilir. Sistem istemi bir kez reddedilince (canAskAgain =
 * false) yalnızca ayarlar açılır. Android 11+ "Her zaman" yalnızca sistem ayarlarından verilir.
 */
import type { PermState } from './permissionFlow';

export const ONBOARDING_VERSION = 2;
/** Anahtar v1'de kaldı: kayıt `version` alanı taşır (v1 bitirenlere yalnızca yeni adımlar). */
export const ONBOARDING_STORAGE_KEY = 'konum.onboarding.v1';

export const ONBOARDING_STEPS = ['welcome', 'location', 'location_always', 'notifications', 'contacts', 'sms', 'battery_share', 'camera_photos', 'done'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Faz 9'da eklenen adımlar (v1'i bitirmiş kullanıcılara bir kez). */
export const ONBOARDING_V2_STEPS = ['contacts', 'sms'] as const satisfies readonly OnboardingStep[];

/** v1'i bitirmiş kullanıcının v2 akışına `done` olarak taşınacak adımlar (yalnızca yeni adımlar kalır). */
export function onboardingDoneForUpgrade(prevVersion: number, prevDone: readonly OnboardingStep[]): OnboardingStep[] {
  // Yarıda kalmış akış olduğu gibi sürer (yeni adımlar sırası gelince sorulur).
  if (prevVersion >= ONBOARDING_VERSION || !prevDone.includes('done')) return [...prevDone];
  const v2 = ONBOARDING_V2_STEPS as readonly string[];
  return ONBOARDING_STEPS.filter((s) => s !== 'done' && !v2.includes(s));
}

/** `limited` = iOS "Seçili fotoğraflar". */
export type MediaPermState = PermState | 'limited';
/** Faz 9: Rehber; `limited` = iOS 18 seçili kişiler, `unavailable` = web / modül yok. */
export type ContactsPermState = MediaPermState | 'unavailable';

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
  /** Faz 9: Rehber (iOS 18 `limited` = seçili kişiler). Web'de 'unavailable'. */
  contacts: ContactsPermState;
  contactsCanAskAgain: boolean;
  /** Faz 9: cihaz SMS oluşturabiliyor mu (expo-sms `isAvailableAsync`); null = bilinmiyor. */
  smsAvailable: boolean | null;
}

/** Faz 9: uygulama içi SMS yedeği tercihi (cihazda; `smsFallback.ts`). */
export interface SmsFallbackSummary {
  enabled: boolean;
  numbers: number;
  decided: boolean;
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
  /** Faz 9: SMS yedeği için açık onay / ret kararı verildi mi. Eksikse false sayılır. */
  smsFallbackDecided?: boolean;
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

  if (pending('contacts') && p.platform !== 'web' && p.contacts !== 'granted' && p.contacts !== 'limited' && p.contacts !== 'unavailable') {
    return { step: 'contacts', action: p.contacts === 'undetermined' || p.contactsCanAskAgain ? 'system_prompt' : 'open_settings' };
  }

  if (pending('sms') && !input.smsFallbackDecided) return { step: 'sms', action: p.smsAvailable === false ? 'info' : 'in_app_toggle' };

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
  contacts: {
    title: 'Rehber (Kişiler)',
    body: 'İnternet yokken SOS mesajını SMS ile gönderebilmen için acil durum numaralarını rehberinden seçmene yarar. Rehberin sunucularımıza yüklenmez ve taranmaz; yalnızca seçtiğin numaralar bu telefonda saklanır. İzin vermezsen numarayı elle de yazabilirsin.',
    primary: 'Rehber iznini ver',
    settingsPrimary: 'Ayarlarda aç',
  },
  sms: {
    title: 'SMS ile acil durum yedeği',
    body: "İnternet tamamen kesikken SOS'a basarsan son doğrulanmış konumun, saat, pil yüzden ve harita bağlantısı hazır bir SMS olarak telefonunun mesaj uygulamasında açılır; Gönder'e dokunman yeter. Uygulama SMS'lerini okumaz ve onayın olmadan SMS göndermez. SMS ücreti operatörüne göre alınabilir.",
    primary: 'Onaylıyorum, aç',
    settingsPrimary: 'Kapalı kalsın',
  },
  camera_photos: {
    title: 'Kamera ve fotoğraflar',
    body: 'Profil fotoğrafı ve paylaşım sırasında anlık fotoğraf çekmek için kamera; profil fotoğrafını galeriden seçmek için fotoğraflar. Anlık fotoğraf galeriden seçilemez. Yalnızca seçtiğin ya da çektiğin fotoğraf yüklenir.',
    primary: 'İzin ver',
  },
};

// --- İzin & Gizlilik Merkezi satırları -----------------------------------------------------------

export type CenterRowId = 'location' | 'precise' | 'notifications' | 'sos_alerts' | 'camera' | 'photos' | 'contacts' | 'sms' | 'motion' | 'battery_optimization';
export type CenterTone = 'ok' | 'warn' | 'off';
/** Faz 9: `in_app` = uygulama içi ayar (SMS yedeği sayfası). */
export type CenterAction = 'request' | 'settings' | 'in_app' | null;

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

/** Gizlilik Merkezi'nin "İzinler" bölümü. Web demoda yalnızca anlamlı satırlar. Faz 9: `sms` uygulama içi tercih. */
export function permissionCenterRows(p: PermissionSnapshot, sms?: SmsFallbackSummary | null): CenterRow[] {
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
      detail: 'Profil fotoğrafı ve anlık fotoğraf çekerken kullanılır. Anlık fotoğraf yalnızca kamerayla çekilir, galeriden seçilemez.',
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
    // Faz 9: Rehber (SMS acil numarası seçmek için; rehber sunucuya gitmez).
    if (p.contacts !== 'unavailable') {
      const cAction: CenterAction = p.contacts === 'granted' ? null : p.contacts === 'limited' ? 'settings' : askOrSettings(p.contacts, p.contactsCanAskAgain);
      rows.push({
        id: 'contacts',
        title: 'Rehber',
        status: p.contacts === 'granted' ? 'Açık' : p.contacts === 'limited' ? 'Seçili kişiler' : p.contacts === 'undetermined' ? 'Sorulmadı' : 'Kapalı',
        tone: p.contacts === 'granted' || p.contacts === 'limited' ? 'ok' : 'off',
        detail: 'SMS acil durum numaralarını rehberinden seçmek için. Rehberin sunucuya yüklenmez; yalnızca seçtiğin numaralar bu telefonda kalır.',
        action: cAction,
        actionLabel: cAction === null ? null : cAction === 'request' ? 'İzin ver' : 'Ayarları aç',
      });
    }
  }

  // Faz 9: SMS yedeği (uygulama içi açık onay; iOS/Android SMS uygulaması, izin gerekmez).
  if (p.platform !== 'web' || sms) {
    const on = sms?.enabled === true;
    const n = sms?.numbers ?? 0;
    const unavailable = p.smsAvailable === false;
    rows.push({
      id: 'sms',
      title: 'SMS ile acil durum yedeği',
      status: unavailable ? 'Bu cihazda yok' : !on ? 'Kapalı' : n === 0 ? 'Açık · numara yok' : `Açık · ${n} numara`,
      tone: unavailable ? 'off' : on && n > 0 ? 'ok' : on ? 'warn' : 'off',
      detail: unavailable
        ? 'Bu cihaz SMS gönderemiyor (SIM kart yok ya da tablet). SOS internet gelince uygulama üzerinden gider.'
        : "İnternet yokken SOS'a basarsan son konumun, saat, pil ve harita bağlantısı hazır SMS olarak mesaj uygulamanda açılır; Gönder'e sen dokunursun.",
      action: unavailable ? null : 'in_app',
      actionLabel: unavailable ? null : on ? 'Numaraları yönet' : 'Aç',
    });
  }
  if (p.platform !== 'web') {
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
/** Faz 9: isteğe bağlı satırlar kapalıyken "dikkat istiyor" sayılmaz (SMS açık ama numara yoksa 'warn' sayılır). */
export const OPTIONAL_CENTER_ROWS: readonly CenterRowId[] = ['contacts', 'sms'];

export function permissionCenterSummary(rows: readonly CenterRow[]): { missing: number; text: string } {
  const missing = rows.filter((r) => r.tone === 'warn' || (r.tone !== 'ok' && !OPTIONAL_CENTER_ROWS.includes(r.id))).length;
  return { missing, text: missing === 0 ? 'Tüm izinler tamam' : `${missing} ayar dikkat istiyor` };
}
