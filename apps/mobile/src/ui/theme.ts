import { useColorScheme } from 'react-native';
import { darkTheme, lightTheme, type Theme } from './tokens';

/** Açık/koyu tema cihaz ayarından (useColorScheme) seçilir. */
export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}

/**
 * Google Haritalar özel stili (customMapStyle): belirteçlerdeki harita renkleri.
 * Açık ve koyu tema için TAM stil: zemin, insan yapımı alan, park, su, yollar (otoyol dahil), toplu taşıma
 * çizgileri, idari sınırlar ve tüm etiket renkleri belirteçlerden gelir; koyu temada hiçbir öğe varsayılan
 * (açık) renkte kalmaz. `useColorScheme` değişince MapCanvas stili canlı olarak değiştirir.
 * Yer imleri (POI) ve toplu taşıma simgeleri gizlidir: haritada yalnızca kişiler öne çıksın.
 */
export function mapStyleFor(theme: Theme) {
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
