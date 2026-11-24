/**
 * Faz 5: paylaşılan buluşma önerisi kartı (MapHome alt alanı, `meetupStore.focusedMeetupId`).
 *
 *   Alıcı: öneren, yer adı / adres, buluşma saati / not, herkesin ETA'sı (paylaşım anı) + benim canlı ETA'm
 *     (useRouteEta → route_compute), "Yol tarifi" (Google Haritalar), "Geliyorum" / "Uyamam".
 *   Öneren: aynı bilgiler + yanıtlar ("Ayşe: Geliyorum"), "Öneriyi iptal et".
 * `MeetupPills`: odakta kart yokken aktif önerilere kısa giriş.
 */
import { formatClock, formatDistanceTr, formatEtaDuration, type Meetup, type UserId } from '@konum/core';
import { useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, View } from 'react-native';
import { meetupStore } from '../../state/meetupStore';
import { Button, cardShadow, MIN_TOUCH, Text, useTheme } from '../../ui';
import type { EtaState } from '../map/useEta';
import { directionsUrl, meetupEtaLine, meetupPlaceEmoji, MEETUP_RESPONSE_TEXT, responseRows } from './meetupModel';

export interface MeetupCardProps {
  meetup: Meetup;
  myUid: UserId | null;
  names: Record<UserId, string>;
  /** Benim konumumdan yere canlı ETA. */
  eta: EtaState;
  onClose: () => void;
}

