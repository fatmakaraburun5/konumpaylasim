/**
 * Web demo: pil optimizasyonu yalnızca Android'de anlamlıdır; demo iOS'u simüle eder (native ile aynı dışa aktarımlar).
 * `expo-battery` web paketine girmez.
 */
import { openDemoSettings } from '../../demo/web/permissions';

export type BatteryOptimization = 'unrestricted' | 'optimized' | 'unknown';

export async function readBatteryOptimization(): Promise<BatteryOptimization> {
  return 'unknown';
}

export async function openBatteryOptimizationSettings(): Promise<void> {
  await openDemoSettings();
}
