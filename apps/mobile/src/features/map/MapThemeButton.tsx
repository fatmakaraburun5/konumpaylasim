/**
 * Harita üstündeki görünüm düğmesi. Faz 7: tek dokunuşla Sistem → Açık → Koyu döngüsüydü.
 * Faz 11: dokunuş "Tema ve Harita" ekranını açar (önizleme kartları + saat kuralı); UZUN BASIŞ eski hızlı
 * döngüyü korur (Sistem → Açık → Koyu). Tercih anında uygulanır: harita stili ve uygulama teması aynı karede değişir.
 */
import { nextThemePref, THEME_NAME, THEME_PREF_TEXT, type ThemePref } from '@konum/core';
import { useRouter } from 'expo-router';
import { IconButton, setThemePref, useThemeId, useThemePref } from '../../ui';

export function MapThemeButton() {
  const router = useRouter();
  const pref = useThemePref();
  const active = useThemeId();
  const legacy: ThemePref = pref === 'light' || pref === 'dark' ? pref : 'system';
  const next = nextThemePref(legacy);
  return (
    <IconButton
      icon="palette"
      variant="floating"
      size={48}
      accessibilityLabel={`Tema: ${THEME_NAME[active]}. Tema ve harita ayarları için dokun; ${THEME_PREF_TEXT[next]} yapmak için uzun bas.`}
      onPress={() => router.push('/appearance')}
      onLongPress={() => setThemePref(next)}
      testID="map-theme-button"
    />
  );
}
