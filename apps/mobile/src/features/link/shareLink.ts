/**
 * QR sayfasındaki "Paylaş": sistem paylaşım sayfası (React Native `Share`). Web önizlemesi aynı adla
 * `shareLink.web.ts` sağlar (Web Share API yoksa bağlantıyı panoya kopyalar).
 */
import { Share } from 'react-native';

/** `'shared'`: paylaşım sayfası açıldı (ya da kullanıcı kapattı) · `'copied'`: yerine panoya kopyalandı. */
export type ShareLinkResult = 'shared' | 'copied' | 'failed';

export async function shareLinkUrl(url: string, message: string): Promise<ShareLinkResult> {
  try {
    await Share.share({ message, url });
    return 'shared';
  } catch {
    return 'failed';
  }
}
