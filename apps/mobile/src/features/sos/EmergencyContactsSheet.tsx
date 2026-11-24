/**
 * Faz 4: acil durum kişileri seçimi (@gorhom/bottom-sheet). En çok `SOS_LIMITS.maxContacts` (5) kabul edilmiş
 * arkadaş. Kaydet → `sosStore.setEmergencyContacts` (emergency_contacts_set). SOS akışından açıldıysa kayıttan
 * sonra `onSaved` akışı sürdürür (doğrudan geri sayım). Arkadaşlar ekranından da açılır.
 */
import { SOS_LIMITS, type UserId } from '@konum/core';
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useRouter } from 'expo-router';
import { useCallback, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFriends } from '../../state/friendsStore';
import { sosStore, useSosStore } from '../../state/sosStore';
import { Button, SheetHeader, Text, useTheme } from '../../ui';
import { RecipientPicker } from '../share/RecipientPicker';

export interface EmergencyContactsSheetHandle {
  /** `fromSos`: SOS akışından açıldı (kayıttan sonra `onSaved(true)`). */
  present: (fromSos?: boolean) => void;
  dismiss: () => void;
}

export interface EmergencyContactsSheetProps {
  onSaved?: (fromSos: boolean) => void;
  ref?: Ref<EmergencyContactsSheetHandle>;
}

export function EmergencyContactsSheet({ onSaved, ref }: EmergencyContactsSheetProps) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sheet = useRef<BottomSheetModal>(null);
  const friends = useFriends();
  const saving = useSosStore((s) => s.contactsSaving);
  const [selected, setSelected] = useState<ReadonlySet<UserId>>(new Set());
  const [fromSos, setFromSos] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      present: (sos = false) => {
        setFromSos(sos);
        setError(null);
        setSelected(new Set(sosStore.getState().emergencyContacts));
        sheet.current?.present();
      },
      dismiss: () => sheet.current?.dismiss(),
    }),
    [],
  );

  const toggle = (uid: UserId) => {
    if (!selected.has(uid) && selected.size >= SOS_LIMITS.maxContacts) {
      setError(`En çok ${SOS_LIMITS.maxContacts} acil durum kişisi seçebilirsin.`);
      return;
    }
    setError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  const save = async () => {
    // Seçim sırası korunur (sunucu da sırayı korur).
    const ids = [...selected];
    const r = await sosStore.getState().setEmergencyContacts(ids);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    sheet.current?.dismiss();
    onSaved?.(fromSos && ids.length > 0);
  };

  const renderBackdrop = useCallback(
    (p: BottomSheetBackdropProps) => <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
    [],
  );

  return (
    <BottomSheetModal
      ref={sheet}
      snapPoints={['85%']}
      enableDynamicSizing={false}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: colors.surface }}
      handleIndicatorStyle={{ backgroundColor: colors.border }}
      keyboardBehavior="interactive"
      android_keyboardInputMode="adjustResize"
    >
      <BottomSheetScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl, gap: spacing.md }} keyboardShouldPersistTaps="handled">
        <SheetHeader
          title="Acil durum kişileri"
          subtitle={
            fromSos
              ? 'SOS uyarısını kime gönderelim? Seçip kaydedince geri sayım başlar.'
              : `SOS uyarın tam konumunla bu kişilere gider. En çok ${SOS_LIMITS.maxContacts} kişi.`
          }
          onClose={() => sheet.current?.dismiss()}
        />
        <Text variant="heading" style={{ paddingHorizontal: spacing.md }}>
          {`Kişiler (${selected.size}/${SOS_LIMITS.maxContacts})`}
        </Text>
        <RecipientPicker
          friends={friends}
          selected={selected}
          onToggle={toggle}
          onAddFriend={() => {
            sheet.current?.dismiss();
            router.push('/friends');
          }}
        />
        <View style={{ paddingHorizontal: spacing.md, gap: spacing.xs }}>
          {error ? (
            <Text variant="label" color="danger" accessibilityLiveRegion="assertive">
              {error}
            </Text>
          ) : null}
          <Button
            title={fromSos ? 'Kaydet ve devam et' : 'Kaydet'}
            size="lg"
            variant={fromSos ? 'danger' : 'primary'}
            onPress={() => void save()}
            loading={saving}
            disabled={fromSos && selected.size === 0}
          />
        </View>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
