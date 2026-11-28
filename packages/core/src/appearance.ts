/**
 * Faz 7: görünüm tercihi — Açık / Koyu / Sistem (bkz. docs/PHASE7.md §6).
 *
 * Tercih cihazda saklanır (hesaba bağlı değil: aynı kişinin iki telefonu farklı olabilir). Tercih hem uygulama
 * temasını hem Google Haritalar özel stilini (customMapStyle JSON) belirler; `system` cihazın açık/koyu ayarını
 * izler ve cihaz ayarı değişince ANINDA uygulanır. Harita stili iki sabit diziden seçilir (yeniden hesap yok),
 * bu yüzden geçiş anlıktır ve harita yeniden yüklenmez.
 */
export const THEME_PREFS = ['system', 'light', 'dark'] as const;
export type ThemePref = (typeof THEME_PREFS)[number];
export type ColorScheme = 'light' | 'dark';

export const DEFAULT_THEME_PREF: ThemePref = 'system';

/** Cihazda saklama anahtarı (sürümlü). */
export const THEME_PREF_STORAGE_KEY = 'konum.theme_pref.v1';

export const THEME_PREF_TEXT: Record<ThemePref, string> = { system: 'Sistem', light: 'Açık', dark: 'Koyu' };

export const THEME_PREF_HINT: Record<ThemePref, string> = {
  system: 'Telefonunun açık / koyu ayarını izler',
  light: 'Harita ve uygulama her zaman açık',
  dark: 'Harita ve uygulama her zaman koyu',
};

export const THEME_PREF_ICON: Record<ThemePref, string> = { system: '🌓', light: '☀️', dark: '🌙' };

export function parseThemePref(raw: unknown): ThemePref {
  return typeof raw === 'string' && (THEME_PREFS as readonly string[]).includes(raw) ? (raw as ThemePref) : DEFAULT_THEME_PREF;
}

/** Etkin şema: `system` → cihaz (bilinmiyorsa açık). */
export function resolveColorScheme(pref: ThemePref, system: ColorScheme | null | undefined): ColorScheme {
  if (pref === 'light' || pref === 'dark') return pref;
  return system === 'dark' ? 'dark' : 'light';
}

/** Harita üstündeki tek düğme: Sistem → Açık → Koyu → Sistem. */
export function nextThemePref(p: ThemePref): ThemePref {
  const i = THEME_PREFS.indexOf(p);
  return THEME_PREFS[(i + 1) % THEME_PREFS.length] as ThemePref;
}

// ---------------------------------------------------------------------------------------------------------------
// Faz 11: tema paketi (Nude, Pudra Pembesi, Siyah / Gri) + saate göre otomatik geçiş (bkz. docs/PHASE11.md).
//
// Faz 7 tercihleri (system / light / dark) aynen geçerli. Yeni tercihler:
//  - `nude` | `blush` | `charcoal`: sabit tema paketi.
//  - `schedule`: kişisel ikili kural; gündüz teması `day_start`'tan, gece teması `night_start`'tan itibaren.
// Tercih + kural cihazda tek JSON kaydında saklanır (v2). v1 kaydı (düz dize) okunurken taşınır.
// Etkin tema `resolveThemeId` ile bulunur; şema (light/dark) temanın tabanıdır (charcoal → dark).
// ---------------------------------------------------------------------------------------------------------------

