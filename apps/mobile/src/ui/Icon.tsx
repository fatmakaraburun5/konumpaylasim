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
  | 'route'
  // Faz 6
  | 'star'
  | 'starFilled'
  | 'chevronUp'
  | 'chevronDown'
  | 'camera'
  | 'image'
  | 'user'
  // Faz 8
  | 'eye'
  | 'eyeOff'
  // Faz 7
  | 'calendar'
  | 'sun'
  | 'moon'
  | 'themeAuto'
  | 'shield'
  | 'bell'
  | 'mapPin';

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
      {(name === 'star' || name === 'starFilled') && (
        <Path
          d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z"
          {...common}
          fill={name === 'starFilled' ? color : 'none'}
        />
      )}
      {name === 'chevronUp' && <Path d="M5 15l7-7 7 7" {...common} />}
      {name === 'chevronDown' && <Path d="M5 9l7 7 7-7" {...common} />}
      {name === 'camera' && (
        <>
          <Path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z" {...common} />
          <Circle cx={12} cy={13} r={3.5} {...common} />
        </>
      )}
      {name === 'image' && (
        <>
          <Path d="M4 4h16a1 1 0 011 1v14a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1z" {...common} />
          <Circle cx={9} cy={9.5} r={1.8} {...common} />
          <Path d="M3.5 17l5-5 4 4 2.5-2.5 5.5 5.5" {...common} />
        </>
      )}
      {name === 'user' && (
        <>
          <Circle cx={12} cy={8.5} r={4} {...common} />
          <Path d="M4 20.5c1-4 4.2-6 8-6s7 2 8 6" {...common} />
        </>
      )}
      {name === 'eye' && (
        <>
          <Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" {...common} />
          <Circle cx={12} cy={12} r={3} {...common} />
        </>
      )}
      {name === 'eyeOff' && (
        <>
          <Path d="M9.9 5.8A9.6 9.6 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 01-2.6 3.4M6.4 7.1C3.9 8.8 2.5 12 2.5 12S6 18.5 12 18.5c1.7 0 3.2-.5 4.5-1.2" {...common} />
          <Path d="M9.9 9.9a3 3 0 004.2 4.2M3 3l18 18" {...common} />
        </>
      )}
      {name === 'calendar' && (
        <>
          <Path d="M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z" {...common} />
          <Path d="M4 10h16M8 3v4M16 3v4" {...common} />
        </>
      )}
      {name === 'sun' && (
        <>
          <Circle cx={12} cy={12} r={4} {...common} />
          <Path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" {...common} />
        </>
      )}
      {name === 'moon' && <Path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" {...common} />}
      {name === 'themeAuto' && (
        <>
          <Circle cx={12} cy={12} r={8.5} {...common} />
          <Path d="M12 3.5a8.5 8.5 0 010 17z" fill={color} stroke="none" />
        </>
      )}
      {name === 'shield' && (
        <>
          <Path d="M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z" {...common} />
          <Path d="M8.8 12.2l2.2 2.2 4.2-4.4" {...common} />
        </>
      )}
      {name === 'bell' && (
        <>
          <Path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z" {...common} />
          <Path d="M10 20.5a2 2 0 004 0" {...common} />
        </>
      )}
      {name === 'mapPin' && (
        <>
          <Path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0113 0c0 4.8-6.5 11-6.5 11z" {...common} />
          <Circle cx={12} cy={10} r={2.3} {...common} />
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
