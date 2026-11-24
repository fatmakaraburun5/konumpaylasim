/** Satır içi SVG simgeler (dış istek yok). Hepsi `currentColor`. */
type P = { size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export const ClockIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const TargetIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const BatteryIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <rect x="2.5" y="7" width="17" height="10" rx="2.5" />
    <path d="M22 11v2" />
    <path d="M6 10.5v3" />
    <path d="M9.5 10.5v3" />
  </svg>
);

/** Faz 3: düşük pil (tek dilim). */
export const BatteryLowIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <rect x="2.5" y="7" width="17" height="10" rx="2.5" />
    <path d="M22 11v2" />
    <path d="M6 10.5v3" />
  </svg>
);

/** Faz 3: çevrimdışı noktalar eşitlendi. */
export const CloudCheckIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1 0 8.5H7Z" />
    <path d="m9.5 13.5 2 2 3.5-3.5" />
  </svg>
);

export const PhoneIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <rect x="6" y="2.5" width="12" height="19" rx="3" />
    <path d="M11 18.5h2" />
  </svg>
);

export const MapIcon = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Z" />
    <path d="M9 4v14M15 6v14" />
  </svg>
);

export const EndedIcon = ({ size = 26 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9" />
    <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
  </svg>
);

export const LinkOffIcon = ({ size = 26 }: P) => (
  <svg {...base(size)}>
    <path d="M9.5 14.5 7.8 16.2a3.2 3.2 0 0 1-4.5-4.5L5 10" />
    <path d="M14.5 9.5l1.7-1.7a3.2 3.2 0 0 1 4.5 4.5L19 14" />
    <path d="M3 3l18 18" />
  </svg>
);

export const WifiOffIcon = ({ size = 26 }: P) => (
  <svg {...base(size)}>
    <path d="M2 8.5a15 15 0 0 1 5-3M22 8.5A15 15 0 0 0 12 5" />
    <path d="M5.5 12a10 10 0 0 1 3-2M18.5 12a10 10 0 0 0-2.6-1.8" />
    <path d="M9 15.5a4.5 4.5 0 0 1 6 0" />
    <circle cx="12" cy="19" r="1" fill="currentColor" />
    <path d="M3 3l18 18" />
  </svg>
);

export const HourglassIcon = ({ size = 26 }: P) => (
  <svg {...base(size)}>
    <path d="M7 3h10M7 21h10" />
    <path d="M8 3c0 4 8 5 8 9s-8 5-8 9M16 3c0 4-8 5-8 9s8 5 8 9" />
  </svg>
);

export const AlertIcon = ({ size = 26 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5.5" />
    <circle cx="12" cy="16.5" r="0.6" fill="currentColor" />
  </svg>
);

export const AppleIcon = ({ size = 20 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.8-.8-3-.8-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.3-2.6 1.3-2.6s-2.5-1-2.5-3.8ZM14.1 5.8c.6-.8 1.1-1.8 1-2.8-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.7-1 2.7 1 .1 2-.5 2.7-1.3Z"
    />
  </svg>
);

export const PlayIcon = ({ size = 20 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M4.5 2.8c-.3.2-.5.6-.5 1.1v16.2c0 .5.2.9.5 1.1l9.1-9.2-9.1-9.2Z" opacity=".9" />
    <path fill="currentColor" d="m16.6 15.1-3-3.1-9.1 9.2c.4.3 1 .3 1.6 0l10.5-6.1Z" opacity=".7" />
    <path fill="currentColor" d="m16.6 8.9-10.5-6.1c-.6-.3-1.2-.3-1.6 0l9.1 9.2 3-3.1Z" opacity=".8" />
    <path fill="currentColor" d="m20.2 11-3.6-2.1-3 3.1 3 3.1 3.6-2.1c.9-.5.9-1.5 0-2Z" />
  </svg>
);

export const BrandMark = ({ size = 18 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7Zm0 9.6a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2Z" />
  </svg>
);
