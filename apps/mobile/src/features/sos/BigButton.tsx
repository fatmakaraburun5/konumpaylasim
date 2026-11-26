/**
 * Faz 4: SOS ekranlarının büyük düğmesi (en az 64 pt; kırmızı zeminde beyaz). Faz 9: SosCountdown'dan ayrıldı
 * (çevrimdışı SMS paneli ve Güvenli Dönüş son uyarısı da kullanır); `SosCountdown` aynı adla yeniden dışa aktarır.
 */
import { Pressable, StyleSheet } from 'react-native';
import { lightColors, Text, useTheme } from '../../ui';
import { SOS_FG } from './sosModel';

/** Büyük dokunma alanlı düğme (en az 64 pt). `solid`: beyaz zemin, kırmızı yazı. */
export function BigButton({
  title,
  onPress,
  solid = false,
  disabled = false,
  hint,
  small = false,
}: {
  title: string;
  onPress: () => void;
  solid?: boolean;
  disabled?: boolean;
  hint?: string;
  /** Yan yana iki düğme için daha küçük yazı. */
  small?: boolean;
}) {
  const { radius } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.btn,
        {
          borderRadius: radius.lg,
          backgroundColor: solid ? (pressed ? lightColors.dangerSoft : SOS_FG) : pressed ? 'rgba(255,255,255,0.18)' : 'transparent',
          borderColor: SOS_FG,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Text variant={small ? 'heading' : 'title'} style={{ color: solid ? lightColors.danger : SOS_FG }} numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { minHeight: 64, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
});
