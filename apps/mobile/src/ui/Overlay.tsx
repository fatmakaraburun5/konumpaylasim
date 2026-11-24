/**
 * Faz 4: tam ekran kaplama (SOS geri sayımı, SOS ekranları). Native: RN `Modal` (her şeyin, alt sayfaların da
 * üstünde). Web kardeşi (`Overlay.web.tsx`) aynı props ile telefon ekranı katmanına portal kullanır.
 */
import type { ReactNode } from 'react';
import { Modal, StyleSheet, View } from 'react-native';

export interface OverlayProps {
  visible: boolean;
  /** Android geri tuşu. */
  onRequestClose?: () => void;
  children: ReactNode;
  testID?: string;
}

export function Overlay({ visible, onRequestClose, children, testID }: OverlayProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onRequestClose ?? (() => undefined)}>
      <View style={StyleSheet.absoluteFill} accessibilityViewIsModal testID={testID}>
        {children}
      </View>
    </Modal>
  );
}
