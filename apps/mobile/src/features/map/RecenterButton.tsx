import { IconButton } from '../../ui';

export function RecenterButton({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) {
  return <IconButton icon="crosshair" variant="floating" accessibilityLabel="Konumuma ortala" onPress={onPress} disabled={disabled} size={48} />;
}
