/**
 * Görünüm tercihi deposu. Faz 7: Açık / Koyu / Sistem. Faz 11: + Nude / Pudra Pembesi / Siyah-Gri paketleri ve
 * "Saate göre" kişisel ikili kural (core `ThemeSettings`). Cihazda tek JSON kaydında saklanır (v2; v1 taşınır).
 *
 * Anlık geçiş: `setThemePref` / `setThemeSchedule` depoyu aynı karede günceller; `useTheme` ve harita stili
 * (customMapStyle) yeniden başlatma olmadan değişir. Saat kuralında bir sonraki sınıra TEK zamanlayıcı kurulur
 * (`nextThemeSwitchAt`); uygulama ön plana dönünce de saat yeniden okunur (arka planda kaçan geçiş).
 */
import {
  DEFAULT_THEME_SETTINGS,
  nextThemeSwitchAt,
  parseThemeSettings,
  THEME_PREF_STORAGE_KEY,
  THEME_SETTINGS_STORAGE_KEY,
  type ThemePrefV2,
  type ThemeSchedule,
  type ThemeSettings,
} from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

interface ThemePrefState extends ThemeSettings {
  hydrated: boolean;
  /** Saat kuralı için "şimdi" (ms). Yalnızca sınır geçince / ön plana dönünce değişir → gereksiz çizim yok. */
  clock: number;
}

export const themePrefStore = createStore<ThemePrefState>()(() => ({ ...DEFAULT_THEME_SETTINGS, hydrated: false, clock: Date.now() }));

let hydrating: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let appStateSub: { remove: () => void } | null = null;

/** Saat kuralı zamanlayıcısı: bir sonraki geçiş anında `clock` ilerler. */
function armSchedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const s = themePrefStore.getState();
  const at = nextThemeSwitchAt(s, new Date());
  if (at === null) return;
  timer = setTimeout(() => {
    themePrefStore.setState({ clock: Date.now() });
    armSchedule();
  }, Math.max(1_000, at - Date.now() + 500));
  if (!appStateSub && typeof AppState?.addEventListener === 'function') {
    appStateSub = AppState.addEventListener('change', (st) => {
      if (st === 'active' && themePrefStore.getState().pref === 'schedule') {
        themePrefStore.setState({ clock: Date.now() });
        armSchedule();
      }
    });
  }
}

function persist(): void {
  const { pref, schedule } = themePrefStore.getState();
  void AsyncStorage.setItem(THEME_SETTINGS_STORAGE_KEY, JSON.stringify({ pref, schedule })).catch(() => undefined);
}

/** Bir kez diskten okur (ilk `useTheme` çağrısında da tetiklenir). */
export function hydrateThemePref(): Promise<void> {
  if (!hydrating) {
    hydrating = (async () => {
      try {
        const [v2, v1] = await Promise.all([AsyncStorage.getItem(THEME_SETTINGS_STORAGE_KEY), AsyncStorage.getItem(THEME_PREF_STORAGE_KEY)]);
        // Kullanıcı okuma bitmeden seçtiyse onun seçimi kalır.
        if (!themePrefStore.getState().hydrated) themePrefStore.setState({ ...parseThemeSettings(v2, v1), hydrated: true, clock: Date.now() });
      } catch {
        themePrefStore.setState({ hydrated: true });
      }
      armSchedule();
    })();
  }
  return hydrating;
}

export function setThemePref(pref: ThemePrefV2): void {
  themePrefStore.setState({ pref, hydrated: true, clock: Date.now() });
  persist();
  armSchedule();
}

/** Saat kuralını değiştirir (tercih `schedule` değilse yalnızca saklar). */
export function setThemeSchedule(patch: Partial<ThemeSchedule>): void {
  const schedule = { ...themePrefStore.getState().schedule, ...patch };
  themePrefStore.setState({ schedule, hydrated: true, clock: Date.now() });
  persist();
  armSchedule();
}

export function useThemePref(): ThemePrefV2 {
  if (!hydrating) void hydrateThemePref();
  return useStore(themePrefStore, (s) => s.pref);
}

export function useThemeSettings(): ThemePrefState {
  if (!hydrating) void hydrateThemePref();
  return useStore(themePrefStore);
}

/** Testler. */
export function __resetThemePrefForTests(): void {
  hydrating = null;
  if (timer) clearTimeout(timer);
  timer = null;
  themePrefStore.setState({ ...DEFAULT_THEME_SETTINGS, hydrated: false, clock: Date.now() });
}
