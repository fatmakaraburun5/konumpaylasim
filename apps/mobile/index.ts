/**
 * Uygulama giriş noktası (package.json "main"). SIRA ÖNEMLİDİR:
 *
 * 1. `react-native-get-random-values`: core `uuidV4` ve davet kodu üretimi `crypto.getRandomValues` ister.
 * 2. Arka plan görevleri (`TaskManager.defineTask`) HERHANGİ BİR ŞEY RENDER EDİLMEDEN ÖNCE tanımlanmalı:
 *    işletim sistemi uygulamayı arka planda uyandırdığında React ağacı hiç kurulmaz, yalnızca bu dosya
 *    çalışır. Görev o an tanımlı değilse konum güncellemesi / bildirim eylemi kaybolur.
 * 3. FCM arka plan mesaj işleyicisi de aynı nedenle üst seviyede kaydedilir.
 * 4. En son expo-router girişi (kök bileşeni kaydeder).
 */
import 'react-native-get-random-values';
import './src/services/location/backgroundTask';
import './src/services/notifications/backgroundNotificationTask';
import './src/services/notifications/registerBackgroundMessages';
import 'expo-router/entry';
