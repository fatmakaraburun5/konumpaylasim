/**
 * Faz 10: "Kim ne kadar uzakta?" — kesinleşen buluşmadan 45 dk önce, "Katılacağım" diyen ve bana CANLI konum
 * paylaşan katılımcılar yakından uzağa (core `etaBoard.ts`). Cinsiyet çerçeveli avatar + "Ayşe · 6 dk".
 * Veri yalnızca cihazdaki gelen kutusu (yeni veri yolu yok); ETA yerel tahmin ya da Faz 9 hedef paketi.
 * Buluşmadan 30 dk sonra ya da herkes vardığında kapanır. Harita üstünde ve etkinlik kartında kullanılır.
 */
import { buildEtaBoard, ETA_BOARD_TEXT, type EpochMs, type EtaBoardPoint, type EventDoc, type UserId } from '@konum/core';
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useAuthStore } from '../../state/authStore';
import { useFriendsById } from '../../state/friendsStore';
import { useVisibleIncoming } from '../../state/incomingStore';
import { useLocationStore } from '../../state/locationStore';
import { useCanFn } from '../access/useAccess';
import { FriendAvatar } from '../profile/FriendAvatar';
import { cardShadow, Icon, Text, useTheme } from '../../ui';

export function useEtaBoard(doc: EventDoc | null, now: EpochMs) {
  const me = useAuthStore((s) => s.uid);
  const myName = useAuthStore((s) => s.profile?.display_name ?? null);
  const myGender = useAuthStore((s) => s.profile?.gender ?? null);
  const incoming = useVisibleIncoming(now);
  const myPos = useLocationStore((s) => s.myPosition);
  const byId = useFriendsById();
  const can = useCanFn();
  return useMemo(() => {
    if (!doc || !me) return null;
    const points: EtaBoardPoint[] = incoming.map((f) => ({
      uid: f.senderId,
      lat: f.location.lat,
      lng: f.location.lng,
      accuracy: f.location.accuracy,
      timestamp: f.location.timestamp,
      speed_mps: f.location.speed_mps,
      activity_state: f.location.activity_state,
      dest_name: f.location.dest_name ?? null,
      dest_state: f.location.dest_state ?? null,
      dest_eta: f.location.dest_eta ?? null,
      receiver_status: f.verified?.status ?? null,
    }));
    if (myPos) points.push({ uid: me, lat: myPos.lat, lng: myPos.lng, accuracy: myPos.accuracy ?? 30, timestamp: myPos.timestamp, activity_state: null });
    return buildEtaBoard({
      doc,
      viewer: me,
      now,
      points,
      nameOf: (u) => (u === me ? myName : byId[u]?.displayName ?? null),
      genderOf: (u) => (u === me ? myGender : byId[u]?.gender ?? null),
      // Faz 8: kişi bana konum görme izni vermiş olmalı (gelen kutusunda olmak zaten bunu gerektirir; ikinci kilit).
      allowed: (u) => u === me || can('location_view', u, 'received'),
    });
  }, [doc, me, myName, myGender, incoming, myPos, byId, can, now]);
}

export function EventEtaStrip({ doc, now, compact = false, onPress, onFocus }: { doc: EventDoc; now: EpochMs; compact?: boolean; onPress?: () => void; onFocus?: (uid: UserId) => void }) {
  const { colors, radius, spacing } = useTheme();
  const board = useEtaBoard(doc, now);
  if (!board || board.state !== 'open') return null;
  const size = compact ? 26 : 32;
  return (
    <View
      style={[cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, paddingVertical: spacing.xs, gap: 4 }]}
      testID="eta-strip"
      accessibilityLabel={`${ETA_BOARD_TEXT.title} ${board.venue_name}, ${board.headline}`}
    >
      <Pressable onPress={onPress} disabled={!onPress} style={[styles.head, { paddingHorizontal: spacing.sm, gap: spacing.xs }]} accessibilityRole={onPress ? 'button' : undefined}>
        <Icon name="route" size={14} color={colors.primary} />
        <Text variant="caption" style={styles.flex} numberOfLines={1}>
          {`${ETA_BOARD_TEXT.title} · ${board.venue_name}`}
        </Text>
        <Text variant="caption" color="textSecondary">
          {board.headline}
        </Text>
      </Pressable>
      {board.entries.length === 0 ? (
        <Text variant="caption" color="textSecondary" style={{ paddingHorizontal: spacing.sm }}>
          {ETA_BOARD_TEXT.empty}
        </Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.sm, gap: spacing.xs }}>
          {board.entries.map((e) => (
            <Pressable
              key={e.uid}
              onPress={onFocus ? () => onFocus(e.uid) : undefined}
              disabled={!onFocus}
              accessibilityLabel={e.a11y}
              testID={`eta-chip-${e.uid}`}
              style={[
                styles.chip,
                {
                  gap: 6,
                  paddingRight: spacing.sm,
                  paddingLeft: 3,
                  paddingVertical: 2,
                  borderRadius: 999,
                  backgroundColor: e.status === 'arrived' ? colors.primarySoft : colors.surfaceAlt,
                  opacity: e.status === 'stale' ? 0.7 : 1,
                },
              ]}
            >
              <FriendAvatar uid={e.uid} fallbackName={e.name} size={size} />
              <Text variant="label" numberOfLines={1}>
                {e.label}
              </Text>
            </Pressable>
          ))}
          {board.overflow > 0 ? (
            <Text variant="caption" color="textSecondary" style={styles.more}>
              {`+${board.overflow}`}
            </Text>
          ) : null}
        </ScrollView>
      )}
      {board.hidden_count > 0 ? (
        <Text variant="caption" color="textSecondary" style={{ paddingHorizontal: spacing.sm }}>
          {ETA_BOARD_TEXT.hidden(board.hidden_count)}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  chip: { flexDirection: 'row', alignItems: 'center' },
  more: { alignSelf: 'center' },
});
