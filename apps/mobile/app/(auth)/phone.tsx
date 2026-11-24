import { Redirect } from 'expo-router';
import { PhoneEntry } from '../../src/features/auth/PhoneEntry';
import { useAuthStore } from '../../src/state/authStore';

export default function PhoneRoute() {
  const status = useAuthStore((s) => s.status);
  if (status === 'bootstrapping' || status === 'needsProfile') return <Redirect href="/name" />;
  return <PhoneEntry />;
}
