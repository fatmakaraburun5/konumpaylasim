/**
 * Faz 6: uygulama içi "1 sa" düğmesi — favori kişiye tek dokunuşla 1 saatlik canlı konum paylaşımı.
 *
 *  - Aktif paylaşım yoksa "⏱ 1 sa"; varsa kalan süre ("⏱ 42 dk", süresizse "Paylaşılıyor"). Basınca kural
 *    `runQuickShare` (core `quickShareExpiry`): yoksa başlar, 60 dk'dan azsa 60 dk'ya uzar, fazlaysa dokunulmaz.
 *  - Konum izni gerekiyorsa önce mevcut izin akışı (PermissionFlow) açılır; reddedilirse paylaşım başlamaz.
 *  - Hata (bağlantı yok, arkadaş değil) kısa bir uyarıyla gösterilir.
 */
import { formatCountdown, QUICK_SHARE_DURATION, type UserId } from '@konum/core';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet } from 'react-native';
import { useNow } from '../../lib/useNow';
import { quickShareStore, useQuickShareStore } from '../../state/quickShareStore';
import { useSharingStore } from '../../state/sharingStore';
import { MIN_TOUCH, Text, useTheme } from '../../ui';
import { needsPermissionFlow, PermissionFlow, type PermissionResult } from '../permissions/PermissionFlow';
import { shareContextOf } from '../permissions/permissionPlanner';
import { activeShareTo, QUICK_STATUS_TEXT, quickShareFailureView } from './quickShareModel';

export interface QuickShareButtonProps {
  uid: UserId;
  name: string;
  compact?: boolean;
}

export function QuickShareButton({ uid, name, compact = true }: QuickShareButtonProps) {
  const { colors, radius, spacing } = useTheme();
  const state = useSharingStore((s) => s.state);
  const running = useQuickShareStore((s) => !!s.running[uid]);
  const now = useNow(15_000);
  const [permVisible, setPermVisible] = useState(false);
  const active = activeShareTo(state, uid, now);
  const ctx = shareContextOf(QUICK_SHARE_DURATION, now);

  const label = active ? (active.expires_at === null ? 'Paylaşılıyor' : `⏱ ${formatCountdown(active.expires_at - now)}`) : '⏱ 1 sa';

  const run = async () => {
    const r = await quickShareStore.getState().run(uid, 'app');
    if (!r.ok) Alert.alert('Paylaşım başlatılamadı', quickShareFailureView(r.error.code).text);
    else if (r.status === 'already_active') Alert.alert(name, QUICK_STATUS_TEXT.already_active);
  };

  const onPress = async () => {
    if (running) return;
    if (await needsPermissionFlow(ctx)) setPermVisible(true);
    else await run();
  };

  const onPermDone = (r: PermissionResult | null) => {
    setPermVisible(false);
    if (r?.foreground) void run();
    else if (r) Alert.alert('Konum izni gerekli', quickShareFailureView('permission_denied').text);
  };

  return (
    <>
      <Pressable
        testID={`quick-share-${uid}`}
        onPress={() => void onPress()}
        disabled={running}
        accessibilityRole="button"
        accessibilityLabel={active ? `${name} ile paylaşım sürüyor, ${label}. 1 saate uzat` : `${name} ile 1 saatlik konum paylaşımı başlat`}
        accessibilityState={{ busy: running }}
        hitSlop={6}
        style={({ pressed }) => [
          styles.btn,
          {
            minHeight: compact ? 36 : MIN_TOUCH,
            borderRadius: radius.pill,
            paddingHorizontal: spacing.sm,
            backgroundColor: active ? colors.liveSoft : pressed ? colors.primarySoft : colors.surfaceAlt,
            borderColor: active ? colors.live : colors.primary,
          },
        ]}
      >
        {running ? <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: 6 }} /> : null}
        <Text variant="label" numberOfLines={1} style={{ color: active ? colors.live : colors.primary }}>
          {label}
        </Text>
      </Pressable>
      <PermissionFlow visible={permVisible} context={ctx} onDone={onPermDone} />
    </>
  );
}

const styles = StyleSheet.create({
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
});
