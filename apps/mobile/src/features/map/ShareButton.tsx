import { Button } from '../../ui';

/**
 * "Konumumu paylaş": her zaman görünür. Paylaşım sürerken de başka birini eklemek için aynı yerde kalır (Erim,
 * 2026-11-26); o zaman haritaya yer bırakmak için bir boy küçük (`compact`).
 */
export function ShareButton({ onPress, compact = false }: { onPress: () => void; compact?: boolean }) {
  return (
    <Button
      title="Konumumu paylaş"
      size={compact ? 'md' : 'lg'}
      onPress={onPress}
      accessibilityHint={compact ? 'Paylaşımlar sürerken başka bir kişi eklemek için kişi ve süre seçme sayfasını açar' : 'Kişi ve süre seçme sayfasını açar'}
      testID="map-share-button"
    />
  );
}
