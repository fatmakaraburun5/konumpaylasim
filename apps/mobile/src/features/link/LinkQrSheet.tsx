/**
 * QR / bağlantı alt sayfası:
 *   SheetHeader → QR (react-native-qrcode-svg) → URL metni → Kopyala (expo-clipboard) · Paylaş (RN Share)
 *   → kalan süre (core `formatExpiryLabel`) → +30 dk / +1 saat → "Paylaşımı durdur"
 * QR'ı okutan kişi, uygulama kuruluysa Universal/App Link ile uygulama içi haritada, değilse salt okunur
 * web haritasında konumu görür. "Paylaşımı durdur" sunucuda token'ı anında geçersiz kılar.
 */
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { EXTENSION_STEPS, type LinkId } from '@konum/core';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { linkStore, useLinkSession, useLinkStore } from '../../state/linkStore';
import { Button, Chip, Icon, SheetHeader, Text, useTheme } from '../../ui';
import { ExpiryBanner } from '../map/ExpiryBanner';
import { LinkPreviewAction } from './LinkPreviewAction';
import { LINK_TITLE, linkSubtitle, QR_MISSING_TEXT, shareMessage } from './linkText';
import { QrCode } from './QrCode';
import { shareLinkUrl } from './shareLink';

export interface LinkQrSheetHandle {
  present: (linkId: LinkId) => void;
  dismiss: () => void;
}

export function LinkQrSheet({ ref }: { ref?: Ref<LinkQrSheetHandle> }) {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const sheet = useRef<BottomSheetModal>(null);
  const [linkId, setLinkId] = useState<LinkId | null>(null);
  const link = useLinkSession(linkId);
  const [copied, setCopied] = useState(false);
  const [urlChecked, setUrlChecked] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      present: (id) => {
        setLinkId(id);
        setCopied(false);
        setUrlChecked(false);
        sheet.current?.present();
      },
      dismiss: () => sheet.current?.dismiss(),
    }),
    [],
  );

  // QR URL'si bellekte yoksa güvenli kasadan yükle.
  useEffect(() => {
    if (!linkId) return;
    let alive = true;
    void linkStore
      .getState()
      .ensureUrl(linkId)
      .finally(() => alive && setUrlChecked(true));
    return () => {
      alive = false;
    };
  }, [linkId]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(t);
  }, [copied]);

  const url = link?.url ?? null;
  const running = link ? link.phase !== 'ended' : false;
  const canExtend = !!link && (link.phase === 'active' || link.phase === 'expiring_soon') && link.expires_at !== null;
  const now = useLinkStore((s) => s.now);

  const copy = useCallback(async () => {
    if (!url) return;
    await Clipboard.setStringAsync(url).catch(() => false);
    setCopied(true);
  }, [url]);

  const share = useCallback(async () => {
    if (!url) return;
    // Paylaşım sayfası yoksa (web önizlemesi) bağlantı panoya kopyalanır: "Kopyalandı".
    if ((await shareLinkUrl(url, shareMessage(url))) === 'copied') setCopied(true);
  }, [url]);

  const stop = useCallback(() => {
    if (!linkId) return;
    Alert.alert('Paylaşımı durdur', 'Bağlantı ve QR kod hemen geçersiz olur; açık olan haritalarda konumun kaybolur.', [
      { text: 'Vazgeç', style: 'cancel' },
      { text: 'Durdur', style: 'destructive', onPress: () => void linkStore.getState().stop(linkId) },
    ]);
  }, [linkId]);

  const renderBackdrop = useCallback(
    (p: BottomSheetBackdropProps) => <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
    [],
  );

  return (
    <BottomSheetModal
      ref={sheet}
      snapPoints={['92%']}
      enableDynamicSizing={false}
      backdropComponent={renderBackdrop}
      onDismiss={() => setLinkId(null)}
      backgroundStyle={{ backgroundColor: colors.surface }}
      handleIndicatorStyle={{ backgroundColor: colors.border }}
    >
      <BottomSheetScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl, gap: spacing.md }}>
        <SheetHeader
          title={link ? LINK_TITLE[link.phase] : 'QR ile paylaş'}
          subtitle={link ? linkSubtitle(link, now) : undefined}
          onClose={() => sheet.current?.dismiss()}
        />

        {link && running ? (
          <View style={{ paddingHorizontal: spacing.md, gap: spacing.md }}>
            {link.phase === 'expiring_soon' ? (
              <ExpiryBanner session={link} now={now} subject="QR bağlantın" onExtend={(m) => void linkStore.getState().extend(link.link_id, m)} />
            ) : null}

            <View style={styles.center}>
              {url ? (
                <QrCode value={url} />
              ) : urlChecked ? (
                <View style={[styles.missing, { borderColor: colors.border, borderRadius: radius.lg, padding: spacing.md, gap: spacing.xs }]}>
                  <Icon name="qr" color={colors.textSecondary} size={40} />
                  <Text variant="label" color="textSecondary" style={styles.centerText}>
                    {QR_MISSING_TEXT}
                  </Text>
                </View>
              ) : null}
            </View>

            {url ? (
              <>
                <Text variant="caption" color="textSecondary" selectable numberOfLines={2} style={styles.centerText} accessibilityLabel="Paylaşım bağlantısı">
                  {url}
                </Text>
                <View style={[styles.row, { gap: spacing.xs }]}>
                  <Button title={copied ? 'Kopyalandı' : 'Kopyala'} variant="secondary" block={false} style={styles.flex} onPress={copy} />
                  <Button title="Paylaş" variant="primary" block={false} style={styles.flex} onPress={share} />
                </View>
                <Text variant="caption" color="textSecondary">
                  QR'ı okutan herkes, bağlantı açıkken canlı konumunu görür. Uygulama yüklü değilse tarayıcıda salt okunur harita açılır.
                </Text>
                <LinkPreviewAction url={url} onBeforeOpen={() => sheet.current?.dismiss()} />
              </>
            ) : null}

            {link.expires_at !== null ? (
              <View style={{ gap: spacing.xs }}>
                <Text variant="heading">Süreyi uzat</Text>
                <View style={[styles.row, { gap: spacing.xs }]}>
                  {EXTENSION_STEPS.map((step) => (
                    <Chip
                      key={step.minutes}
                      label={step.label}
                      disabled={!canExtend}
                      onPress={() => void linkStore.getState().extend(link.link_id, step.minutes)}
                      style={styles.flex}
                    />
                  ))}
                </View>
              </View>
            ) : null}

            {link.error ? (
              <Text variant="label" color="danger" accessibilityLiveRegion="assertive">
                {link.error.message}
              </Text>
            ) : null}

            <Button
              title={link.phase === 'stopping' && link.error ? 'Tekrar dene' : 'Paylaşımı durdur'}
              variant="danger"
              size="lg"
              loading={link.phase === 'stopping' && !link.error}
              onPress={link.phase === 'stopping' ? () => void linkStore.getState().stop(link.link_id) : stop}
            />
          </View>
        ) : (
          <View style={{ paddingHorizontal: spacing.md, gap: spacing.md }}>
            <Text variant="body" color="textSecondary">
              Bu bağlantı artık geçersiz. Konumunu yeniden paylaşmak için yeni bir QR oluşturabilirsin.
            </Text>
            <Button title="Kapat" variant="secondary" onPress={() => sheet.current?.dismiss()} />
          </View>
        )}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  center: { alignItems: 'center' },
  centerText: { textAlign: 'center' },
  missing: { alignItems: 'center', borderWidth: 1, borderStyle: 'dashed', maxWidth: 300 },
});
