/**
 * Gelen konum istekleri kartı (harita üstü ve Arkadaşlar): "Can konumunu paylaşmanı istiyor" → [Reddet] [Onayla].
 * "Onayla" süre seçiciyi açar (ApproveLocationRequestSheet); "Reddet" isteyene sade bir bildirim gönderir
 * ("… şu an konumunu paylaşamıyor"; neden söylenmez).
 */
import { LOCATION_REQUEST_TEXT, minutesLeftText } from '@konum/core';
import { StyleSheet, View } from 'react-native';
import { useNow } from '../../lib/useNow';
import { useFriendNames } from '../../state/friendsStore';
import { locationRequestStore, selectIncomingRequests, useLocationRequestStore } from '../../state/locationRequestStore';
import { Button, cardShadow, Text, useTheme } from '../../ui';
import { FriendAvatar } from '../profile/FriendAvatar';
import { useShallow } from 'zustand/react/shallow';

export function IncomingLocationRequests({ max = 3 }: { max?: number }) {
  const { colors, radius, spacing } = useTheme();
  const now = useNow(30_000);
  const names = useFriendNames();
  const requests = useLocationRequestStore(useShallow((s) => selectIncomingRequests(s, now)));
  const busy = useLocationRequestStore((s) => s.busy);
  if (requests.length === 0) return null;

  return (
    <View style={{ gap: spacing.xs }} testID="incoming-location-requests">
      {requests.slice(0, max).map((r) => {
        const name = names[r.requester_id] ?? 'Arkadaşın';
        const rejecting = !!busy[`reject:${r.request_id}`];
        return (
          <View
            key={r.request_id}
            testID={`incoming-location-request-${r.requester_id}`}
            accessibilityRole="summary"
            style={[cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.sm, gap: spacing.xs, borderWidth: 1.5, borderColor: colors.primary }]}
          >
            <View style={[styles.row, { gap: spacing.sm }]}>
              <FriendAvatar uid={r.requester_id} fallbackName={name} size={36} />
              <View style={styles.flex}>
                <Text variant="label" style={{ fontWeight: '600' }}>{`${name} ${LOCATION_REQUEST_TEXT.inAppCard}`}</Text>
                <Text variant="caption" color="textSecondary">{`Konum isteği · ${minutesLeftText(r.expires_at, now)} içinde yanıtla`}</Text>
              </View>
            </View>
            <View style={[styles.row, { gap: spacing.xs, justifyContent: 'flex-end' }]}>
              <Button
                title={LOCATION_REQUEST_TEXT.reject}
                variant="ghost"
                block={false}
                loading={rejecting}
                onPress={() => void locationRequestStore.getState().reject(r.request_id)}
                testID={`incoming-location-reject-${r.requester_id}`}
              />
              <Button
                title={LOCATION_REQUEST_TEXT.approve}
                block={false}
                disabled={rejecting}
                onPress={() => locationRequestStore.getState().openApprove(r.request_id)}
                testID={`incoming-location-approve-${r.requester_id}`}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
