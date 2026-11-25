/**
 * Faz 8: "İzin iste" düğmesi (ping satırı, Kişi izinleri). Bekleyen istek varsa "İstek gönderildi" yazar; soğuma
 * hatası (`permission_cooldown`) kısa bir notla gösterilir, düğme kapanmaz.
 */
import { ACCESS_TEXT, type RequestableScope, type UserId } from '@konum/core';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { grantsStore, useGrantsStore, useMyPendingRequestTo } from '../../state/grantsStore';
import { MIN_TOUCH, Text, useTheme } from '../../ui';
import { requestFeedback } from './accessModel';

export interface RequestPermissionButtonProps {
  to: UserId;
  name: string;
  scopes: readonly RequestableScope[];
  label?: string;
  compact?: boolean;
  testID?: string;
}

const FEEDBACK_MS = 4_000;

export function RequestPermissionButton({ to, name, scopes, label = ACCESS_TEXT.requestAction, compact = false, testID }: RequestPermissionButtonProps) {
  const { colors, radius, spacing } = useTheme();
  const pending = useMyPendingRequestTo(to);
  const busy = useGrantsStore((s) => !!s.busy[`request:${to}`]);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const allPending = scopes.length > 0 && scopes.every((s) => pending.includes(s));

  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), FEEDBACK_MS);
    return () => clearTimeout(t);
  }, [feedback]);

  const send = async () => {
    const r = await grantsStore.getState().request(to, scopes);
    setFeedback(requestFeedback(r));
  };

  if (allPending && !feedback) {
    return (
      <View style={[styles.pending, { minHeight: compact ? 36 : MIN_TOUCH }]} testID={testID ? `${testID}-pending` : undefined}>
        <Text variant="label" color="textSecondary">
          İstek gönderildi
        </Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 2 }}>
      <Pressable
        testID={testID}
        onPress={() => void send()}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={`${name} kişisinden ${label.toLocaleLowerCase('tr-TR')}`}
        accessibilityState={{ busy, disabled: busy }}
        hitSlop={compact ? 6 : 4}
        style={({ pressed }) => [
          styles.btn,
          {
            minHeight: compact ? 36 : MIN_TOUCH,
            borderRadius: radius.pill,
            paddingHorizontal: compact ? spacing.sm : spacing.md,
            backgroundColor: pressed ? colors.primarySoft : colors.surface,
            borderColor: colors.primary,
          },
        ]}
      >
        {busy ? <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: 6 }} /> : null}
        <Text variant="label" color="primary" numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
      {feedback ? (
        <Text variant="caption" style={{ color: feedback.ok ? colors.live : colors.warning }} accessibilityLiveRegion="polite" numberOfLines={2}>
          {feedback.text}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, alignSelf: 'flex-start' },
  pending: { justifyContent: 'center' },
});
