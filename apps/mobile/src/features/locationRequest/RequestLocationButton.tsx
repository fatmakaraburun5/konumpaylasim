/**
 * "Konum iste" düğmesi (Arkadaşlar satırı, kişi sayfası). Bu kişi bana şu an paylaşıyorsa görünmez.
 *
 *   yok        → [Konum iste]
 *   bekliyor   → "Konum isteği gönderildi · Yanıt bekleniyor (14 dk)" + [Geri çek]
 *   reddedildi → "Şu an paylaşamıyor" (+ bekleme: "8 dk sonra tekrar isteyebilirsin")
 *   süresi doldu / geri çekildi → aynı biçimde; bekleme bitince düğme geri gelir
 * Bekleme ve günlük sınır sunucuda denetlenir (core `LOCATION_REQUEST_LIMITS`); hata satırda gösterilir.
 */
import { LOCATION_REQUEST_TEXT, outgoingStateText, requestId as requestIdOf, retryText, type UserId } from '@konum/core';
import { StyleSheet, View } from 'react-native';
import { useNow } from '../../lib/useNow';
import { useIncomingStore } from '../../state/incomingStore';
import { locationRequestStore, selectOutgoingState, useLocationRequestStore } from '../../state/locationRequestStore';
import { Button, Text, useTheme } from '../../ui';

export function RequestLocationButton({ to, name, compact }: { to: UserId; name: string; compact?: boolean }) {
  const { spacing } = useTheme();
  const now = useNow(30_000);
  const sharingWithMe = useIncomingStore((s) =>
    Object.values(s.shares).some((x) => x.sender_id === to && x.status === 'active' && (x.expires_at === null || x.expires_at > now)),
  );
  // Seçici yalnızca belgeyi döner (her çizimde yeni nesne üretmesin); durum çizimde hesaplanır.
  const uid = useLocationRequestStore((s) => s.uid);
  const doc = useLocationRequestStore((s) => (s.uid ? s.docs[requestIdOf(s.uid, to)] : undefined));
  const state = selectOutgoingState({ uid, docs: doc ? { [doc.request_id]: doc } : {} }, to, now, sharingWithMe);
  const sending = useLocationRequestStore((s) => !!s.busy[`send:${to}`]);
  const cancelling = useLocationRequestStore((s) => Object.keys(s.busy).some((k) => k.startsWith('cancel:') && k.includes(to)));
  const error = useLocationRequestStore((s) => s.errors[to] ?? null);

  if (state.kind === 'sharing') return null;
  const status = outgoingStateText(state, now);
  const wait = state.kind === 'rejected' || state.kind === 'expired' || state.kind === 'cancelled' ? retryText(state.retry_at, now) : null;

  return (
    <View style={{ gap: spacing.xs }} testID={`request-location-${to}`}>
      <View style={[styles.row, { gap: spacing.xs }]}>
        {status ? (
          <Text variant="caption" color={state.kind === 'pending' ? 'primary' : 'textSecondary'} style={styles.flex} accessibilityLiveRegion="polite" testID={`request-location-status-${to}`}>
            {state.kind === 'pending' ? `${name}: ${status}` : `${name}: ${status}${wait ? ` · ${wait}` : ''}`}
          </Text>
        ) : (
          <View style={styles.flex} />
        )}
        {state.kind === 'pending' ? (
          <Button
            title={LOCATION_REQUEST_TEXT.cancel}
            variant="ghost"
            block={false}
            loading={cancelling}
            accessibilityLabel={`${name} için konum isteğini geri çek`}
            onPress={() => void locationRequestStore.getState().cancel(to)}
            testID={`request-location-cancel-${to}`}
          />
        ) : !wait ? (
          <Button
            title={LOCATION_REQUEST_TEXT.action}
            variant={compact ? 'secondary' : 'primary'}
            block={false}
            loading={sending}
            accessibilityLabel={`${name} kişisinden konum iste`}
            onPress={() => void locationRequestStore.getState().send(to)}
            testID={`request-location-send-${to}`}
          />
        ) : null}
      </View>
      {error ? (
        <Text variant="caption" color="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
