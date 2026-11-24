import Svg, { Circle } from 'react-native-svg';
import { useTheme } from '../../ui';

/** Kalan süre halkası: `progress` 1 → dolu, 0 → boş. */
export function ProgressRing({ progress, size = 44, stroke = 4, color }: { progress: number; size?: number; stroke?: number; color?: string }) {
  const { colors } = useTheme();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, progress));
  return (
    <Svg width={size} height={size} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.surfaceAlt} strokeWidth={stroke} fill="none" />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color ?? colors.live}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={[c, c]}
        strokeDashoffset={c * (1 - p)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </Svg>
  );
}
