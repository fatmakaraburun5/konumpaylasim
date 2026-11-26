/**
 * Faz 7: "Etkinlikler" ekranı (app/(main)/events/index.tsx; TopBar takvim düğmesi ve hesap menüsünden).
 *
 *   sekmeler: Etkinlikler | Bildirimler (okunmamış sayısı)
 *   Etkinlikler: önce benden eylem bekleyenler (rozet: "Yanıtını bekliyor", "Mekan oyu bekleniyor" …), sonra etkinler
 *     (yakın tarih önde), sonra biten / iptal edilenler. Kart: başlık · aşama · özet (mekan · tarih saat) · katılım.
 *   Bildirimler: davet, aşama, yanıt, hatırlatma, iptal (30 gün); sekme açılınca okundu sayılır.
 */
import { attendanceCounts, EVENT_TEXT, eventPhaseText, eventSummaryLine, eventTodoFor, isActiveEventStage, sortEventsForList, type EventDoc } from '@konum/core';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { now as serverNow } from '../../lib/clock';
import { useAuthStore } from '../../state/authStore';
import { eventsStore, selectUnreadNotices, useEventsStore } from '../../state/eventsStore';
import { Button, cardShadow, Icon, IconButton, MIN_TOUCH, Text, useTheme } from '../../ui';
import { NOTICE_ICON, relativeTime, TODO_TEXT } from './eventModel';
import { useNow } from './useNow';

type Tab = 'events' | 'notices';

