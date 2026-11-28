/**
 * Faz 12: kilit ekranı canlı sayacına giden ETA. Haritada bir arkadaşa / noktaya rota açıkken (EtaCard) MapHome
 * son sonucu buraya yazar; kart kapanınca silinir. Mutlak varış saatidir: kilit ekranında dakika yerelde akar,
 * LIVE_ETA_STALE_MS'den eski sonuç gösterilmez. Koordinat YOK.
 */
import type { LiveEta } from '@konum/core';
import { createStore } from 'zustand/vanilla';

export const liveEtaStore = createStore<{ eta: LiveEta | null; set: (e: LiveEta | null) => void }>()((set) => ({
  eta: null,
  set: (eta) => set({ eta }),
}));
