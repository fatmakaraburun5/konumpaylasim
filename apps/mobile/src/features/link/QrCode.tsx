/**
 * QR kodu (react-native-qrcode-svg, react-native-svg 15 üzerinde). Koyu temada da okutulabilir olsun diye
 * her zaman açık zemin üzerinde koyu modüller çizilir (tersine çevrilmiş QR'ı bazı okuyucular tanımaz).
 * Hata düzeltme "M": 43 karakterlik token + alan adı için yeterli, modüller büyük kalır.
 */
import QRCode from 'react-native-qrcode-svg';
import { View } from 'react-native';
import { lightColors } from '../../ui';

export interface QrCodeProps {
  value: string;
  size?: number;
}

export function QrCode({ value, size = 220 }: QrCodeProps) {
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="Konum bağlantısının QR kodu"
      style={{ padding: 12, backgroundColor: '#FFFFFF', borderRadius: 16 }}
    >
      <QRCode value={value} size={size} color={lightColors.text} backgroundColor="#FFFFFF" ecl="M" quietZone={4} />
    </View>
  );
}
