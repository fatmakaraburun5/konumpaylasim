/**
 * Mağaza rozetleri. Resmî rozet görselleri dış istek gerektirdiği için kullanılmaz; aynı bilgi
 * yerel düğmelerle verilir. `VITE_APP_STORE_URL` / `VITE_PLAY_STORE_URL` yoksa rozet yer tutucudur
 * ("Yakında"). [Varsayım] mağaza kayıtları henüz yok.
 */
import type { ReactNode } from 'react';
import { AppleIcon, PlayIcon } from './icons';

interface Props {
  appStoreUrl: string | null;
  playStoreUrl: string | null;
}

function Badge({ href, icon, small, big }: { href: string | null; icon: ReactNode; small: string; big: string }) {
  const content = (
    <>
      {icon}
      <span className="badge-text">
        <span className="badge-small">{href ? small : 'Yakında'}</span>
        <span className="badge-big">{big}</span>
      </span>
    </>
  );
  if (!href) {
    return (
      <span className="badge badge-placeholder" aria-disabled="true" title="Mağaza bağlantısı yakında">
        {content}
      </span>
    );
  }
  return (
    <a className="badge" href={href} target="_blank" rel="noopener noreferrer">
      {content}
    </a>
  );
}

export function StoreBadges({ appStoreUrl, playStoreUrl }: Props) {
  return (
    <div className="badges" aria-label="Konum uygulamasını edin">
      <Badge href={appStoreUrl} icon={<AppleIcon />} small="İndirin" big="App Store" />
      <Badge href={playStoreUrl} icon={<PlayIcon />} small="Edinin" big="Google Play" />
    </div>
  );
}
