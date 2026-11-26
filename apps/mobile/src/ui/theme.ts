import { resolveColorScheme, type ColorScheme } from '@konum/core';
import { useColorScheme } from 'react-native';
import { useThemePref } from './themePref';
import { darkTheme, lightTheme, type Theme } from './tokens';

export { hydrateThemePref, setThemePref, themePrefStore, useThemePref } from './themePref';

/**
 * Etkin tema: Faz 7 görünüm tercihi (Açık / Koyu / Sistem). `system` cihaz ayarını (useColorScheme) izler; cihaz
 * ayarı ya da tercih değişince aynı karede yeniden çizilir.
 */
export function useTheme(): Theme {
  const system = useColorScheme();
  const pref = useThemePref();
  return resolveColorScheme(pref, system === 'dark' ? 'dark' : system === 'light' ? 'light' : null) === 'dark' ? darkTheme : lightTheme;
}

export const themeFor = (scheme: ColorScheme): Theme => (scheme === 'dark' ? darkTheme : lightTheme);

/**
 * Google Haritalar özel stili (customMapStyle JSON): belirteçlerdeki harita renkleri.
 * Açık ve koyu tema için TAM stil: zemin, insan yapımı alan, park, su, yollar (otoyol dahil), toplu taşıma
 * çizgileri, idari sınırlar ve tüm etiket renkleri belirteçlerden gelir; koyu temada hiçbir öğe varsayılan
 * (açık) renkte kalmaz. Faz 7: iki stil modül yüklenirken BİR KEZ üretilir (`MAP_STYLES`); tema değişince harita
 * yalnızca dizi referansını değiştirir → native SDK stili yeniden yüklemeden, anında uygular.
 * Yer imleri (POI) ve toplu taşıma simgeleri gizlidir: haritada yalnızca kişiler öne çıksın.
 */
export type MapStyle = ReturnType<typeof buildMapStyle>;

export function mapStyleFor(theme: Pick<Theme, 'scheme'>): MapStyle {
  return MAP_STYLES[theme.scheme];
}

function buildMapStyle(theme: Theme) {
  const c = theme.colors;
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

/** Açık ve koyu harita stilleri (sabit diziler: referans eşitliği → gereksiz yeniden uygulama yok). */
export const MAP_STYLES: Readonly<Record<ColorScheme, ReturnType<typeof buildMapStyle>>> = Object.freeze({
  light: buildMapStyle(lightTheme),
  dark: buildMapStyle(darkTheme),
});
