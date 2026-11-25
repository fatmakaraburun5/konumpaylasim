/**
 * Faz 8: Profil'in en üstündeki "Görünmez ol" kartı (docs/PHASE8.md §5.2).
 *   açarken: onay (n paylaşımın duracak, QR bağlantıların kapanacak, …) → `invisible_set(true)`
 *   kapatırken: görünür olma sayfası (önceki paylaşımlar, hiçbiri seçili değil)
 * Anahtar kontrollüdür: onay verilmeden konumu değişmez.
 */
import { useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { INVISIBLE_TEXT, useInvisibleStore, useIsInvisible } from '../../state/invisibleStore';
import { useOutgoingSosActive } from '../../state/sosStore';
import { cardShadow, Icon, MIN_TOUCH, Text, useTheme } from '../../ui';
import { confirmInvisibleOn, openRestoreFlow } from './invisibleFlow';

export function InvisibleCard() {
  const { colors, radius, spacing } = useTheme();
  const invisible = useIsInvisible();
  const sosActive = useOutgoingSosActive();
  const busy = useInvisibleStore((s) => s.busy);
  const storeError = useInvisibleStore((s) => s.error);
  const [error, setError] = useState<string | null>(null);

  const onChange = (on: boolean) => {
    setError(null);
    if (on) confirmInvisibleOn(setError);
    else openRestoreFlow();
  };

  const shownError = error ?? (invisible ? storeError : null);

  return (
    <View
      testID="profile-invisible-card"
      style={[
        cardShadow,
        {
          backgroundColor: invisible ? colors.primarySoft : colors.surface,
          borderColor: invisible ? colors.primary : 'transparent',
          borderWidth: 1,
          borderRadius: radius.lg,
          padding: spacing.md,
          gap: spacing.xs,
        },
      ]}
    >
      <View style={[styles.row, { gap: spacing.sm, minHeight: MIN_TOUCH }]}>
        <Icon name={invisible ? 'eyeOff' : 'eye'} color={invisible ? colors.primary : colors.textSecondary} />
        <View style={styles.flex}>
          <Text variant="heading">{INVISIBLE_TEXT.cardTitle}</Text>
          <Text variant="label" color="textSecondary" accessibilityLiveRegion="polite" testID="profile-invisible-state">
            {invisible ? (sosActive ? INVISIBLE_TEXT.cardBodyOnSos : INVISIBLE_TEXT.cardBodyOn) : INVISIBLE_TEXT.cardBodyOff}
          </Text>
        </View>
        <Switch
          value={invisible}
          onValueChange={onChange}
          disabled={busy !== null}
          accessibilityLabel={INVISIBLE_TEXT.cardTitle}
          accessibilityHint={invisible ? 'Görünür olurken önceki paylaşımlardan seçebilirsin' : 'Tüm paylaşımların durur'}
          testID="profile-invisible-switch"
        />
      </View>
      {shownError ? (
        <Text variant="label" color="warning" accessibilityLiveRegion="polite">
          {shownError}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
