import { Redirect } from 'expo-router';
import { OtpScreen } from '../../src/features/auth/OtpScreen';
import { useAuthStore } from '../../src/state/authStore';

export default function OtpRoute() {
  const status = useAuthStore((s) => s.status);
  const hasConfirmation = useAuthStore((s) => s.confirmation !== null);
  if (status === 'bootstrapping' || status === 'needsProfile') return <Redirect href="/name" />;
  if (!hasConfirmation) return <Redirect href="/phone" />;
  return <OtpScreen />;
}
