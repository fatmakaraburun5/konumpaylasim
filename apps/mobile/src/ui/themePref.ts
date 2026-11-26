/**
 * Faz 7: görünüm tercihi deposu (Açık / Koyu / Sistem; core `appearance.ts`). Cihazda saklanır (hesaptan bağımsız).
 * Açılışta diskten okunur; okunana kadar `system` geçerlidir (ilk karede cihaz teması). `setThemePref` anında
 * uygular: `useTheme` ve harita stili aynı karede değişir.
 */
import { DEFAULT_THEME_PREF, parseThemePref, THEME_PREF_STORAGE_KEY, type ThemePref } from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

interface ThemePrefState {
  pref: ThemePref;
  hydrated: boolean;
}

export const themePrefStore = createStore<ThemePrefState>()(() => ({ pref: DEFAULT_THEME_PREF, hydrated: false }));

let hydrating: Promise<void> | null = null;

/** Bir kez diskten okur (ilk `useTheme` çağrısında da tetiklenir). */
export function hydrateThemePref(): Promise<void> {
  if (!hydrating) {
    hydrating = (async () => {
      try {
        const raw = await AsyncStorage.getItem(THEME_PREF_STORAGE_KEY);
        // Kullanıcı okuma bitmeden seçtiyse onun seçimi kalır.
        if (!themePrefStore.getState().hydrated) themePrefStore.setState({ pref: parseThemePref(raw), hydrated: true });
      } catch {
        themePrefStore.setState({ hydrated: true });
      }
    })();
  }
  return hydrating;
}

export function setThemePref(pref: ThemePref): void {
  themePrefStore.setState({ pref, hydrated: true });
  void AsyncStorage.setItem(THEME_PREF_STORAGE_KEY, pref).catch(() => undefined);
}

export function useThemePref(): ThemePref {
  if (!hydrating) void hydrateThemePref();
  return useStore(themePrefStore, (s) => s.pref);
}

/** Testler. */
export function __resetThemePrefForTests(): void {
  hydrating = null;
  themePrefStore.setState({ pref: DEFAULT_THEME_PREF, hydrated: false });
}
