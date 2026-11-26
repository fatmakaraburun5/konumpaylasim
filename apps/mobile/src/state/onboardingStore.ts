/**
 * Faz 7: ilk açılış izin akışı durumu (cihaz düzeyinde; core `ONBOARDING_STORAGE_KEY`, `ONBOARDING_VERSION`).
 * Akış sözleşme onayından sonra bir kez gösterilir; her adım "Şimdi değil" ile geçilebilir ve hiçbir paylaşımı
 * engellemez. Sürüm yükselirse (yeni izin adımı) yeniden gösterilir. Çıkışta SİLİNMEZ (izinler cihaza aittir).
 *
 * Faz 9 (`ONBOARDING_VERSION = 2`, anahtar `konum.onboarding.v1` aynı kalır; kayıt `version` taşır): v1'i bitirmiş
 * kullanıcıya yalnızca yeni adımlar (rehber, SMS yedeği) bir kez gösterilir — eski adımlar core
 * `onboardingDoneForUpgrade` ile `done` sayılır, hoş geldin ekranı tekrarlanmaz. Akış `nextOnboardingStep`'e
 * `smsFallbackDecided` (smsFallbackStore `selectSmsFallbackDecided`) geçirmelidir.
 */
import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION, onboardingDoneForUpgrade, type OnboardingStep } from '@konum/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

export interface OnboardingState {
  hydrated: boolean;
  completed: boolean;
  /** Bu akışta geçilen adımlar (bellekte; yarıda kapanırsa baştan, ama verilmiş izinler atlanır). */
  done: OnboardingStep[];
  /** Kayıttaki sürüm (yoksa null): v1 → v2 yükseltmesi mi. */
  previousVersion: number | null;
  hydrate(): Promise<void>;
  markDone(step: OnboardingStep): void;
  complete(): void;
  /** Gizlilik Merkezi'nden "Kurulum rehberini yeniden göster". */
  restart(): void;
}

/** Kayıt → akış durumu (saf; test edilir). */
export function onboardingFromRecord(raw: unknown): Pick<OnboardingState, 'completed' | 'done' | 'previousVersion'> {
  const v = raw && typeof raw === 'object' ? (raw as { version?: unknown }) : null;
  const version = typeof v?.version === 'number' ? v.version : null;
  if (version === null) return { completed: false, done: [], previousVersion: null };
  if (version >= ONBOARDING_VERSION) return { completed: true, done: [], previousVersion: version };
  // Eski sürümün akışı bitirilmişti (kayıt yalnızca `complete()` ile yazılır): yalnızca yeni adımlar kalır.
  return { completed: false, done: onboardingDoneForUpgrade(version, ['done']), previousVersion: version };
}

export const onboardingStore = createStore<OnboardingState>()((set, get) => ({
  hydrated: false,
  completed: false,
  done: [],
  previousVersion: null,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(ONBOARDING_STORAGE_KEY);
      set({ hydrated: true, ...onboardingFromRecord(raw ? JSON.parse(raw) : null) });
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
