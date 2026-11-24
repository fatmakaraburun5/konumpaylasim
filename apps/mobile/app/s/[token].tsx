/**
 * QR / paylaşım bağlantısı: `https://<LINK_DOMAIN>/s/<token>` (Universal Links / App Links) ve
 * `konum://s/<token>`. Kök düzeyde, (main)/(auth) kimlik kapılarının DIŞINDA: oturum açmamış biri de
 * paylaşılan konumu salt okunur görür. Token yalnızca cihazda özetlenir (bkz. LinkViewerScreen).
 */
import { useLocalSearchParams } from 'expo-router';
import { LinkViewerScreen } from '../../src/features/link/LinkViewerScreen';

export default function SharedLinkRoute() {
  const { token } = useLocalSearchParams<{ token?: string | string[] }>();
  return <LinkViewerScreen rawToken={token} />;
}
