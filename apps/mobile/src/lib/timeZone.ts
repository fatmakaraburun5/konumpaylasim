import { getCalendars } from 'expo-localization';

/** [Varsayım] Cihaz dilimi okunamazsa Türkiye varsayılır (Faz 1 yalnızca TR numaralarıyla açılıyor). */
const FALLBACK_TZ = 'Europe/Istanbul';

/** IANA saat dilimi; sunucu "gün sonuna kadar" hesabını bununla yapar. */
export function deviceTimeZone(): string {
  try {
    return getCalendars()[0]?.timeZone ?? FALLBACK_TZ;
  } catch {
    return FALLBACK_TZ;
  }
}
