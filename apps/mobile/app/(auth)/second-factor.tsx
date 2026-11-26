import { Redirect } from 'expo-router';
import { SecondFactorScreen } from '../../src/features/auth/SecondFactorScreen';
import { useAuthStore } from '../../src/state/authStore';

/** Faz 10: yeni telefonda e-posta kodu (2. aşama). */
export default function SecondFactorRoute() {
  const status = useAuthStore((s) => s.status);
  if (status === 'signedOut') return <Redirect href="/phone" />;
  if (status === 'bootstrapping' || status === 'needsProfile') return <Redirect href="/name" />;
  return <SecondFactorScreen />;
}
