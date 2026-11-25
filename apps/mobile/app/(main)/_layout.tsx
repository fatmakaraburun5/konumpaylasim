import { Redirect, Stack } from 'expo-router';
import { useEffect } from 'react';
import { GenderGate } from '../../src/features/profile/GenderGate';
import { QuickShareSheet } from '../../src/features/quickShare/QuickShareSheet';
import { startSessionServices } from '../../src/services/sharingCoordinator';
import { useAuthStore } from '../../src/state/authStore';

/**
 * Kimlik kapısı + oturum servisleri: Firestore/RTDB dinleyicileri, yayın hedefleri → konum takibi,
 * bildirim planlama. Oturum kapanınca hepsi sökülür.
 *
 * Faz 6: cinsiyeti olmayan eski (Faz 1–5) hesap engelleyici `GenderGate` görür (servisler çalışmaya devam eder:
 * süren paylaşımlar kesilmez). Widget derin bağlantısının onay kartı (QuickShareSheet) her ekranın üstündedir.
 */
export default function MainLayout() {
  const status = useAuthStore((s) => s.status);
  const uid = useAuthStore((s) => s.uid);
  const needsGender = useAuthStore((s) => s.status === 'ready' && !!s.profile && s.profile.gender === null);

  useEffect(() => {
    if (status !== 'ready' || !uid) return;
    return startSessionServices(uid);
  }, [status, uid]);

  if (status === 'initializing') return null;
  if (status !== 'ready') return <Redirect href={status === 'signedOut' ? '/phone' : '/name'} />;
  if (needsGender) return <GenderGate />;
  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="friends" />
        <Stack.Screen name="zones" />
        <Stack.Screen name="zone-edit" />
        <Stack.Screen name="profile" />
      </Stack>
      <QuickShareSheet />
    </>
  );
}
