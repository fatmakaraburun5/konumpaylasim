/**
 * Faz 7: harita üstündeki görünüm düğmesi — tek dokunuşla Sistem → Açık → Koyu → Sistem (core `nextThemePref`).
 * Tercih anında uygulanır: harita stili (customMapStyle JSON) ve uygulama teması aynı karede değişir. Aynı tercih
 * İzin & Gizlilik Merkezi'ndeki "Görünüm" bölümünden de seçilir.
 */
import { nextThemePref, THEME_PREF_TEXT, type ThemePref } from '@konum/core';
import { IconButton, setThemePref, useThemePref, type IconName } from '../../ui';

const ICON: Record<ThemePref, IconName> = { system: 'themeAuto', light: 'sun', dark: 'moon' };

export function MapThemeButton() {
  const pref = useThemePref();
  const next = nextThemePref(pref);
  return (
    <IconButton
      icon={ICON[pref]}
      variant="floating"
      size={48}
      accessibilityLabel={`Harita görünümü: ${THEME_PREF_TEXT[pref]}. ${THEME_PREF_TEXT[next]} yapmak için dokun.`}
      onPress={() => setThemePref(next)}
    />
  );
}
