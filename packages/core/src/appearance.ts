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
