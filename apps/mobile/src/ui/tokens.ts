/**
 * Tasarım belirteçleri (design tokens). Değerler tasarım dosyasıyla BİREBİR aynıdır; değiştirmeyin.
 * Font: tasarımda Inter, React Native'de sistem fontu (fontFamily verilmez).
 */
import type { ThemeId } from '@konum/core';
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
  // --- Faz 11 (tema paketi) ---
  /** Kitapçık (ShareDeck) arka katmanları: 1 = öndekinin hemen arkası, 2 = en arka. */
  deckLayer1: string;
  deckLayer2: string;
  /** Avatar çerçevesinin DIŞ kontrast halkası (1,5 px) ve gölgesi; gerekmeyen temada 'transparent'. */
  ringHalo: string;
  ringShadow: string;
  /** Çerçeve ile fotoğraf arasındaki boşluk (Pudra Pembesi'nde pembe yüzeye karışmasın diye beyaz). */
  ringGap: string;
  mapHighway: string;
  mapRoadStroke: string;
  mapRoadMinor: string;
  mapLabel: string;
  mapTransit: string;
  mapShore: string;
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
  deckLayer1: '#FFFFFF',
  deckLayer2: '#FFFFFF',
  ringHalo: 'transparent',
  ringShadow: 'transparent',
  ringGap: '#FFFFFF',
  mapHighway: '#EEF2F6',
  mapRoadStroke: '#E2E8F0',
  mapRoadMinor: '#FFFFFF',
  mapLabel: '#475569',
  mapTransit: '#E2E8F0',
  mapShore: '#B9D4EE',
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
  deckLayer1: '#111A2E',
  deckLayer2: '#111A2E',
  ringHalo: 'transparent',
  ringShadow: 'transparent',
  ringGap: '#111A2E',
  mapHighway: '#18233B',
  mapRoadStroke: '#22304D',
  mapRoadMinor: '#1A263C',
  mapLabel: '#A3B1C6',
  mapTransit: '#22304D',
  mapShore: '#173659',
};

/**
 * Faz 11 — Nude (Soft Nude & kahve alt tonlu). Zemin krem/bej, kart ve kitapçık sütlü kahve/taş, ana aksiyon
 * tarçın (basılı: espresso), metin koyu kahve. Kontrast (WCAG): metin/yüzey 12,6:1, ikincil 5,9:1, düğme 5,3:1.
 * Harita: yollar yumuşak bej/kum, parklar adaçayı, su toprak-gri. Pembe/mavi çerçeve bej zeminde yalnız ~2,8:1
 * olduğu için avatarın dışında kırık beyaz halka + kahve gölge vardır (çerçeve zeminde kaybolmaz).
 */
export const nudeColors: ColorTokens = {
  bg: '#F7F1E8',
  surface: '#EFE5D8',
  surfaceAlt: '#E4D6C5',
  text: '#2B211B',
  textSecondary: '#64533F',
  border: '#D8C7B2',
  primary: '#99582F',
  primaryPressed: '#6B3B1E',
  onPrimary: '#FFF9F3',
  primarySoft: '#F0DCCB',
  live: '#4D7A38',
  liveSoft: '#E3ECD8',
  warning: '#9C5A08',
  warningSoft: '#F7E6C8',
  danger: '#A3382A',
  dangerSoft: '#F6DCD5',
  stale: '#857463',
  mapWater: '#C8D5D0',
  mapPark: '#D3DDBF',
  mapRoad: '#FAF5EC',
  mapLand: '#EEE5D7',
  deckLayer1: '#E3D4C1',
  deckLayer2: '#D6C4AE',
  ringHalo: '#FFFDF9',
  ringShadow: 'rgba(43, 33, 27, 0.30)',
  ringGap: '#FFFDF9',
  mapHighway: '#E8D5B6',
  mapRoadStroke: '#DCCBB4',
  mapRoadMinor: '#F6EFE3',
  mapLabel: '#6E5D4B',
  mapTransit: '#CDB9A0',
  mapShore: '#AFC1BA',
};

/**
 * Faz 11 — Pudra Pembesi (Blush & Pastel Rose). Neon pembe yok: kırık beyaz/pudra zemin, toz pembe kartlar,
 * mürdüm aksiyon (basılı: koyu vişne), koyu gri metin. Kontrast: metin 13,1:1, ikincil 5,8:1, düğme 9,0:1. Kadın çerçevesi (#EC4899) pembe yüzeye karışmasın diye
 * avatarda BEYAZ boşluk + beyaz dış halka + mürdüm tonlu yumuşak gölge (`ringGap` / `ringHalo` / `ringShadow`).
 * Harita: açık pudra/krem zemin, soğuk gri su, yollar zarif gri/leylak.
 */
