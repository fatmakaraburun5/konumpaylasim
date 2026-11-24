/** Kendi konumum (yalnızca arayüz için, bellekte) ve arka plan takibinin durumu. */
import type { TrackingProfileId } from '@konum/core';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

export interface MyPosition {
  lat: number;
  lng: number;
  accuracy: number | null;
  timestamp: number;
}

interface LocationState {
  myPosition: MyPosition | null;
  trackingProfile: TrackingProfileId;
  /** Takip başlatılamadıysa kullanıcıya gösterilecek metin (ör. izin geri alındı). */
  trackingError: string | null;
  setMyPosition: (p: MyPosition) => void;
  setTracking: (profile: TrackingProfileId, error?: string | null) => void;
  reset: () => void;
}

export const locationStore = createStore<LocationState>()((set) => ({
  myPosition: null,
  trackingProfile: 'off',
  trackingError: null,
  setMyPosition: (p) => set({ myPosition: p }),
  setTracking: (profile, error = null) => set({ trackingProfile: profile, trackingError: error }),
  reset: () => set({ myPosition: null, trackingProfile: 'off', trackingError: null }),
}));

export function useLocationStore<T>(selector: (s: LocationState) => T): T {
  return useStore(locationStore, selector);
}
