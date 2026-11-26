/**
 * Web demo: çevrimdışı SOS SMS yedeği — telefon çerçevesinde simüle iOS "Mesajlar" ekranı (hazır dolu alıcılar +
 * gövde; "Gönder" / "Vazgeç"). Native `smsComposer.ts` (expo-sms) ile aynı API. Demo bir iPhone'u taklit eder:
 * SMS her zaman kullanılabilir. Sonuç demo sunucusunun SMS günlüğüne yazılır (gerçekte içerik bize ulaşmaz).
 */
import { demoServer } from '../../demo/server';
import { openDemoSmsComposer } from '../../demo/web/f9Sim';

export type SmsComposeResult = 'sent' | 'cancelled' | 'unknown';

export class SmsUnavailableError extends Error {
  constructor() {
    super('Bu cihaz SMS gönderemiyor');
    this.name = 'SmsUnavailableError';
  }
}

export async function isSmsAvailable(): Promise<boolean> {
  return true;
}

export async function composeSms(numbers: readonly string[], body: string): Promise<SmsComposeResult> {
  if (numbers.length === 0) throw new SmsUnavailableError();
  const r = await openDemoSmsComposer(numbers, body);
  try {
    demoServer().logSms(numbers, body, r);
  } catch {
    // günlük yalnızca demo paneli içindir
  }
  return r;
}
