/**
 * YALNIZCA web: `Overlay.tsx` ile aynı props. RN `Modal` web'de `document.body`'ye açılıp telefon çerçevesinin
 * dışına taştığı için kaplama, demo kabuğunun telefon ekranı katmanına portal ile çizilir (PermissionFlow.web deseni).
 */
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { ScreenPortal } from '../demo/web/screenHost';

export interface OverlayProps {
  visible: boolean;
  onRequestClose?: () => void;
  children: ReactNode;
  testID?: string;
}

export function Overlay({ visible, children, testID }: OverlayProps) {
  if (!visible) return null;
  return (
    <ScreenPortal>
      <View style={[StyleSheet.absoluteFill, { zIndex: 50 }]} accessibilityViewIsModal testID={testID}>
        {children}
      </View>
    </ScreenPortal>
  );
}