export function MeetupCard({ meetup, myUid, names, eta, onClose }: MeetupCardProps) {
  const { colors, radius, spacing } = useTheme();
  const mine = meetup.from === myUid;
  const myResponse = myUid ? (meetup.responses[myUid] ?? null) : null;
  const [busy, setBusy] = useState<'accepted' | 'declined' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const place = meetup.place;
  const result = eta.entry && !eta.entry.error ? (eta.entry.result ?? null) : null;

  const respond = async (r: 'accepted' | 'declined') => {
    setBusy(r);
    setError(null);
    const ok = await meetupStore.getState().respond(meetup.meetup_id, r);
    setBusy(null);
    if (!ok) setError('Yanıt gönderilemedi. Bağlantını kontrol edip tekrar dene.');
  };
  const cancel = () =>
    Alert.alert('Öneriyi iptal et', `${place.name} önerisi alıcıların haritasından kalkacak.`, [
      { text: 'Vazgeç', style: 'cancel' },
      {
        text: 'İptal et',
        style: 'destructive',
        onPress: async () => {
          setBusy('cancel');
          const ok = await meetupStore.getState().cancel(meetup.meetup_id);
          setBusy(null);
          if (ok) onClose();
          else setError('Öneri iptal edilemedi. Bağlantını kontrol edip tekrar dene.');
        },
      },
    ]);
  const openDirections = () => void Linking.openURL(directionsUrl(place.location)).catch(() => setError('Yol tarifi açılamadı.'));

  const live =
    eta.status === 'no_origin' ? (
      <Text variant="label" color="textSecondary">
        Senin varış süren için konumun gerekli.
      </Text>
    ) : result ? (
      <Text variant="label" accessibilityLabel={`Şu an senin için ${formatEtaDuration(result.duration_s)}, ${formatDistanceTr(result.distance_m)}`}>
        {`Şu an senin için: ${formatEtaDuration(result.duration_s)} · ${formatDistanceTr(result.distance_m)}`}
      </Text>
    ) : eta.entry?.error ? (
      <Text variant="label" color="textSecondary">
        {eta.entry.error.message}
      </Text>
    ) : (
      <View style={[styles.row, { gap: spacing.xs }]}>
        <ActivityIndicator color={colors.textSecondary} size="small" />
        <Text variant="label" color="textSecondary">
          Senin varış süren hesaplanıyor…
        </Text>
      </View>
    );

  return (
    <View style={[cardShadow, { backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.md, gap: spacing.sm }]} accessibilityLabel="Buluşma noktası kartı" testID="meetup-card">
      <View style={[styles.row, { gap: spacing.sm }]}>
        <View style={[styles.emoji, { backgroundColor: colors.liveSoft }]}>
          <Text variant="heading" maxFontSizeMultiplier={1}>
            {meetupPlaceEmoji(place)}
          </Text>
        </View>
        <View style={styles.flex}>
          <Text variant="caption" color="textSecondary">
            {mine ? 'Senin buluşma önerin' : `${meetup.from_name} buluşma noktası önerdi`}
          </Text>
          <Text variant="heading" numberOfLines={1} accessibilityRole="header">
            {place.name}
          </Text>
          {place.address ? (
            <Text variant="caption" color="textSecondary" numberOfLines={1}>
              {place.address}
            </Text>
          ) : null}
        </View>
      </View>

      {meetup.meet_at || meetup.note ? (
        <Text variant="label">{[meetup.meet_at ? `🕒 ${formatClock(meetup.meet_at)}` : null, meetup.note].filter(Boolean).join(' · ')}</Text>
      ) : null}
      {meetup.etas.length > 0 ? (
        <Text variant="label" color="textSecondary">
          {`Paylaşıldığında: ${meetupEtaLine(meetup, names, myUid)}`}
        </Text>
      ) : null}
      {live}

      {mine ? (
        <View style={{ gap: spacing.xxs }} testID="meetup-responses">
          {responseRows(meetup, names).map((r) => (
            <Text key={r.uid} variant="label" color={r.response === 'accepted' ? 'live' : r.response === 'declined' ? 'danger' : 'textSecondary'}>
              {r.text}
            </Text>
          ))}
        </View>
      ) : (
        <View style={[styles.row, { gap: spacing.xs }]}>
          {(['accepted', 'declined'] as const).map((r) => (
            <Pressable
              key={r}
              accessibilityRole="button"
              accessibilityState={{ selected: myResponse === r, busy: busy === r }}
              accessibilityLabel={MEETUP_RESPONSE_TEXT[r]}
              onPress={() => void respond(r)}
              disabled={busy !== null}
              style={({ pressed }) => [
                styles.respond,
                {
                  borderRadius: radius.md,
                  borderColor: myResponse === r ? (r === 'accepted' ? colors.live : colors.danger) : colors.border,
                  backgroundColor: myResponse === r ? (r === 'accepted' ? colors.liveSoft : colors.dangerSoft) : pressed ? colors.surfaceAlt : colors.surface,
                },
              ]}
            >
              {busy === r ? <ActivityIndicator color={colors.textSecondary} size="small" /> : null}
              <Text variant="heading" style={{ color: myResponse === r ? (r === 'accepted' ? colors.live : colors.danger) : colors.text }}>
                {r === 'accepted' ? `👍 ${MEETUP_RESPONSE_TEXT[r]}` : MEETUP_RESPONSE_TEXT[r]}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {error ? (
        <Text variant="label" color="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}

      <Button title="Yol tarifi" onPress={openDirections} />
      <View style={[styles.row, { gap: spacing.xs }]}>
        {mine ? <Button title="Öneriyi iptal et" variant="danger" onPress={cancel} loading={busy === 'cancel'} block={false} style={styles.flex} /> : null}
        <Button title="Kapat" variant="secondary" onPress={onClose} block={false} style={styles.flex} />
      </View>
    </View>
  );
}

/** Odakta kart yokken aktif buluşma önerileri (en çok 2 satır). */
export function MeetupPills({ meetups, myUid, onOpen }: { meetups: readonly Meetup[]; myUid: UserId | null; onOpen: (m: Meetup) => void }) {
  const { colors, radius, spacing } = useTheme();
  if (meetups.length === 0) return null;
  return (
    <View style={{ gap: spacing.xxs }}>
      {meetups.slice(0, 2).map((m) => (
        <Pressable
          key={m.meetup_id}
          accessibilityRole="button"
          accessibilityLabel={`Buluşma önerisi: ${m.place.name}`}
          onPress={() => onOpen(m)}
          testID={`meetup-pill-${m.meetup_id}`}
          style={({ pressed }) => [
            styles.pill,
            cardShadow,
            { backgroundColor: pressed ? colors.surfaceAlt : colors.surface, borderRadius: radius.pill, paddingHorizontal: spacing.md, gap: spacing.xs },
          ]}
        >
          <Text variant="label" numberOfLines={1} style={styles.flex}>
            {`${meetupPlaceEmoji(m.place)} ${m.place.name} · ${m.from === myUid ? 'senin önerin' : m.from_name}`}
          </Text>
          <Text variant="label" color="primary">
            Göster
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  emoji: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  respond: { flex: 1, minHeight: MIN_TOUCH + 4, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
  pill: { flexDirection: 'row', alignItems: 'center', minHeight: MIN_TOUCH },
});
