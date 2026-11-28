/**
 * Kök yerleşim: GestureHandlerRootView → SafeAreaProvider → BottomSheetModalProvider → Stack.
 * Kimlik kapısı grup yerleşimlerindedir: (main) yalnızca `ready` iken, (auth) diğer durumlarda açılır.
 *
 * Faz 2: `s/[token]` (QR / paylaşım bağlantısı) kök düzeydedir, kimlik kapısının DIŞINDA: uygulama kuruluysa
 * `https://<LINK_DOMAIN>/s/<token>` (Universal Links / App Links, bkz. app.config.ts) ve `konum://s/<token>`
 * oturum açmadan da salt okunur canlı haritayı açar. Uygulama kurulu değilse aynı URL web haritasında açılır.
 * Faz 6: `quick-share` (widget'ın uygulamayı açtığı bağlantı) da kök düzeydedir; isteği kaydedip ana ekrana döner.
 */
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
// Çıkış temizliği (takip durdurma, kalıcı veriyi silme) kaydı modül yüklenirken yapılır.
import '../src/services/sharingCoordinator';
import { DemoShell } from '../src/demo/shell/DemoShell';
import { authStore, useAuthStore } from '../src/state/authStore';
import { useTheme } from '../src/ui';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  const theme = useTheme();
  const status = useAuthStore((s) => s.status);

  useEffect(() => authStore.getState().init(), []);
  useEffect(() => {
    if (status !== 'initializing') void SplashScreen.hideAsync().catch(() => undefined);
  }, [status]);

  // DemoShell: native'de çocukları olduğu gibi döndürür; yalnızca web önizlemesinde telefon çerçevesi + demo paneli.
  return (
    <DemoShell>
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <SafeAreaProvider>
        <BottomSheetModalProvider>
          <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
          {/* Gezgin her zaman bağlı kalır (yönlendirmeler için); açılışta durum belli olana kadar açılış ekranı görünür. */}
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.bg } }}>
            <Stack.Screen name="(main)" />
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="s/[token]" options={{ animation: 'fade' }} />
            {/* Faz 6: widget derin bağlantısı; isteği bırakıp hemen geri döner (bkz. app/quick-share.tsx). */}
            <Stack.Screen name="quick-share" options={{ animation: 'none' }} />
            {/* Faz 12: kilit ekranı canlı sayacı eylemleri (Mola / Devam et / Durdur). */}
            <Stack.Screen name="live" options={{ animation: 'none' }} />
          </Stack>
        </BottomSheetModalProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
    </DemoShell>
  );
}
