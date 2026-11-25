/**
 * Faz 4: tek dokunuşla "📍 Buradayım" / "🚶 Yoldayım" (core `PING_TEXT` / `PING_EMOJI`).
 *
 *  - Dokun → `pingStore.send(to, kind)`; "Yoldayım" kart açıkken ETA biliniyorsa `eta_s` ekler.
 *  - Gönderince kısa "Gönderildi" geri bildirimi; soğuma süresince (core `pingCooldownLeftMs`) iki düğme de pasif
 *    ve kalan saniye yazar. Uçuştaki gönderim varken ikinci dokunuş yeni istek açmaz (depo aynı sözü döndürür).
 *  - `compact`: arkadaş listesi satırı için küçük düğmeler.
 *  - Faz 8: ping yalnızca alıcı bana `ping` izni verdiyse gider; yoksa düğmeler yerine "Ping için izin iste".
 *    Görünmezken ya da alıcıya konum izni (`location_view`) vermediysem ETA eklenmez (sunucu da konum ve ETA'yı siler).
 */
import { PING_EMOJI, PING_KINDS, PING_TEXT, pingCooldownLeftMs, type PingKind, type UserId } from '@konum/core';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useNow } from '../../lib/useNow';
import { pingStore, usePingStore } from '../../state/pingStore';
import { MIN_TOUCH, Text, useTheme } from '../../ui';
import { PING_SENT_FEEDBACK_MS } from './pingModel';
import { RequestPermissionButton } from '../access/RequestPermissionButton';
import { useCanFn } from '../access/useAccess';
import { useIsInvisible } from '../../state/invisibleStore';

export interface PingButtonsProps {
  to: UserId;
  /** Alıcının adı (erişilebilirlik etiketi). */
  name: string;
  /** "Yoldayım" ile gönderilecek tahmini varış (sn); yoksa null. */
  etaS?: number | null;
  compact?: boolean;
}

export function PingButtons({ to, name, etaS = null, compact = false }: PingButtonsProps) {
  const { colors, radius, spacing } = useTheme();
  const sending = usePingStore((s) => s.sending[to]);
  const lastSentAt = usePingStore((s) => s.lastSentAt[to]);
  const now = useNow(1_000);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const can = useCanFn();
  const permitted = can('ping', to, 'received');
  const invisible = useIsInvisible();
  // Konum çıkarılan pingte ETA da gitmez (alıcı benden uzaklığımı öğrenmesin).
  const eta = !invisible && can('location_view', to, 'given') ? etaS : null;

  useEffect(() => {
    if (!feedback) return;
    const t = setTimeout(() => setFeedback(null), PING_SENT_FEEDBACK_MS);
    return () => clearTimeout(t);
  }, [feedback]);

  if (!permitted) {
    return <RequestPermissionButton to={to} name={name} scopes={['ping']} label="Ping için izin iste" compact={compact} testID={`ping-request-${to}`} />;
  }

  const cooldownS = Math.ceil(pingCooldownLeftMs(lastSentAt, now) / 1_000);
  const busy = sending !== undefined;

  const send = async (kind: PingKind) => {
    if (busy) return;
    const r = await pingStore.getState().send(to, kind, { eta_s: kind === 'on_way' ? eta : null });
    setFeedback(r.ok ? { ok: true, text: `${PING_EMOJI[kind]} Gönderildi` } : { ok: false, text: r.error.message });
  };

  return (
    <View style={{ gap: spacing.xxs }}>
      <View style={[styles.row, { gap: spacing.xs }]}>
        {PING_KINDS.map((kind) => {
          const disabled = busy || cooldownS > 0;
          const label = `${PING_EMOJI[kind]} ${PING_TEXT[kind]}`;
          return (
            <Pressable
              key={kind}
              onPress={() => void send(kind)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={`${name} kişisine ${PING_TEXT[kind]} gönder`}
              accessibilityHint={kind === 'on_way' && eta ? 'Tahmini varış süren de eklenir' : undefined}
              accessibilityState={{ disabled, busy: sending === kind }}
              hitSlop={compact ? 6 : 4}
              style={({ pressed }) => [
                styles.btn,
                compact ? null : styles.flex,
                {
                  minHeight: compact ? 36 : MIN_TOUCH,
                  borderRadius: radius.pill,
                  paddingHorizontal: compact ? spacing.sm : spacing.md,
                  backgroundColor: pressed ? colors.primarySoft : colors.surfaceAlt,
                  borderColor: colors.border,
                  opacity: disabled && sending !== kind ? 0.5 : 1,
                },
              ]}
            >
              {sending === kind ? <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: 6 }} /> : null}
              <Text variant="label" numberOfLines={1}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {feedback || cooldownS > 0 ? (
        <Text
          variant="caption"
          accessibilityLiveRegion="polite"
          style={{ color: feedback ? (feedback.ok ? colors.live : colors.danger) : colors.textSecondary }}
          numberOfLines={2}
        >
          {feedback ? feedback.text : `Tekrar göndermek için ${cooldownS} sn`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  flex: { flex: 1 },
});
