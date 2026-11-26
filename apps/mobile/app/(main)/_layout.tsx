import { Redirect, Stack } from 'expo-router';
import { useEffect } from 'react';
import { ConsentGate } from '../../src/features/consent/ConsentScreen';
import { InvisibleRestoreSheet } from '../../src/features/invisible/InvisibleRestoreSheet';
import { ApproveLocationRequestSheet } from '../../src/features/locationRequest/ApproveLocationRequestSheet';
import { OnboardingFlow } from '../../src/features/onboarding/OnboardingFlow';
import { GenderGate } from '../../src/features/profile/GenderGate';
import { QuickShareSheet } from '../../src/features/quickShare/QuickShareSheet';
import { startGateServices, startSessionServices } from '../../src/services/sharingCoordinator';
import { useAuthStore, useNeedsConsent } from '../../src/state/authStore';
import { onboardingStore, useOnboardingStore } from '../../src/state/onboardingStore';

/**
 * Kimlik kapısı + oturum servisleri: Firestore/RTDB dinleyicileri, yayın hedefleri → konum takibi,
 * bildirim planlama. Oturum kapanınca hepsi sökülür.
 *
 * Faz 6: cinsiyeti olmayan eski (Faz 1–5) hesap engelleyici `GenderGate` görür (servisler çalışmaya devam eder:
 * süren paylaşımlar kesilmez). Widget derin bağlantısının onay kartı (QuickShareSheet) her ekranın üstündedir.
 *
 * Faz 7: sözleşme onayından sonra ilk açılış izin akışı (OnboardingFlow, bir kez); Etkinlik Alanı ve İzin & Gizlilik
 * Merkezi ekranları.
 *
 * Faz 8: güncel Güvenlik Sözleşmesi / KVKK onayı yoksa (`useNeedsConsent`) oturum servisleri BAŞLAMAZ ve yayın
 * kesilir (publishHold); onay kapısı (ConsentGate) burada gösterilir, onaylanınca servisler başlar. Kapı açıkken
 * yalnızca onaydan muaf koruyucu yeniden denemeler sürer (`startGateServices`: bekleyen durdurmalar, görünmez olma
 * isteği, konum izni geri almaları); kapıdaki "Paylaşımlarımı durdur ve görünmez ol" onay vermeden tüm paylaşımları ve
 * QR bağlantılarını bitirir. Görünür olurken
 * geri yükleme sayfası (InvisibleRestoreSheet; Profil ve harita şeridi açar) her ekranın üstündedir.
 */
export default function MainLayout() {
  const status = useAuthStore((s) => s.status);
  const uid = useAuthStore((s) => s.uid);
  const needsGender = useAuthStore((s) => s.status === 'ready' && !!s.profile && s.profile.gender === null);
  const needsConsent = useNeedsConsent();
  const onboardingPending = useOnboardingStore((s) => s.hydrated && !s.completed);

  useEffect(() => {
    void onboardingStore.getState().hydrate();
  }, []);

  useEffect(() => {
    if (status !== 'ready' || !uid) return;
    return needsConsent ? startGateServices(uid) : startSessionServices(uid);
  }, [status, uid, needsConsent]);

  if (status === 'initializing') return null;
  if (status !== 'ready') return <Redirect href={status === 'signedOut' ? '/phone' : '/name'} />;
  if (needsGender) return <GenderGate />;
  // Faz 8: onay kapısı (cinsiyet kapısından sonra; servisler onaydan sonra başlar).
  if (needsConsent) return <ConsentGate />;
  // Faz 7: ilk açılış izin akışı (bir kez; servisler zaten çalışır, paylaşım engellenmez).
  if (onboardingPending) return <OnboardingFlow />;
  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="friends" />
        <Stack.Screen name="zones" />
        <Stack.Screen name="zone-edit" />
        <Stack.Screen name="profile" />
        <Stack.Screen name="consent" />
        <Stack.Screen name="friend/[id]" />
        {/* Faz 7 */}
        <Stack.Screen name="events/index" />
        <Stack.Screen name="events/new" options={{ presentation: 'modal' }} />
        <Stack.Screen name="events/[id]" />
        <Stack.Screen name="privacy" />
      </Stack>
      <QuickShareSheet />
      <InvisibleRestoreSheet />
      {/* Konum İste: Onayla → süre seçici (bildirimden de açılır). */}
      <ApproveLocationRequestSheet />
    </>
  );
}
