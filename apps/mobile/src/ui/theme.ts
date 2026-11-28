import { resolveThemeId, THEME_IDS, type ColorScheme, type ThemeId } from '@konum/core';
import { useColorScheme } from 'react-native';
import { useStore } from 'zustand';
import { hydrateThemePref, themePrefStore } from './themePref';
import { darkTheme, lightTheme, THEMES, type Theme } from './tokens';

export { hydrateThemePref, setThemePref, setThemeSchedule, themePrefStore, useThemePref, useThemeSettings } from './themePref';

let hydrateStarted = false;

/** Etkin tema kimliği (tercih + cihaz şeması + saat kuralı). */
export function useThemeId(): ThemeId {
  if (!hydrateStarted) {
    hydrateStarted = true;
    void hydrateThemePref();
  }
  const system = useColorScheme();
  const sys = system === 'dark' ? 'dark' : system === 'light' ? 'light' : null;
  // Seçici skaler döndürür: saat ilerlese de tema aynıysa yeniden çizim yok.
  return useStore(themePrefStore, (s) => resolveThemeId(s, sys, new Date(s.clock)));
}

/**
 * Etkin tema. Faz 7: Açık / Koyu / Sistem; Faz 11: + Nude / Pudra Pembesi / Siyah-Gri ve saat kuralı. Tercih,
 * cihaz ayarı ya da kural sınırı değişince aynı karede yeniden çizilir (THEMES sabit nesneler).
 */
export function useTheme(): Theme {
  return THEMES[useThemeId()];
}

export const themeFor = (scheme: ColorScheme): Theme => (scheme === 'dark' ? darkTheme : lightTheme);
export const themeById = (id: ThemeId): Theme => THEMES[id];

/**
 * Google Haritalar özel stili (customMapStyle JSON): belirteçlerdeki harita renkleri.
 * Açık ve koyu tema için TAM stil: zemin, insan yapımı alan, park, su, yollar (otoyol dahil), toplu taşıma
 * çizgileri, idari sınırlar ve tüm etiket renkleri belirteçlerden gelir; koyu temada hiçbir öğe varsayılan
 * (açık) renkte kalmaz. Faz 7: iki stil modül yüklenirken BİR KEZ üretilir (`MAP_STYLES`); tema değişince harita
 * yalnızca dizi referansını değiştirir → native SDK stili yeniden yüklemeden, anında uygular.
 * Yer imleri (POI) ve toplu taşıma simgeleri gizlidir: haritada yalnızca kişiler öne çıksın.
 */
export type MapStyle = ReturnType<typeof buildMapStyle>;

export function mapStyleFor(theme: Pick<Theme, 'id'>): MapStyle {
  return MAP_STYLES[theme.id];
}

function buildMapStyle(theme: Theme) {
  const c = theme.colors;
  return [
    { elementType: 'geometry', stylers: [{ color: c.mapLand }] },
    { elementType: 'labels.text.fill', stylers: [{ color: c.mapLabel }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: c.mapLand }] },
    { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: c.mapRoadStroke }] },
    { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: c.text }] },
    { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
    { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: c.mapLand }] },
    { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: c.mapLand }] },
    { featureType: 'poi', elementType: 'geometry', stylers: [{ color: c.mapLand }] },
    { featureType: 'poi', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: c.mapPark }] },
    { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: c.mapLabel }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: c.mapRoad }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: c.mapRoadStroke }] },
    { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: c.mapLabel }] },
    { featureType: 'road', elementType: 'labels.text.stroke', stylers: [{ color: c.mapRoad }] },
    // Faz 11: sokak < cadde < otoyol kademesi (Siyah/Gri'de üç ayrı gri, Nude'da krem → kum).
    { featureType: 'road.local', elementType: 'geometry', stylers: [{ color: c.mapRoadMinor }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: c.mapHighway }] },
    { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: c.mapRoadStroke }] },
    { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: c.text }] },
    { featureType: 'transit', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit.line', elementType: 'geometry', stylers: [{ color: c.mapTransit }] },
    { featureType: 'transit.station', elementType: 'labels.text.fill', stylers: [{ color: c.mapLabel }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: c.mapWater }] },
    { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: c.mapLabel }] },
    { featureType: 'water', elementType: 'labels.text.stroke', stylers: [{ color: c.mapWater }] },
  ];
}

/**
 * Tüm temaların harita stilleri (Faz 11: beş tema). Modül yüklenirken BİR KEZ üretilen sabit diziler: tema
 * değişince MapView yalnızca `customMapStyle` referansını değiştirir → native SDK yeni stili haritayı yeniden
 * oluşturmadan, aynı karede uygular (Android `MapStyleOptions`, iOS `GMSMapStyle`). JSON kopyaları
 * docs/map-styles/*.json (Cloud Console / Map ID'ye yapıştırmak için; test eşitliği denetler).
 */
export const MAP_STYLES: Readonly<Record<ThemeId, MapStyle>> = Object.freeze(
  Object.fromEntries(THEME_IDS.map((id) => [id, buildMapStyle(THEMES[id])])) as Record<ThemeId, MapStyle>,
);