/** Çizilebilen temalar (belirteç setleri ve harita stilleri bunlara göre tutulur). */
export const THEME_IDS = ['light', 'dark', 'nude', 'blush', 'charcoal'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** Faz 11 tercihleri: Faz 7'nin üçü + üç paket + saat kuralı. */
export const THEME_PREFS_V2 = ['system', 'light', 'dark', 'nude', 'blush', 'charcoal', 'schedule'] as const;
export type ThemePrefV2 = (typeof THEME_PREFS_V2)[number];

export const THEME_ID_SCHEME: Record<ThemeId, ColorScheme> = {
  light: 'light',
  dark: 'dark',
  nude: 'light',
  blush: 'light',
  charcoal: 'dark',
};

export const THEME_NAME: Record<ThemeId, string> = {
  light: 'Açık',
  dark: 'Koyu',
  nude: 'Nude',
  blush: 'Pudra Pembesi',
  charcoal: 'Siyah / Gri',
};

export const THEME_DESC: Record<ThemeId, string> = {
  light: 'Ferah beyaz ve mavi',
  dark: 'Gece mavisi koyu tema',
  nude: 'Krem zemin, sütlü kahve kartlar, tarçın düğmeler',
  blush: 'Kırık beyaz zemin, toz pembe kartlar, mürdüm vurgular',
  charcoal: 'Grafit yüzeyler, kademeli gri katmanlar',
};

/** Saat kuralı: dakika cinsinden (0–1439), yerel saat. */
export interface ThemeSchedule {
  day: ThemeId;
  night: ThemeId;
  day_start: number;
  night_start: number;
}

export const DEFAULT_THEME_SCHEDULE: ThemeSchedule = { day: 'nude', night: 'charcoal', day_start: 7 * 60, night_start: 19 * 60 };

export interface ThemeSettings {
  pref: ThemePrefV2;
  schedule: ThemeSchedule;
}

export const DEFAULT_THEME_SETTINGS: ThemeSettings = { pref: 'system', schedule: DEFAULT_THEME_SCHEDULE };

export const THEME_SETTINGS_STORAGE_KEY = 'konum.theme_settings.v2';

const isThemeId = (x: unknown): x is ThemeId => typeof x === 'string' && (THEME_IDS as readonly string[]).includes(x);
const isMinute = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 1440;

/** Kural doğrulama: iki saat aynı olamaz (yoksa tema hiç değişmez). */
export function parseThemeSchedule(raw: unknown): ThemeSchedule {
  const r = (raw ?? {}) as Partial<ThemeSchedule>;
  const s: ThemeSchedule = {
    day: isThemeId(r.day) ? r.day : DEFAULT_THEME_SCHEDULE.day,
    night: isThemeId(r.night) ? r.night : DEFAULT_THEME_SCHEDULE.night,
    day_start: isMinute(r.day_start) ? r.day_start : DEFAULT_THEME_SCHEDULE.day_start,
    night_start: isMinute(r.night_start) ? r.night_start : DEFAULT_THEME_SCHEDULE.night_start,
  };
  return s.day_start === s.night_start ? { ...s, night_start: (s.day_start + 720) % 1440 } : s;
}

/** v2 JSON kaydını okur; yoksa v1 düz tercih dizesini (`konum.theme_pref.v1`) taşır. */
export function parseThemeSettings(rawV2: string | null | undefined, rawV1?: string | null): ThemeSettings {
  if (rawV2) {
    try {
      const o = JSON.parse(rawV2) as Partial<ThemeSettings>;
      const pref = typeof o.pref === 'string' && (THEME_PREFS_V2 as readonly string[]).includes(o.pref) ? o.pref : DEFAULT_THEME_SETTINGS.pref;
      return { pref, schedule: parseThemeSchedule(o.schedule) };
    } catch {
      /* bozuk kayıt → v1 / varsayılan */
    }
  }
  return { pref: parseThemePref(rawV1), schedule: DEFAULT_THEME_SCHEDULE };
}

/** Yerel saatin günün kaçıncı dakikası olduğu. */
export const minuteOfDay = (d: Date): number => d.getHours() * 60 + d.getMinutes();

/** Kural şu an gündüz mü? (`day_start` ≤ t < `night_start`, gece yarısını aşan aralıklar da doğru). */
export function isDayTime(s: ThemeSchedule, minute: number): boolean {
  return s.day_start < s.night_start ? minute >= s.day_start && minute < s.night_start : minute >= s.day_start || minute < s.night_start;
}

/** Etkin tema: tercih + cihaz şeması + (schedule ise) yerel saat. */
export function resolveThemeId(settings: ThemeSettings, system: ColorScheme | null | undefined, now: Date): ThemeId {
  const { pref } = settings;
  if (pref === 'schedule') return isDayTime(settings.schedule, minuteOfDay(now)) ? settings.schedule.day : settings.schedule.night;
  if (pref === 'system') return system === 'dark' ? 'dark' : 'light';
  return pref;
}

/** Kuraldaki bir sonraki geçiş anı (ms; zamanlayıcı için). `schedule` dışında null. */
export function nextThemeSwitchAt(settings: ThemeSettings, now: Date): number | null {
  if (settings.pref !== 'schedule') return null;
  const m = minuteOfDay(now);
  const targets = [settings.schedule.day_start, settings.schedule.night_start];
  const ahead = targets.map((t) => (t > m ? t - m : t + 1440 - m));
  const mins = Math.min(...ahead);
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), 0, 0).getTime();
  return base + mins * 60_000;
}

/** "07:30" biçimi. */
export const formatMinute = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export const THEME_PREF_V2_TEXT: Record<ThemePrefV2, string> = {
  system: 'Sistem',
  light: 'Açık',
  dark: 'Koyu',
  nude: 'Nude',
  blush: 'Pudra Pembesi',
  charcoal: 'Siyah / Gri',
  schedule: 'Saate göre',
};
