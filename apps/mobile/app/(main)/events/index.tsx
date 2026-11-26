import { useLocalSearchParams } from 'expo-router';
import { EventsScreen } from '../../../src/features/events/EventsScreen';

/** Faz 7: Etkinlik Alanı (liste + bildirim kutusu). `?tab=notices` bildirimleri açar. */
export default function EventsRoute() {
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  return <EventsScreen initialTab={tab === 'notices' ? 'notices' : 'events'} />;
}
