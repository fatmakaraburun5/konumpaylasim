/**
 * Faz 11: tema paketi. Harita stilleri (5 tema, sabit başvuru + docs/map-styles JSON eşitliği), anlık geçiş,
 * saat kuralı ve kayıt taşıma. `WRITE_MAP_STYLES=1 npx jest faz11Theme` JSON dosyalarını yeniden üretir.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { THEME_IDS, THEME_PREF_STORAGE_KEY, THEME_SETTINGS_STORAGE_KEY, resolveThemeId } from '@konum/core';
import { MAP_STYLES, mapStyleFor, themeById } from '../src/ui/theme';
import { __resetThemePrefForTests, hydrateThemePref, setThemePref, setThemeSchedule, themePrefStore } from '../src/ui/themePref';

// Node modülleri (mobil tsconfig'te @types/node yok).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs') as { readFileSync(p: string, e: 'utf8'): string; writeFileSync(p: string, d: string): void; mkdirSync(p: string, o: object): void };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path') as { join(...p: string[]): string; resolve(...p: string[]): string };
const DIR = path.resolve(process.cwd(), '../../docs/map-styles');

describe('Faz 11 harita stilleri', () => {
  it('beş tema, her biri sabit başvuru; üç yeni tema JSON dosyasıyla aynı', () => {
    for (const id of THEME_IDS) expect(mapStyleFor(themeById(id))).toBe(MAP_STYLES[id]);
    for (const id of ['nude', 'blush', 'charcoal'] as const) {
      const file = path.join(DIR, `${id}.json`);
      const json = JSON.stringify(MAP_STYLES[id], null, 2) + '\n';
      if (process.env.WRITE_MAP_STYLES) {
        fs.mkdirSync(DIR, { recursive: true });
        fs.writeFileSync(file, json);
      }
      expect(fs.readFileSync(file, 'utf8')).toBe(json);
    }
  });

  it('Siyah/Gri: kitapçık katmanları ön karttan ve birbirinden ayrı; Pudra: çerçeve halkası tanımlı', () => {
    const c = themeById('charcoal').colors;
    expect(new Set([c.surface, c.deckLayer1, c.deckLayer2]).size).toBe(3);
    expect(c.bg).not.toBe('#000000');
    expect(themeById('blush').colors.ringHalo).not.toBe('transparent');
    expect(themeById('light').colors.ringHalo).toBe('transparent');
  });
});

describe('Faz 11 tema deposu', () => {
  afterEach(() => __resetThemePrefForTests());

  it('v1 kaydı taşınır; seçim anında depoya ve v2 kaydına geçer', async () => {
    await AsyncStorage.setItem(THEME_PREF_STORAGE_KEY, 'dark');
    await hydrateThemePref();
    expect(themePrefStore.getState().pref).toBe('dark');
    setThemePref('blush');
    expect(themePrefStore.getState().pref).toBe('blush');
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse((await AsyncStorage.getItem(THEME_SETTINGS_STORAGE_KEY)) ?? '{}').pref).toBe('blush');
  });

  it('saat kuralı: gündüz / gece temaları yerel saate göre çözülür', () => {
    setThemePref('schedule');
    setThemeSchedule({ day: 'nude', night: 'charcoal', day_start: 420, night_start: 1140 });
    const s = themePrefStore.getState();
    expect(resolveThemeId(s, 'light', new Date(2026, 10, 27, 10))).toBe('nude');
    expect(resolveThemeId(s, 'light', new Date(2026, 10, 27, 22))).toBe('charcoal');
  });
});
