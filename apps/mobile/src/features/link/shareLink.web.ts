/**
 * YALNIZCA web: "Paylaş" → Web Share API (mobil tarayıcı); yoksa ya da korumalı iframe reddederse bağlantı
 * panoya kopyalanır (expo-clipboard web: `navigator.clipboard`, olmazsa eski `execCommand('copy')` yolu).
 * Native karşılığı `shareLink.ts` (React Native `Share`).
 */
import * as Clipboard from 'expo-clipboard';

export type ShareLinkResult = 'shared' | 'copied' | 'failed';

export async function shareLinkUrl(url: string, message: string): Promise<ShareLinkResult> {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { share?: (d: ShareData) => Promise<void> }) : undefined;
  if (nav?.share) {
    try {
      await nav.share({ text: message, url });
      return 'shared';
    } catch (e) {
      // Kullanıcı vazgeçti: sessiz. Başka hata (izin yok, iframe): panoya düş.
      if ((e as { name?: string } | null)?.name === 'AbortError') return 'shared';
    }
  }
  try {
    return (await Clipboard.setStringAsync(url)) ? 'copied' : 'failed';
  } catch {
    return 'failed';
  }
}
