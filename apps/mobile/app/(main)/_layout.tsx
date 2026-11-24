import { Redirect, Stack } from 'expo-router';
import { useEffect } from 'react';
import { startSessionServices } from '../../src/services/sharingCoordinator';
import { useAuthStore } from '../../src/state/authStore';

/**
 * Kimlik kapısı + oturum servisleri: Firestore/RTDB dinleyicileri, yayın hedefleri → konum takibi,
 * bildirim planlama. Oturum kapanınca hepsi sökülür.
 */
export default function MainLayout() {
  const status = useAuthStore((s) => s.status);
  const uid = useAuthStore((s) => s.uid);

  useEffect(() => {
    if (status !== 'ready' || !uid) return;
    return startSessionServices(uid);
  }, [status, uid]);

  if (status === 'initializing') return null;
  if (status !== 'ready') return <Redirect href={status === 'signedOut' ? '/phone' : '/name'} />;
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="friends" />
      <Stack.Screen name="zones" />
      <Stack.Screen name="zone-edit" />
    </Stack>
  );
}
