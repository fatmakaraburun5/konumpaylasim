/**
 * Sunucu eşitleme durumu (yalnızca arayüz): hangi dinleyici hata verip yeniden deneniyor.
 * Harita ekranı bunu bir uyarı şeridi olarak gösterir; paylaşım kartı yine de görünür ve "Durdur" çalışır.
 */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

export type SyncChannel = 'outgoing' | 'incoming' | 'inbox' | 'friends' | 'offset' | 'links';

interface SyncStatusState {
  failing: Partial<Record<SyncChannel, true>>;
  setHealthy: (channel: SyncChannel, healthy: boolean) => void;
  reset: () => void;
}

export const syncStatusStore = createStore<SyncStatusState>()((set) => ({
  failing: {},
  setHealthy: (channel, healthy) =>
    set((s) => {
      if (healthy === !s.failing[channel]) return s;
      const failing = { ...s.failing };
      if (healthy) delete failing[channel];
      else failing[channel] = true;
      return { failing };
    }),
  reset: () => set({ failing: {} }),
}));

export function useSyncStatus<T>(selector: (s: SyncStatusState) => T): T {
  return useStore(syncStatusStore, selector);
}
