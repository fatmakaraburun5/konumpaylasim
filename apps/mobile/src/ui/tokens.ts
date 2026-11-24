/**
 * Tasarım belirteçleri (design tokens). Değerler tasarım dosyasıyla BİREBİR aynıdır; değiştirmeyin.
 * Font: tasarımda Inter, React Native'de sistem fontu (fontFamily verilmez).
 */
import type { TextStyle } from 'react-native';

export interface ColorTokens {
  bg: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  textSecondary: string;
  border: string;
  primary: string;
  primaryPressed: string;
  onPrimary: string;
  primarySoft: string;
  live: string;
  liveSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  stale: string;
  mapWater: string;
  mapPark: string;
  mapRoad: string;
  mapLand: string;
}

export const lightColors: ColorTokens = {
  bg: '#F6F7F9',
  surface: '#FFFFFF',
  surfaceAlt: '#EEF2F6',
  text: '#0F172A',
  textSecondary: '#475569',
  border: '#E2E8F0',
  primary: '#2563EB',
  primaryPressed: '#1D4ED8',
  onPrimary: '#FFFFFF',
  primarySoft: '#DBEAFE',
  live: '#15803D',
  liveSoft: '#DCFCE7',
  warning: '#B45309',
  warningSoft: '#FEF3C7',
  danger: '#B91C1C',
  dangerSoft: '#FEE2E2',
  stale: '#64748B',
  mapWater: '#CFE3F5',
  mapPark: '#DDEFD9',
  mapRoad: '#FFFFFF',
  mapLand: '#EEF1F4',
};

export const darkColors: ColorTokens = {
  bg: '#0B1220',
  surface: '#111A2E',
  surfaceAlt: '#18233B',
  text: '#E5E7EB',
  textSecondary: '#A3B1C6',
  border: '#22304D',
  primary: '#3B82F6',
  primaryPressed: '#2563EB',
  onPrimary: '#FFFFFF',
  primarySoft: '#172554',
  live: '#22C55E',
  liveSoft: '#052E16',
  warning: '#F59E0B',
  warningSoft: '#3A2A05',
  danger: '#F87171',
  dangerSoft: '#3B0D0D',
  stale: '#94A3B8',
  // [Varsayım: tasarım onayı bekliyor] Koyu tema harita renkleri tasarımda tanımlı değil;
  // açık tema değerlerinin koyu karşılıkları olarak seçildi.
  mapWater: '#0E2A47',
  mapPark: '#10291E',
  mapRoad: '#1E2B44',
  mapLand: '#0F172A',
};

export const radius = { sm: 8, md: 12, lg: 20, xl: 28, pill: 999 } as const;

/** 4, 8, 12, 16, 20, 24, 32 */
export const spacing = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 20, xl: 24, xxl: 32 } as const;

export type TypeVariant = 'title' | 'heading' | 'body' | 'label' | 'caption';

/** boyut / satır yüksekliği / kalınlık */
export const typography: Record<TypeVariant, Pick<TextStyle, 'fontSize' | 'lineHeight' | 'fontWeight'>> = {
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
};

/** Kart gölgesi: 0 8px 24px rgba(15,23,42,0.12). Yeni mimaride `boxShadow` iki platformda da çalışır. */
export const cardShadow = { boxShadow: '0px 8px 24px rgba(15, 23, 42, 0.12)' } as const;

/** Dokunma hedefi alt sınırı. */
export const MIN_TOUCH = 44;

export interface Theme {
  scheme: 'light' | 'dark';
  colors: ColorTokens;
  radius: typeof radius;
  spacing: typeof spacing;
  typography: typeof typography;
}

export const lightTheme: Theme = { scheme: 'light', colors: lightColors, radius, spacing, typography };
export const darkTheme: Theme = { scheme: 'dark', colors: darkColors, radius, spacing, typography };