export function EventsScreen({ initialTab = 'events' }: { initialTab?: Tab }) {
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const me = useAuthStore((s) => s.uid);
  const eventsMap = useEventsStore((s) => s.events);
  const loaded = useEventsStore((s) => s.loaded);
  const notices = useEventsStore((s) => s.notices);
  const unread = useEventsStore(selectUnreadNotices);
  const lastSeen = useEventsStore((s) => s.lastSeenNoticeAt);
  const [tab, setTab] = useState<Tab>(initialTab);
  const now = useNow(30_000);

  // Bildirimler sekmesi açıkken gelenler de okundu sayılır (rozet sıfırlanır).
  useEffect(() => {
    if (tab === 'notices' && notices.length) eventsStore.getState().markNoticesSeen();
  }, [tab, notices]);

  const list = useMemo(() => (me ? sortEventsForList(Object.values(eventsMap), me, serverNow()) : []), [eventsMap, me, now]);
  const active = list.filter((e) => isActiveEventStage(e.stage));
  const past = list.filter((e) => !isActiveEventStage(e.stage));
  const card = [cardShadow, { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, gap: spacing.xs }];

  const open = (e: EventDoc) => router.push(`/events/${encodeURIComponent(e.event_id)}`);

  const renderEvent = (e: EventDoc) => {
    const todo = me ? eventTodoFor(e, me, serverNow()) : null;
    const c = attendanceCounts(e);
    const ended = !isActiveEventStage(e.stage);
    return (
      <Pressable
        key={e.event_id}
        testID={`event-card-${e.event_id}`}
        accessibilityRole="button"
        accessibilityLabel={`${e.title}. ${eventPhaseText(e)}. ${eventSummaryLine(e)}${todo ? `. ${TODO_TEXT[todo]}` : ''}`}
        onPress={() => open(e)}
        style={({ pressed }) => [card, { opacity: pressed ? 0.8 : ended ? 0.7 : 1 }]}
      >
        <View style={[styles.row, { gap: spacing.xs }]}>
          <Text variant="heading" numberOfLines={1} style={styles.flex}>
            {e.title}
          </Text>
          {e.owner_id === me ? (
            <Text variant="caption" color="textSecondary">
              Düzenleyen sensin
            </Text>
          ) : null}
        </View>
        <Text variant="label" color={e.stage === 'cancelled' ? 'danger' : 'primary'}>
          {eventPhaseText(e)}
        </Text>
        <Text variant="body">{eventSummaryLine(e)}</Text>
        <Text variant="caption" color="textSecondary">
          {`${c.going} katılacak · ${c.not_going} katılamayacak · ${c.pending} yanıt bekleniyor`}
        </Text>
        {todo ? (
          <View style={[styles.todo, { backgroundColor: colors.warningSoft, borderRadius: radius.pill }]}>
            <Text variant="caption" style={{ color: colors.warning }}>
              {TODO_TEXT[todo]}
            </Text>
          </View>
        ) : null}
      </Pressable>
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.xs, paddingHorizontal: spacing.xs }]}>
        <IconButton icon="chevronLeft" accessibilityLabel="Geri" onPress={() => router.back()} />
        <Text variant="title" accessibilityRole="header" style={styles.flex}>
          {EVENT_TEXT.screenTitle}
        </Text>
        <IconButton icon="plus" accessibilityLabel={EVENT_TEXT.create} onPress={() => router.push('/events/new')} />
      </View>

      <View style={[styles.tabs, { marginHorizontal: spacing.md, backgroundColor: colors.surfaceAlt, borderRadius: radius.pill }]} accessibilityRole="tablist">
        {(['events', 'notices'] as const).map((t) => {
          const selected = tab === t;
          const label = t === 'events' ? 'Etkinlikler' : unread > 0 ? `Bildirimler (${unread})` : 'Bildirimler';
          return (
            <Pressable
              key={t}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              testID={`events-tab-${t}`}
              onPress={() => setTab(t)}
              style={[styles.tab, { borderRadius: radius.pill, backgroundColor: selected ? colors.surface : 'transparent' }, selected ? cardShadow : null]}
            >
              <Text variant="label" color={selected ? 'text' : 'textSecondary'}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.md, paddingBottom: insets.bottom + spacing.xl }}>
        {tab === 'events' ? (
          !loaded && list.length === 0 ? (
            <ActivityIndicator color={colors.textSecondary} />
          ) : list.length === 0 ? (
            <View style={card}>
              <Text variant="heading">{EVENT_TEXT.emptyTitle}</Text>
              <Text variant="label" color="textSecondary">
                {EVENT_TEXT.emptyBody}
              </Text>
              <Text variant="caption" color="textSecondary">
                1) Tarih ve katılım ön onayı · 2) 3 mekan arasından oylama · 3) Saat oylaması ve herkesin son onayı. Buluşmadan bir gün
                önce ve buluşma günü sabah 08:00&apos;de hatırlatırız.
              </Text>
              <Button title={EVENT_TEXT.create} onPress={() => router.push('/events/new')} />
            </View>
          ) : (
            <>
              {active.map(renderEvent)}
              {past.length ? (
                <Text variant="label" color="textSecondary" accessibilityRole="header">
                  Geçmiş
                </Text>
              ) : null}
              {past.map(renderEvent)}
            </>
          )
        ) : notices.length === 0 ? (
          <View style={card}>
            <Text variant="heading">Bildirim yok</Text>
            <Text variant="label" color="textSecondary">
              Davetler, oylama başlangıçları, yanıtlar ve hatırlatmalar burada 30 gün durur.
            </Text>
          </View>
        ) : (
          <View style={card} testID="events-notices">
            {notices.map((n, i) => {
              const isNew = lastSeen === null || n.created_at > lastSeen;
              return (
                <Pressable
                  key={n.notice_id}
                  accessibilityRole="button"
                  accessibilityLabel={`${n.title}. ${n.body}. ${relativeTime(n.created_at, now)}`}
                  onPress={() => router.push(`/events/${encodeURIComponent(n.event_id)}`)}
                  style={({ pressed }) => [
                    styles.row,
                    { gap: spacing.sm, minHeight: MIN_TOUCH, paddingVertical: spacing.xs, opacity: pressed ? 0.7 : 1 },
                    i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border } : null,
                  ]}
                >
                  <View style={[styles.noticeIcon, { backgroundColor: n.type === 'event_cancelled' ? colors.dangerSoft : colors.primarySoft }]}>
                    <Icon name={NOTICE_ICON[n.type]} size={18} color={n.type === 'event_cancelled' ? colors.danger : colors.primary} />
                  </View>
                  <View style={styles.flex}>
                    <Text variant="label" numberOfLines={1}>
                      {n.title}
                    </Text>
                    <Text variant="caption" color="textSecondary" numberOfLines={3}>
                      {n.body}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 4 }}>
                    <Text variant="caption" color="textSecondary">
                      {relativeTime(n.created_at, now)}
                    </Text>
                    {isNew ? <View style={[styles.dot, { backgroundColor: colors.primary }]} accessibilityLabel="Yeni" /> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  tabs: { flexDirection: 'row', padding: 3, marginBottom: 4 },
  tab: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  todo: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 2, marginTop: 2 },
  noticeIcon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
