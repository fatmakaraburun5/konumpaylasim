import { useLocalSearchParams } from 'expo-router';
import { EventDetailScreen } from '../../../src/features/events/EventDetailScreen';

/** Faz 7: etkinlik kartı (3 aşamalı oylama). Bildirime dokunma ve liste buraya açar. */
export default function EventDetailRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const eventId = typeof id === 'string' ? id : '';
  return <EventDetailScreen key={eventId} eventId={eventId} />;
}
