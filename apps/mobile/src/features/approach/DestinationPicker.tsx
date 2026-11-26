/**
 * Faz 9: paylaşım hedefi seçici (@gorhom/bottom-sheet) — docs/PHASE9.md §2.1.
 *
 *   şu anki hedef + durum ("Hedef: Ev · Neredeyse vardın") · "Hedefi kaldır"
 *   Kayıtlı bölgeler (Ev / İş …) · Etkinlik mekanı · Buluşma noktası
 *   Haritadan seç: haritaya uzun bas → kartta "🏁 Hedefim yap"
 *
 * Hedefin koordinatı telefondan çıkmaz; alıcılar yalnızca adı ve durumu görür. Hedefe 200 m kala konumunu görenlere bir
 * kez "Neredeyse vardım (1 dk)" bildirimi gider (konum hattı; bkz. destinationStore).
 */
import { APPROACH_TEXT, type Zone } from '@konum/core';
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useCallback, useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNow } from '../../lib/useNow';
import { useAuthStore } from '../../state/authStore';
import { destinationStore, selectDestinationStatus, useDestinationStore } from '../../state/destinationStore';
import { useEventsStore } from '../../state/eventsStore';
import { selectMeetups, useMeetupStore } from '../../state/meetupStore';
import { useShareSessions } from '../../state/sharingStore';
import { useZonesStore } from '../../state/zonesStore';
import { Button, Chip, SheetHeader, Text, useTheme } from '../../ui';
import { eventMeetupOptions, myDestStatusText } from './destModel';

export interface DestinationPickerHandle {
  present: () => void;
  dismiss: () => void;
}

export interface DestinationPickerProps {
  /** "Haritadan seç": sayfa kapanır, kullanıcı haritaya uzun basar. */
  onPickOnMap?: () => void;
  ref?: Ref<DestinationPickerHandle>;
}

const RUNNING = new Set(['starting', 'active', 'expiring_soon', 'extending']);

export function DestinationPicker({ onPickOnMap, ref }: DestinationPickerProps) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const sheet = useRef<BottomSheetModal>(null);
  const now = useNow(30_000);
  const myUid = useAuthStore((s) => s.uid);
  const destination = useDestinationStore((s) => s.destination);
  const approach = useDestinationStore((s) => s.approach);
  const status = useMemo(() => selectDestinationStatus({ destination, approach }), [destination, approach]);
  const zonesMap = useZonesStore((s) => s.zones);
  const zones = useMemo(() => Object.values(zonesMap).filter((z) => z.enabled), [zonesMap]);
  const eventsMap = useEventsStore((s) => s.events);
  const meetupsMap = useMeetupStore((s) => s.meetups);
  const options = useMemo(
    () => eventMeetupOptions(Object.values(eventsMap), selectMeetups({ meetups: meetupsMap }, myUid), now),
    [eventsMap, meetupsMap, myUid, now],
  );
  const sharing = useShareSessions().some((s) => RUNNING.has(s.phase));

  useImperativeHandle(ref, () => ({ present: () => sheet.current?.present(), dismiss: () => sheet.current?.dismiss() }), []);

  const pickZone = async (z: Zone) => {
    await destinationStore.getState().setZoneDestination(z);
    sheet.current?.dismiss();
  };

  const renderBackdrop = useCallback(
    (p: BottomSheetBackdropProps) => <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
    [],
  );

  return (
    <BottomSheetModal
      ref={sheet}
      snapPoints={['70%']}
      enableDynamicSizing={false}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: colors.surface }}
      handleIndicatorStyle={{ backgroundColor: colors.border }}
    >
      <BottomSheetScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl, gap: spacing.md }}>
        <SheetHeader title={APPROACH_TEXT.pickTitle} subtitle={APPROACH_TEXT.pickHint} onClose={() => sheet.current?.dismiss()} />

        {destination ? (
          <View style={{ paddingHorizontal: spacing.md, gap: spacing.xs }} testID="destination-current">
            <Text variant="heading" accessibilityLiveRegion="polite">
              {myDestStatusText(destination.name, status)}
            </Text>
            <Button
              title={APPROACH_TEXT.clear}
              variant="danger"
              onPress={() => {
                void destinationStore.getState().clear();
                sheet.current?.dismiss();
              }}
              testID="destination-clear"
            />
          </View>
        ) : null}

        {!sharing ? (
          <Text variant="caption" color="textSecondary" style={{ paddingHorizontal: spacing.md }}>
            Hedef, arkadaşlarınla konum paylaşırken kullanılır; paylaşım bitince kendiliğinden kalkar.
          </Text>
        ) : null}

        <View style={{ gap: spacing.xs }}>
          <Text variant="heading" style={{ paddingHorizontal: spacing.md }}>
            {APPROACH_TEXT.fromZones}
          </Text>
          {zones.length === 0 ? (
            <Text variant="caption" color="textSecondary" style={{ paddingHorizontal: spacing.md }}>
              Kayıtlı bölgen yok. Menü › Bölgelerim'den Ev ya da İş ekleyebilirsin.
            </Text>
          ) : (
            <View style={[styles.wrap, { paddingHorizontal: spacing.md, gap: spacing.xs }]}>
              {zones.map((z) => (
                <Chip
                  key={z.zone_id}
                  label={`${z.emoji ?? '📍'} ${z.name}`}
                  selected={destination?.kind === 'zone' && destination.ref_id === z.zone_id}
                  onPress={() => void pickZone(z)}
                  testID={`destination-zone-${z.zone_id}`}
                />
              ))}
            </View>
          )}
        </View>

        {options.length > 0 ? (
          <View style={{ gap: spacing.xs }}>
            <Text variant="heading" style={{ paddingHorizontal: spacing.md }}>
              {`${APPROACH_TEXT.fromEvent} / ${APPROACH_TEXT.fromMeetup}`}
            </Text>
            <View style={[styles.wrap, { paddingHorizontal: spacing.md, gap: spacing.xs }]}>
              {options.map((o) => (
                <Chip
                  key={o.key}
                  label={o.label}
                  selected={destination?.kind === o.kind && destination.ref_id === o.ref_id}
                  onPress={() => {
                    void destinationStore.getState().setDestination({ kind: o.kind, ref_id: o.ref_id, name: o.name, center: o.center, radius_m: o.radius_m });
                    sheet.current?.dismiss();
                  }}
                />
              ))}
            </View>
          </View>
        ) : null}

        <View style={{ paddingHorizontal: spacing.md, gap: spacing.xs }}>
          <Text variant="heading">{APPROACH_TEXT.fromMap}</Text>
          <Text variant="caption" color="textSecondary">
            Haritada bir noktaya uzun bas, açılan kartta "🏁 Hedefim yap"a dokun.
          </Text>
          {onPickOnMap ? (
            <Button
              title={APPROACH_TEXT.fromMap}
              variant="secondary"
              onPress={() => {
                sheet.current?.dismiss();
                onPickOnMap();
              }}
            />
          ) : null}
        </View>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
});
