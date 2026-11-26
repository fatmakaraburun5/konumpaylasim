/**
 * Faz 9: çevrimdışı SOS SMS yedeği — cihazın kendi SMS uygulamasında HAZIR DOLU mesaj (expo-sms).
 *
 *  - iOS: `MFMessageComposeViewController` (Mesajlar). iOS üçüncü taraf uygulamaların SMS'i kendiliğinden
 *    göndermesine izin vermez: kullanıcı Gönder'e dokunur. İzin gerekmez.
 *  - Android: `ACTION_SENDTO` (`smsto:`) — SEND_SMS izni GEREKMEZ (app.config `blockedPermissions`), uygulama SMS
 *    göndermez / okumaz. Android çoğu cihazda sonucu bildirmez (`unknown`).
 *  - SIM'siz cihaz / tablet: `isSmsAvailable()` false (Gizlilik Merkezi "Bu cihazda yok").
 */
export type SmsComposeResult = 'sent' | 'cancelled' | 'unknown';

/** SMS uygulaması kullanılamadığında `composeSms` bu hatayı atar. */
export class SmsUnavailableError extends Error {
  constructor() {
    super('Bu cihaz SMS gönderemiyor');
    this.name = 'SmsUnavailableError';
  }
}

type ExpoSms = typeof import('expo-sms');

function sms(): ExpoSms | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-sms') as ExpoSms;
  } catch {
    return null;
  }
}

/** Cihaz SMS oluşturabiliyor mu (hata = hayır). */
export async function isSmsAvailable(): Promise<boolean> {
  try {
    return (await sms()?.isAvailableAsync()) === true;
  } catch {
    return false;
  }
}

/** Mesaj uygulamasını alıcılar ve gövdeyle açar; kullanıcı gönderir. Kullanılamıyorsa `SmsUnavailableError`. */
export async function composeSms(numbers: readonly string[], body: string): Promise<SmsComposeResult> {
  const m = sms();
  if (!m || !(await isSmsAvailable())) throw new SmsUnavailableError();
  const r = await m.sendSMSAsync([...numbers], body);
  return r.result === 'sent' || r.result === 'cancelled' ? r.result : 'unknown';
}
