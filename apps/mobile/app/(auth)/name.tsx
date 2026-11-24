import { Redirect } from 'expo-router';
import { ProfileNameScreen } from '../../src/features/auth/ProfileNameScreen';
import { useAuthStore } from '../../src/state/authStore';

export default function NameRoute() {
  const status = useAuthStore((s) => s.status);
  if (status === 'signedOut') return <Redirect href="/phone" />;
  return <ProfileNameScreen />;
}
