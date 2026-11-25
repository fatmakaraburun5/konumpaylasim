/**
 * Faz 8: Arkadaşlar ekranının en üstündeki "İzin istekleri" kartı (docs/PHASE8.md §5.4): bana gelen, süresi
 * geçmemiş istekler ("Can senden konumunu görmek istiyor") → "İzin ver…" (GrantSheet) / "Reddet" (bildirim gitmez).
 * Bildirimden açıldıysa (`focusRequesterId`) o istek vurgulanır.
 */
import { ACCESS_TEXT, permissionRequestText, type IncomingPermissionRequest } from '@konum/core';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useNow } from '../../lib/useNow';
import { useFriendNames } from '../../state/friendsStore';
import { grantsStore, useGrantsStore, useIncomingPermissionRequests } from '../../state/grantsStore';
import { Button, cardShadow, Text, useTheme } from '../../ui';
import { FriendAvatar } from '../profile/FriendAvatar';
import { GrantSheet } from './GrantSheet';

export function PermissionRequestsCard() {
  const { colors, radius, spacing } = useTheme();
  const now = useNow(60_000);
  const requests = useIncomingPermissionRequests(now);
  const names = useFriendNames();
  const focus = useGrantsStore((s) => s.focusRequesterId);
  const busy = useGrantsStore((s) => s.busy);
  const [open, setOpen] = useState<IncomingPermissionRequest | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  if (requests.length === 0 && !note) return null;
  const nameOf = (id: string) => names[id] ?? 'Arkadaşın';

  const decline = async (id: string) => {
    setRowError(({ [id]: _old, ...rest }) => rest);
    const r = await grantsStore.getState().decline(id);
    if (!r.ok) setRowError((e) => ({ ...e, [id]: r.message }));
    else if (grantsStore.getState().focusRequesterId === id) grantsStore.getState().focusRequest(null);
  };

  return (
    <View style={[cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }]} testID="permission-requests-card">
      <Text variant="heading">{ACCESS_TEXT.requestsCardTitle}</Text>
      {requests.map((r) => {
        const name = nameOf(r.requester_id);
        const focused = focus === r.requester_id;
        const rowBusy = !!busy[`respond:${r.requester_id}`];
        return (
          <View
            key={r.requester_id}
            testID={`permission-request-${r.requester_id}`}
            style={[
              { gap: spacing.xs, borderRadius: radius.md, padding: focused ? spacing.xs : 0 },
              focused ? { borderWidth: 1.5, borderColor: colors.primary, backgroundColor: colors.primarySoft } : null,
            ]}
          >
            <View style={[styles.row, { gap: spacing.sm }]}>
              <FriendAvatar uid={r.requester_id} fallbackName={name} size={36} />
              <Text variant="body" style={styles.flex}>
                {permissionRequestText(name, r.scopes)}
              </Text>
            </View>
            <View style={[styles.row, { gap: spacing.xs, justifyContent: 'flex-end' }]}>
              <Button title={ACCESS_TEXT.declineAction} variant="ghost" block={false} disabled={rowBusy} onPress={() => void decline(r.requester_id)} testID={`permission-decline-${r.requester_id}`} />
              <Button title={ACCESS_TEXT.grantAction} block={false} loading={rowBusy} onPress={() => setOpen(r)} testID={`permission-grant-${r.requester_id}`} />
            </View>
            {rowError[r.requester_id] ? (
              <Text variant="label" color="danger" accessibilityLiveRegion="polite">
                {rowError[r.requester_id]}
              </Text>
            ) : null}
          </View>
        );
      })}
      {note ? (
        <Text variant="label" color="live" accessibilityLiveRegion="polite" testID="permission-requests-note">
          {note}
        </Text>
      ) : null}
      <GrantSheet
        request={open}
        name={open ? nameOf(open.requester_id) : ''}
        onClose={() => setOpen(null)}
        onDone={(text) => {
          setOpen(null);
          setNote(text);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
