/**
 * Küçük SVG ikon seti (ek bir ikon paketine bağımlı olmamak için). 24x24 ızgara, çizgi ikonlar.
 */
import Svg, { Circle, Path } from 'react-native-svg';

export type IconName =
  | 'crosshair'
  | 'close'
  | 'plus'
  | 'check'
  | 'search'
  | 'users'
  | 'share'
  | 'minus'
  | 'clock'
  | 'chevronLeft'
  | 'battery'
  | 'qr'
  | 'copy'
  | 'route';

export interface IconProps {
  name: IconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 22, color, strokeWidth = 2 }: IconProps) {
  const common = { stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'crosshair' && (
        <>
          <Circle cx={12} cy={12} r={7} {...common} />
          <Circle cx={12} cy={12} r={2} fill={color} />
          <Path d="M12 2v3M12 19v3M2 12h3M19 12h3" {...common} />
        </>
      )}
      {name === 'close' && <Path d="M6 6l12 12M18 6L6 18" {...common} />}
      {name === 'plus' && <Path d="M12 5v14M5 12h14" {...common} />}
      {name === 'minus' && <Path d="M5 12h14" {...common} />}
      {name === 'check' && <Path d="M5 12.5l4.5 4.5L19 7.5" {...common} />}
      {name === 'search' && (
        <>
          <Circle cx={11} cy={11} r={6.5} {...common} />
          <Path d="M16 16l4.5 4.5" {...common} />
        </>
      )}
      {name === 'users' && (
        <>
          <Circle cx={9} cy={8} r={3.5} {...common} />
          <Path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" {...common} />
          <Path d="M16 4.8a3.3 3.3 0 010 6.4M18 14.8c1.8.7 3 2.4 3.5 5.2" {...common} />
        </>
      )}
      {name === 'share' && (
        <>
          <Path d="M12 3v12M7.5 7.5L12 3l4.5 4.5" {...common} />
          <Path d="M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6" {...common} />
        </>
      )}
      {name === 'clock' && (
        <>
          <Circle cx={12} cy={12} r={8.5} {...common} />
          <Path d="M12 7.5V12l3 2" {...common} />
        </>
      )}
      {name === 'chevronLeft' && <Path d="M15 5l-7 7 7 7" {...common} />}
      {name === 'qr' && (
        <>
          <Path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" {...common} />
          <Path d="M14 14h2v2h-2zM18 14h2M14 18v2M18 18h2v2h-2z" {...common} />
        </>
      )}
      {name === 'copy' && (
        <>
          <Path d="M9 9h10a1 1 0 011 1v10a1 1 0 01-1 1H9a1 1 0 01-1-1V10a1 1 0 011-1z" {...common} />
          <Path d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1" {...common} />
        </>
      )}
      {name === 'route' && (
        <>
          <Circle cx={6} cy={18} r={2.5} {...common} />
          <Circle cx={18} cy={6} r={2.5} {...common} />
          <Path d="M8.5 18H15a3 3 0 000-6H9a3 3 0 010-6h6.5" {...common} />
        </>
      )}
      {name === 'battery' && (
        <>
          <Path d="M3 8h15a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1V9a1 1 0 011-1z" {...common} />
          <Path d="M22 11v2" {...common} />
        </>
      )}
    </Svg>
  );
}
