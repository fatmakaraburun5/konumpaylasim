/**
 * Türkçe saat ekleri artık core'da (`dativeSuffixForClock`, `untilClock`); core `formatExpiryLabel`
 * doğru eki kendisi üretir. `fixUntilSuffix` eski çağrı yerleri için kalır ve doğru metinde etkisizdir.
 */
import { dativeSuffixForClock, untilClock } from '@konum/core';

export { dativeSuffixForClock, untilClock };

/** "HH:MM'e kadar" kalıbını doğru ekle yeniden yazar (idempotent). */
export function fixUntilSuffix(label: string): string {
  return label.replace(/(\d{1,2}:\d{2})'e kadar/g, (_all, clock: string) => `${clock}'${dativeSuffixForClock(clock)} kadar`);
}
