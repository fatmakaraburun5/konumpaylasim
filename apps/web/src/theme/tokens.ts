/**
 * Tasarım belirteçleri: mobil `apps/mobile/src/ui/tokens.ts` ile BİREBİR aynı değerler
 * (CSS karşılıkları `src/styles.css` → `:root`). Değiştirilecekse iki yerde birlikte değişir.
 */
import { useEffect, useState } from 'react';

export interface MapColors {
  text: string;
  textSecondary: string;
  border: string;
  surfaceAlt: string;
  mapWater: string;
  mapPark: string;
  mapRoad: string;
  mapLand: string;
}

export const lightMap: MapColors = {
  text: '#0F172A',
  textSecondary: '#475569',
  border: '#E2E8F0',
  surfaceAlt: '#EEF2F6',
  mapWater: '#CFE3F5',
  mapPark: '#DDEFD9',
  mapRoad: '#FFFFFF',
  mapLand: '#EEF1F4',
};

export const darkMap: MapColors = {
  text: '#E5E7EB',
  textSecondary: '#A3B1C6',
  border: '#22304D',
  surfaceAlt: '#18233B',
  // [Varsayım: tasarım onayı bekliyor] mobil ile aynı koyu harita renkleri.
  mapWater: '#0E2A47',
  mapPark: '#10291E',
  mapRoad: '#1E2B44',
  mapLand: '#0F172A',
};

export type ColorScheme = 'light' | 'dark';

/** Google Maps JS `styles` (mobil `mapStyleFor` ile aynı kural: POI ve toplu taşıma simgeleri gizli). */
export function mapStyleFor(c: MapColors): google.maps.MapTypeStyle[] {
  return [
    { elementType: 'geometry', stylers: [{ color: c.mapLand }] },
    { elementType: 'labels.text.fill', stylers: [{ color: c.textSecondary }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: c.mapLand }] },
    { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: c.border }] },
    { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: c.text }] },
    { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
    { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: c.mapLand }] },
    { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: c.mapLand }] },
    { featureType: 'poi', elementType: 'geometry', stylers: [{ color: c.mapLand }] },
    { featureType: 'poi', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: c.mapPark }] },
    { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: c.textSecondary }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: c.mapRoad }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: c.border }] },
    { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: c.textSecondary }] },
    { featureType: 'road', elementType: 'labels.text.stroke', stylers: [{ color: c.mapRoad }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: c.surfaceAlt }] },
    { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: c.border }] },
    { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: c.text }] },
    { featureType: 'transit', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit.line', elementType: 'geometry', stylers: [{ color: c.border }] },
    { featureType: 'transit.station', elementType: 'labels.text.fill', stylers: [{ color: c.textSecondary }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: c.mapWater }] },
    { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: c.textSecondary }] },
    { featureType: 'water', elementType: 'labels.text.stroke', stylers: [{ color: c.mapWater }] },
  ];
}

const darkQuery = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

/** Cihazın açık / koyu ayarı; değişince canlı güncellenir. */
export function useColorScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(() => (darkQuery()?.matches ? 'dark' : 'light'));
  useEffect(() => {
    const q = darkQuery();
    if (!q) return;
    const on = () => setScheme(q.matches ? 'dark' : 'light');
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return scheme;
}
