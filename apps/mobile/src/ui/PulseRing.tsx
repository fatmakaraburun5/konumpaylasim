/**
 * Faz 4: nabız halkası (ping vurgusu, SOS pini). Halka `size` çapında başlar, büyüyüp söner; döngü sürer.
 * Native'de harita işaretçisi içinde kullanılırken işaretçi `tracksViewChanges` açık tutulmalıdır.
 */
import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet } from 'react-native';

export interface PulseRingProps {
  size: number;
  color: string;
  /** Halkanın ulaştığı ölçek (varsayılan 1.7). */
  scaleTo?: number;
  durationMs?: number;
}

const NATIVE_DRIVER = Platform.OS !== 'web';

export function PulseRing({ size, color, scaleTo = 1.7, durationMs = 1_200 }: PulseRingProps) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(t, { toValue: 1, duration: durationMs, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE_DRIVER }));
    loop.start();
    return () => loop.stop();
  }, [t, durationMs]);
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.ring,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          marginLeft: -size / 2,
          marginTop: -size / 2,
          borderColor: color,
          backgroundColor: color + '33',
          opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.85, 0] }),
          transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [1, scaleTo] }) }],
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  ring: { position: 'absolute', left: '50%', top: '50%', borderWidth: 3 },
});
