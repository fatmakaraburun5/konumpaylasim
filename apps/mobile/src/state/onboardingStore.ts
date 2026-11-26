/**
 * Faz 7: ilk açılış izin akışı durumu (cihaz düzeyinde; core `ONBOARDING_STORAGE_KEY`, `ONBOARDING_VERSION`).
 * Akış sözleşme onayından sonra bir kez gösterilir; her adım "Şimdi değil" ile geçilebilir ve hiçbir paylaşımı
 * engellemez. Sürüm yükselirse (yeni izin adımı) yeniden gösterilir. Çıkışta SİLİNMEZ (izinler cihaza aittir).
 */
import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION, type OnboardingStep } from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

interface OnboardingState {
  hydrated: boolean;
  completed: boolean;
  /** Bu akışta geçilen adımlar (bellekte; yarıda kapanırsa baştan, ama verilmiş izinler atlanır). */
  done: OnboardingStep[];
  hydrate(): Promise<void>;
  markDone(step: OnboardingStep): void;
  complete(): void;
  /** Gizlilik Merkezi'nden "Kurulum rehberini yeniden göster". */
  restart(): void;
}

export const onboardingStore = createStore<OnboardingState>()((set, get) => ({
  hydrated: false,
  completed: false,
  done: [],

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(ONBOARDING_STORAGE_KEY);
      const v = raw ? (JSON.parse(raw) as { version?: unknown }) : null;
      set({ hydrated: true, completed: typeof v?.version === 'number' && v.version >= ONBOARDING_VERSION });
    } catch {
      // Okunamazsa akış gösterilmez (kullanıcıyı engellemeyelim); izinler ihtiyaç anında istenir.
      set({ hydrated: true, completed: true });
    }
  },
  markDone: (step) => set((s) => (s.done.includes(step) ? {} : { done: [...s.done, step] })),
  complete: () => {
    set({ completed: true });
    void AsyncStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ version: ONBOARDING_VERSION, at: Date.now() })).catch(() => undefined);
  },
  restart: () => set({ completed: false, done: [] }),
}));

export function useOnboardingStore<T>(selector: (s: OnboardingState) => T): T {
  return useStore(onboardingStore, selector);
}