export const blushColors: ColorTokens = {
  bg: '#FBF7F6',
  surface: '#F7EAEB',
  surfaceAlt: '#F0DDE0',
  text: '#2A2326',
  textSecondary: '#655760',
  border: '#E8D2D7',
  primary: '#7A2E4D',
  primaryPressed: '#561C34',
  onPrimary: '#FFFFFF',
  primarySoft: '#F2DDE6',
  live: '#2E7A59',
  liveSoft: '#DDEFE6',
  warning: '#9A5A0B',
  warningSoft: '#F8E7CC',
  danger: '#A1233A',
  dangerSoft: '#F7D9DF',
  stale: '#887A81',
  mapWater: '#DAE2EA',
  mapPark: '#E4EAE1',
  mapRoad: '#FFFFFF',
  mapLand: '#F7F1F0',
  deckLayer1: '#ECD5DA',
  deckLayer2: '#E1C5CC',
  ringHalo: '#FFFFFF',
  ringShadow: 'rgba(86, 28, 52, 0.38)',
  ringGap: '#FFFFFF',
  mapHighway: '#EAE2EE',
  mapRoadStroke: '#DCD5E0',
  mapRoadMinor: '#FDFBFC',
  mapLabel: '#7A707F',
  mapTransit: '#D8CFDC',
  mapShore: '#C3CEDA',
};

/**
 * Faz 11 — Siyah / Gri (Charcoal & Slate). Saf siyah yok: zemin #121417, ön kart #1C1F24, kitapçık arka
 * katmanları kademeli AÇILIR (#262A31 → #30353D) + 1 px açık kenar → üst üste binen kartlar net ayrışır.
 * Metin kırık beyaz (#ECEDEF, 14,1:1), ikincil açık gri (7,5:1). Aksiyon: arduvaz mavi-gri, üstünde koyu metin.
 * Harita: otoyol > cadde > sokak kademeli gri; su koyu mavi-gri; gece ve gündüz okunur.
 */
export const charcoalColors: ColorTokens = {
  bg: '#121417',
  surface: '#1C1F24',
  surfaceAlt: '#262A31',
  text: '#ECEDEF',
  textSecondary: '#A9AFB8',
  border: '#33383F',
  primary: '#8CA0BD',
  primaryPressed: '#72869F',
  onPrimary: '#0E1013',
  primarySoft: '#243040',
  live: '#4ADE80',
  liveSoft: '#14281C',
  warning: '#F2B24C',
  warningSoft: '#33280F',
  danger: '#F08A8A',
  dangerSoft: '#3A1A1C',
  stale: '#8A9099',
  mapWater: '#1B2734',
  mapPark: '#1A221E',
  mapRoad: '#2B2F36',
  mapLand: '#16181C',
  deckLayer1: '#262A31',
  deckLayer2: '#30353D',
  ringHalo: 'rgba(10, 11, 13, 0.85)',
  ringShadow: 'rgba(0, 0, 0, 0.55)',
  ringGap: '#1C1F24',
  mapHighway: '#3D434C',
  mapRoadStroke: '#202328',
  mapRoadMinor: '#23272D',
  mapLabel: '#8F96A0',
  mapTransit: '#2E3238',
  mapShore: '#24384C',
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
  /** Faz 11: etkin tema paketi (light / dark / nude / blush / charcoal). */
  id: ThemeId;
  /** Tabanı: açık mı koyu mu (durum çubuğu, sistem bileşenleri). */
  scheme: 'light' | 'dark';
  colors: ColorTokens;
  radius: typeof radius;
  spacing: typeof spacing;
  typography: typeof typography;
}

export const lightTheme: Theme = { id: 'light', scheme: 'light', colors: lightColors, radius, spacing, typography };
export const darkTheme: Theme = { id: 'dark', scheme: 'dark', colors: darkColors, radius, spacing, typography };
export const nudeTheme: Theme = { id: 'nude', scheme: 'light', colors: nudeColors, radius, spacing, typography };
export const blushTheme: Theme = { id: 'blush', scheme: 'light', colors: blushColors, radius, spacing, typography };
export const charcoalTheme: Theme = { id: 'charcoal', scheme: 'dark', colors: charcoalColors, radius, spacing, typography };

/** Faz 11: tüm temalar (sabit nesneler: referans eşitliği → tema değişmedikçe yeniden çizim yok). */
export const THEMES: Readonly<Record<ThemeId, Theme>> = Object.freeze({
  light: lightTheme,
  dark: darkTheme,
  nude: nudeTheme,
  blush: blushTheme,
  charcoal: charcoalTheme,
});
