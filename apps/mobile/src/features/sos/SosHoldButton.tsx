/**
 * Faz 4: haritanın sağ altındaki kırmızı SOS düğmesi. BASILI TUT (core `SOS_LIMITS.holdMs`): halka dolar
 * (core `sosHoldProgress`); erken bırakma iptaldir ve "Göndermek için basılı tut" ipucu görünür. Ekran okuyucu
 * kullanıcıları için `activate` erişilebilirlik eylemi doğrudan geri sayımı açar (güvenlik geri sayımdadır).
 * Durum makinesi çağıranda (`SosLauncher`, core `sosFlowReduce`); bu bileşen yalnızca olayları iletir.
 */
import { SOS_LIMITS, type SosFlowEvent } from '@konum/core';
import { Pressable, StyleSheet, View } from 'react-native';
import { lightColors, Text, useTheme } from '../../ui';
import { ProgressRing } from '../map/ProgressRing';
import { SOS_FG } from './sosModel';

export interface SosHoldButtonProps {
  /** 0..1 basılı tutma ilerlemesi. */
  progress: number;
  onEvent: (e: SosFlowEvent) => void;
  /** Erken bırakma ipucu görünüyor mu. */
  hint: boolean;
  size?: number;
}

export function SosHoldButton({ progress, onEvent, hint, size = 60 }: SosHoldButtonProps) {
  const { colors, radius, spacing } = useTheme();
  const ring = size + 12;
  return (
    <View style={styles.wrap} pointerEvents="box-none">
      {hint ? (
        <View
          accessibilityLiveRegion="assertive"
          style={[styles.hint, { backgroundColor: colors.text, borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.xxs, right: 0, bottom: ring + 6 }]}
        >
          <Text variant="label" style={{ color: colors.bg }} numberOfLines={1}>
            Göndermek için basılı tut
          </Text>
        </View>
      ) : null}
      <View style={{ width: ring, height: ring, alignItems: 'center', justifyContent: 'center' }}>
        {progress > 0 ? (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <ProgressRing progress={progress} size={ring} stroke={5} color={lightColors.danger} />
          </View>
        ) : null}
        <Pressable
          onPressIn={() => onEvent({ type: 'press_in', at: Date.now() })}
          onPressOut={() => onEvent({ type: 'press_out', at: Date.now() })}
          accessibilityRole="button"
          accessibilityLabel="Acil durum SOS"
          accessibilityHint={`Acil durum kişilerine tam konumunla uyarı göndermek için ${(SOS_LIMITS.holdMs / 1000).toLocaleString('tr-TR')} saniye basılı tut. Gönderilmeden önce ${SOS_LIMITS.countdownS} saniye iptal süresi vardır.`}
          accessibilityActions={[{ name: 'activate', label: 'Acil durum geri sayımını başlat' }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'activate') onEvent({ type: 'a11y_activate', at: Date.now() });
          }}
          testID="sos-button"
          style={({ pressed }) => [
            styles.btn,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: lightColors.danger,
              borderColor: SOS_FG,
              transform: [{ scale: pressed ? 0.94 : 1 }],
              boxShadow: '0px 6px 18px rgba(185, 28, 28, 0.45)',
            },
          ]}
        >
          <Text variant="heading" style={{ color: SOS_FG, fontWeight: '800', letterSpacing: 1 }} maxFontSizeMultiplier={1}>
            SOS
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'flex-end' },
  hint: { position: 'absolute' },
  btn: { alignItems: 'center', justifyContent: 'center', borderWidth: 3 },
});
