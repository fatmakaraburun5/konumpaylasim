import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '../../src/state/authStore';

/** Kimlik kapısı: oturum hazırsa ana gruba yönlendir. */
export default function AuthLayout() {
  const status = useAuthStore((s) => s.status);
  if (status === 'ready') return <Redirect href="/" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
