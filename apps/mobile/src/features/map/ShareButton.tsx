import { Button } from '../../ui';

/** Etkin paylaşım yokken ana eylem. */
export function ShareButton({ onPress }: { onPress: () => void }) {
  return <Button title="Konumumu paylaş" size="lg" onPress={onPress} accessibilityHint="Kişi ve süre seçme sayfasını açar" />;
}
