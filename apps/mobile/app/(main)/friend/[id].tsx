import { useLocalSearchParams } from 'expo-router';
import { PersonPermissionsScreen } from '../../../src/features/access/PersonPermissionsScreen';

/** Faz 8: Arkadaşlar > kişi → "Kişi izinleri" (verdiğim ve bana verilen izinler). */
export default function FriendPermissionsRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const uid = typeof id === 'string' ? id : '';
  return <PersonPermissionsScreen key={uid} friendId={uid} />;
}
