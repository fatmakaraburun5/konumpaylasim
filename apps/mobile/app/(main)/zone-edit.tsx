import { useLocalSearchParams } from 'expo-router';
import { ZoneEditScreen } from '../../src/features/zones/ZoneEditScreen';

/** Faz 5: bölge düzenleyici. `?id=<zone_id>` yoksa yeni bölge. */
export default function ZoneEditRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const zoneId = typeof id === 'string' && id.length > 0 ? id : null;
  // Kimlik değişince düzenleyici sıfırdan kurulsun (taslak durumu bölgeye bağlı).
  return <ZoneEditScreen key={zoneId ?? 'new'} zoneId={zoneId} />;
}
