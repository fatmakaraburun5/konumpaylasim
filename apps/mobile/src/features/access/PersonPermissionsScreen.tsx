/**
 * Faz 8: Kişi izinleri (`/friend/[id]`; Arkadaşlar > kişi satırı). docs/PHASE8.md §5.4.
 *
 *  - "Senin verdiğin izinler": istenebilir her kapsam için anahtar (`permission_set`). Konum iznini kapatmak onay
 *    ister (onun canlı görüşü hemen durur). `sos_alert` salt okunur: acil durum kişilerinden değişir.
 *  - "Onun sana verdiği izinler": salt okunur; olmayanlarda "İzin iste", hepsi için "Tümünü iste", bekleyen istekte
 *    "İstek gönderildi". Soğuma (`permission_cooldown`) kısa bir notla gösterilir.
 * Karşı tarafın görünmez olduğu ya da izni neden kapattığı burada da söylenmez: yalnızca izin durumu görünür.
 */
import { ACCESS_TEXT, PAIR_ACCESS_TEXT, type RequestableScope, type UserId } from '@konum/core';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFriendsById } from '../../state/friendsStore';
import { grantsStore, useAccessSummary, useGrantsStore, useMyGrantTo, useMyPendingRequestTo, useTheirGrantTo } from '../../state/grantsStore';
import { Button, cardShadow, IconButton, MIN_TOUCH, Text, useTheme } from '../../ui';
import { FriendAvatar } from '../profile/FriendAvatar';
import { EmergencyContactsSheet, type EmergencyContactsSheetHandle } from '../sos/EmergencyContactsSheet';
import { givenRows, LOCATION_OFF_CONFIRM, missingRequestable, RECEIVED_STATE_TEXT, receivedRows, requestFeedback } from './accessModel';
import { RequestPermissionButton } from './RequestPermissionButton';
import { RequestLocationButton } from '../locationRequest/RequestLocationButton';

export function PersonPermissionsScreen({ friendId }: { friendId: UserId }) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const friend = useFriendsById()[friendId];
  const myGrant = useMyGrantTo(friendId);
  const theirGrant = useTheirGrantTo(friendId);
  const pending = useMyPendingRequestTo(friendId);
  const summary = useAccessSummary(friendId);
  const busy = useGrantsStore((s) => s.busy);
  const contactsSheet = useRef<EmergencyContactsSheetHandle>(null);
  const [error, setError] = useState<string | null>(null);
  const [allFeedback, setAllFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }];
  const name = friend?.displayName ?? 'Arkadaşın';

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.xs }]}>
      <IconButton icon="chevronLeft" accessibilityLabel="Geri" onPress={() => router.back()} />
      <Text variant="title" accessibilityRole="header">
        {ACCESS_TEXT.personPermissionsTitle}
      </Text>
    </View>
  );

  if (!friend) {
    return (
      <View style={[styles.root, { backgroundColor: colors.bg }]} testID="person-permissions">
        {header}
        <Text variant="body" color="textSecondary" style={{ padding: spacing.md }}>
          Bu kişi artık arkadaş listende değil.
        </Text>
      </View>
    );
  }

  const set = async (scope: RequestableScope, granted: boolean) => {
    setError(null);
    const r = await grantsStore.getState().setScope(friendId, scope, granted);
    if (!r.ok) setError(r.message);
  };

  const onToggle = (scope: RequestableScope, granted: boolean) => {
    if (scope === 'location_view' && !granted) {
      Alert.alert(LOCATION_OFF_CONFIRM.title, LOCATION_OFF_CONFIRM.body(name), [
        { text: 'Vazgeç', style: 'cancel' },
        { text: LOCATION_OFF_CONFIRM.action, style: 'destructive', onPress: () => void set(scope, false) },
      ]);
      return;
    }
    void set(scope, granted);
  };

  const given = givenRows(myGrant);
  const received = receivedRows(theirGrant, pending);
  const missing = missingRequestable(received);

  const requestAll = async () => {
    const r = await grantsStore.getState().request(friendId, missing);
    setAllFeedback(requestFeedback(r));
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]} testID="person-permissions">
      {header}
      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + spacing.xl }}>
        <View style={[...card, styles.row]}>
          <FriendAvatar uid={friendId} fallbackName={name} size={48} />
          <View style={styles.flex}>
            <Text variant="heading" numberOfLines={1}>
              {name}
            </Text>
            <Text variant="label" color="textSecondary" testID="person-access-summary">
              {PAIR_ACCESS_TEXT[summary]}
            </Text>
          </View>
        </View>
        <View style={card}>
          <RequestLocationButton to={friendId} name={name} />
        </View>

        <View style={card} testID="person-given">
          <Text variant="heading">{ACCESS_TEXT.givenTitle}</Text>
          {given.map((row) => {
            const key = `set:${friendId}:${row.scope}`;
            return (
              <View key={row.scope} style={[styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH }]}>
                <View style={styles.flex}>
                  <Text variant="body">{row.title}</Text>
                  <Text variant="label" color="textSecondary">
                    {row.description}
                  </Text>
                  {!row.editable ? (
                    <Button
                      title="Acil durum kişileri"
                      variant="ghost"
                      block={false}
                      style={styles.start}
                      onPress={() => contactsSheet.current?.present(false)}
                      testID="person-sos-contacts"
                    />
                  ) : null}
                </View>
                {row.editable ? (
                  <Switch
                    value={row.on}
                    disabled={!!busy[key]}
                    onValueChange={(v) => onToggle(row.scope as RequestableScope, v)}
                    accessibilityLabel={row.title}
                    testID={`person-given-${row.scope}`}
                  />
                ) : (
                  <Text variant="label" color={row.on ? 'live' : 'textSecondary'}>
                    {row.on ? 'Açık' : 'Kapalı'}
                  </Text>
                )}
              </View>
            );
          })}
          {error ? (
            <Text variant="label" color="danger" accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}
        </View>

        <View style={card} testID="person-received">
          <Text variant="heading">{ACCESS_TEXT.receivedTitle}</Text>
          {received.map((row) => (
            <View key={row.scope} style={[styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH }]} testID={`person-received-${row.scope}`}>
              <View style={styles.flex}>
                <Text variant="body" color={row.state === 'granted' ? 'text' : 'textSecondary'}>
                  {row.title}
                </Text>
                <Text variant="label" color="textSecondary">
                  {row.description}
                </Text>
              </View>
              {row.state === 'missing' ? (
                <RequestPermissionButton to={friendId} name={name} scopes={[row.scope as RequestableScope]} compact testID={`person-request-${row.scope}`} />
              ) : (
                <Text variant="label" color={row.state === 'granted' ? 'live' : 'textSecondary'}>
                  {RECEIVED_STATE_TEXT[row.state]}
                </Text>
              )}
            </View>
          ))}
          {missing.length > 1 ? (
            <Button title="Tümünü iste" variant="secondary" onPress={() => void requestAll()} loading={!!busy[`request:${friendId}`]} testID="person-request-all" />
          ) : null}
          {allFeedback ? (
            <Text variant="label" style={{ color: allFeedback.ok ? colors.live : colors.warning }} accessibilityLiveRegion="polite">
              {allFeedback.text}
            </Text>
          ) : null}
        </View>
      </ScrollView>
      <EmergencyContactsSheet ref={contactsSheet} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  start: { alignSelf: 'flex-start', paddingHorizontal: 0 },
});
