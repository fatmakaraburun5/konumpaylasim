/**
 * YALNIZCA web önizlemesi: QR sayfasında "Bağlantıyı önizle". Tek dosyalık derlemede adres çubuğu değişmez
 * (scripts/build-web.mjs) ve QR okutulamaz; bu düğme bağlantıyı QR'ı okutan kişinin göreceği salt okunur
 * izleyicide (app/s/[token].tsx) uygulama içinde açar. Token yalnızca rota parametresi olarak geçer; izleyici
 * gerçek akıştaki gibi `linkTokenHash` → `link_live/{hash}` dinler. Native karşılığı hiçbir şey çizmez.
 */
import { parseLinkToken } from '@konum/core';
import { useRouter } from 'expo-router';
import { linkDomains } from '../../lib/linkConfig';
import { Button, Text } from '../../ui';
import type { LinkPreviewActionProps } from './LinkPreviewAction';

export type { LinkPreviewActionProps };

export function LinkPreviewAction({ url, onBeforeOpen }: LinkPreviewActionProps) {
  const router = useRouter();
  const token = parseLinkToken(url, linkDomains());
  if (!token) return null;
  return (
    <>
      <Button
        title="Bağlantıyı önizle"
        variant="secondary"
        accessibilityHint="QR'ı okutan kişinin göreceği salt okunur haritayı açar"
        onPress={() => {
          onBeforeOpen();
          router.push(`/s/${token}`);
        }}
      />
      <Text variant="caption" color="textSecondary">
        Web önizlemesi: QR okutmak yerine izleyici ekranını bu sekmede açar.
      </Text>
    </>
  );
}
