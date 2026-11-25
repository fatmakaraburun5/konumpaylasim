/**
 * "Konum İste" onay sayfası: gelen isteğe "Onayla" → süre seçimi (15 dk · 1 saat · 8 saat · Gün sonuna kadar ·
 * Haftalık · Süresiz · Saat seç) → `location_request_respond(accept)`. Onaylanınca paylaşım isteyenin haritasında
 * hemen başlar ve kitapçığa (ShareDeck) girer. Görünmezken "Görünür ol ve paylaş" (önceki paylaşımlar geri gelmez).
 * Her ekranın üstünde (app/(main)/_layout); bildirimdeki "Onayla" da bunu açar.
 */
import {
  DEFAULT_REQUEST_DURATION_ID,
  isPendingRequest,
  LOCATION_REQUEST_TEXT,
  minutesLeftText,
  REQUEST_DURATION_OPTIONS,
  type DurationChoice,
  type RequestDurationOption,
} from '@konum/core';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNow } from '../../lib/useNow';
import type { LocationRequestDoc } from '../../lib/schemas';
import { useFriendNames } from '../../state/friendsStore';
import { invisibleStore, useIsInvisible } from '../../state/invisibleStore';
import { locationRequestStore, useLocationRequestStore } from '../../state/locationRequestStore';
import { Button, cardShadow, Chip, Overlay, SheetHeader, Text, useTheme } from '../../ui';
import { FriendAvatar } from '../profile/FriendAvatar';
import { CustomDurationPicker } from '../share/CustomDurationPicker';

export function ApproveLocationRequestSheet() {
  const approving = useLocationRequestStore((s) => s.approving);
  const doc = useLocationRequestStore((s) => (s.approving ? (s.docs[s.approving] ?? null) : null));
  if (!approving) return null;
  return <SheetBody key={approving} requestId={approving} doc={doc} />;
}

function SheetBody({ requestId, doc }: { requestId: string; doc: LocationRequestDoc | null }) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const now = useNow(15_000);
  const names = useFriendNames();
  const invisible = useIsInvisible();
  const busy = useLocationRequestStore((s) => !!s.busy[`approve:${requestId}`] || !!s.busy[`reject:${requestId}`]);
  const [option, setOption] = useState<RequestDurationOption['id']>(DEFAULT_REQUEST_DURATION_ID);
  const [custom, setCustom] = useState<{ choice: DurationChoice | null; error: string | null }>({ choice: null, error: null });
  const [error, setError] = useState<string | null>(null);
  const [visibleBusy, setVisibleBusy] = useState(false);

  const close = () => locationRequestStore.getState().closeApprove();
  const name = doc ? (names[doc.requester_id] ?? 'Arkadaşın') : 'Arkadaşın';
  const valid = !!doc && isPendingRequest(doc, now);
  const selected = REQUEST_DURATION_OPTIONS.find((o) => o.id === option);
  const choice = option === 'until' ? custom.choice : (selected?.choice ?? null);

  const approve = async () => {
    if (!choice) return;
    setError(null);
    if (invisible) {
      // Görünür ol: önceki paylaşımların hiçbiri seçili değil (Faz 8 kuralı), yalnızca bu istek paylaşılır.
      setVisibleBusy(true);
      const v = await invisibleStore.getState().setVisible([]);
      setVisibleBusy(false);
      if (!v.ok) {
        setError(v.message);
        return;
      }
    }
    const r = await locationRequestStore.getState().approve(requestId, choice);
    if (!r.ok) setError(r.message);
  };

  const reject = async () => {
    await locationRequestStore.getState().reject(requestId);
    close();
  };

  return (
    <Overlay visible onRequestClose={close} testID="approve-request-sheet">
      <View style={[styles.backdrop, { paddingBottom: insets.bottom + spacing.md, paddingHorizontal: spacing.md }]}>
        <View style={[cardShadow, styles.card, { backgroundColor: colors.surface, borderRadius: radius.lg, paddingVertical: spacing.md, gap: spacing.sm }]}>
          <SheetHeader title={`${name} ${LOCATION_REQUEST_TEXT.inAppCard}`} subtitle={LOCATION_REQUEST_TEXT.sheetQuestion} onClose={close} />
          <ScrollView style={styles.scroll} contentContainerStyle={{ paddingHorizontal: spacing.md, gap: spacing.sm }}>
            {!valid ? (
              <Text variant="body" color="textSecondary" testID="approve-request-invalid">
                {LOCATION_REQUEST_TEXT.noLongerValid}
              </Text>
            ) : (
              <>
                <View style={[styles.row, { gap: spacing.sm }]}>
                  {doc ? <FriendAvatar uid={doc.requester_id} fallbackName={name} size={36} /> : null}
                  <Text variant="label" color="textSecondary" style={styles.flex}>
                    {`İstek ${minutesLeftText(doc.expires_at, now)} sonra düşer.`}
                  </Text>
                </View>
                <View style={[styles.wrap, { gap: spacing.xs }]} accessibilityRole="radiogroup" accessibilityLabel={LOCATION_REQUEST_TEXT.sheetQuestion}>
                  {REQUEST_DURATION_OPTIONS.map((o) => (
                    <Chip key={o.id} label={o.label} selected={option === o.id} onPress={() => setOption(o.id)} disabled={busy} />
                  ))}
                </View>
                {option === 'until' ? <CustomDurationPicker now={now} onChange={(c, e) => setCustom({ choice: c, error: e })} /> : null}
                {option === 'until' && custom.error ? (
                  <Text variant="label" color="danger">
                    {custom.error}
                  </Text>
                ) : null}
                <Text variant="label" color="textSecondary">
                  {LOCATION_REQUEST_TEXT.grantNote}
                </Text>
                {invisible ? (
                  <Text variant="label" color="warning" testID="approve-request-invisible">
                    {LOCATION_REQUEST_TEXT.invisibleNote}
                  </Text>
                ) : null}
              </>
            )}
          </ScrollView>
          <View style={[styles.row, { paddingHorizontal: spacing.md, gap: spacing.xs }]}>
            {error ? (
              <Text variant="label" color="danger" accessibilityLiveRegion="assertive" style={styles.flex}>
                {error}
              </Text>
            ) : null}
          </View>
          <View style={[styles.row, { paddingHorizontal: spacing.md, gap: spacing.xs, justifyContent: 'flex-end' }]}>
            {valid ? (
              <>
                <Button title={LOCATION_REQUEST_TEXT.reject} variant="ghost" block={false} disabled={busy} onPress={() => void reject()} testID="approve-request-reject" />
                <Button
                  title={invisible ? LOCATION_REQUEST_TEXT.becomeVisibleAndShare : LOCATION_REQUEST_TEXT.share}
                  block={false}
                  loading={busy || visibleBusy}
                  disabled={!choice}
                  onPress={() => void approve()}
                  testID="approve-request-submit"
                />
              </>
            ) : (
              <Button title="Kapat" block={false} onPress={close} testID="approve-request-close" />
            )}
          </View>
        </View>
      </View>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15, 23, 42, 0.45)' },
  card: { maxHeight: '90%', width: '100%', maxWidth: 560, alignSelf: 'center' },
  scroll: { flexGrow: 0 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
