/**
 * Faz 3 (yalnızca Android): uygulama pil optimizasyonunda mı? Haftalık / süresiz paylaşımda Doze ve üretici pil
 * yöneticisi ön plan servisini durdurabilir; kullanıcıya AYARLARA YÖNLENDİREN bir ipucu gösterilir.
 *
 * Mağaza politikası: `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` doğrudan istemi KULLANILMAZ (Play yalnızca belirli
 * uygulama türlerine izin verir [Varsayım: konum paylaşımı kabul edilmeyebilir]); yalnızca genel ayar ekranı açılır.
 */
import * as Battery from 'expo-battery';
import { Linking, Platform } from 'react-native';

export type BatteryOptimization = 'unrestricted' | 'optimized' | 'unknown';

export async function readBatteryOptimization(): Promise<BatteryOptimization> {
  if (Platform.OS !== 'android') return 'unknown';
  try {
    return (await Battery.isBatteryOptimizationEnabledAsync()) ? 'optimized' : 'unrestricted';
  } catch {
    return 'unknown';
  }
}

/** Pil optimizasyonu listesi (ya da uygulama ayarları). İzin İSTEMEZ. */
export async function openBatteryOptimizationSettings(): Promise<void> {
  if (Platform.OS === 'android') {
    try {
      await Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
      return;
    } catch {
      // bazı üretici ROM'larında yok
    }
  }
  await Linking.openSettings();
}
