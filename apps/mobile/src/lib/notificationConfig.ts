/**
 * Faz 4: iOS Critical Alerts bayrağı (`app.config.ts` → `extra.iosCriticalAlerts`, ortam değişkeni
 * `IOS_CRITICAL_ALERTS=1`). Apple'ın `com.apple.developer.usernotifications.critical-alerts` yetkisi onaylanmadan
 * AÇILMAMALI (yetkisiz derleme imzalanamaz). Kapalıyken SOS `time-sensitive` düzeyindedir. [Varsayım: Apple onayı]
 */
import Constants from 'expo-constants';

export function iosCriticalAlertsEnabled(): boolean {
  try {
    return (Constants.expoConfig?.extra as { iosCriticalAlerts?: unknown } | undefined)?.iosCriticalAlerts === true;
  } catch {
    return false;
  }
}
