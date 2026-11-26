/**
 * Faz 9: gönderen tarafı kısa bilgi — "Neredeyse vardım" raporu gidince `APPROACH_TEXT.sentToast(n)` birkaç saniye
 * görünür (harita üst şeridinde). Yalnızca bu oturumda yeni gelen rapor gösterilir.
 */
import { APPROACH_TEXT } from '@konum/core';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useDestinationStore } from '../../state/destinationStore';
import { cardShadow, Text, useTheme } from '../../ui';

const SHOW_MS = 4_000;

export function ApproachToast() {
  const { colors, radius, spacing } = useTheme();
  const report = useDestinationStore((s) => s.lastReport);
  const hydrated = useDestinationStore((s) => s.hydrated);
  const seen = useRef<number | null | undefined>(undefined);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) return;
    const at = report?.at ?? null;
    // İlk değer (açılışta diskten gelen eski rapor) gösterilmez.
    if (seen.current === undefined) {
      seen.current = at;
      return;
    }
    if (at === seen.current) return;
    seen.current = at;
    if (report && report.status === 'sent') setText(APPROACH_TEXT.sentToast(report.notified_count));
  }, [report, hydrated]);

  useEffect(() => {
    if (!text) return;
    const t = setTimeout(() => setText(null), SHOW_MS);
    return () => clearTimeout(t);
  }, [text]);

  if (!text) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      testID="approach-toast"
      style={[cardShadow, { marginHorizontal: spacing.md, backgroundColor: colors.liveSoft, borderColor: colors.live, borderWidth: 1, borderRadius: radius.md, padding: spacing.sm }]}
    >
      <Text variant="label" style={{ color: colors.live }}>
        {`🏁 ${text}`}
      </Text>
    </View>
  );
}
