/** Haritadaki kişi işaretçisi: baş harf, tazelik rengi, varsa yön oku. Her iki harita da kullanır. */
import type { Freshness } from '@konum/core';

export interface PersonPinProps {
  initial: string;
  freshness: Freshness;
  /** Gerçek kuzeye göre derece; yoksa ok çizilmez. */
  heading: number | null;
  /** Bağlantı koptu: pin soluk. */
  dim?: boolean;
}

export function PersonPin({ initial, freshness, heading, dim }: PersonPinProps) {
  return (
    <div className={`pin pin-${freshness}${dim ? ' pin-dim' : ''}`} aria-hidden="true">
      {freshness === 'live' && !dim ? <span className="pin-pulse" /> : null}
      {heading !== null ? (
        <span className="pin-heading" style={{ transform: `rotate(${Math.round(heading)}deg)` }}>
          <svg viewBox="0 0 24 12" width="22" height="11">
            <path d="M12 0 L20 11 Q12 7.5 4 11 Z" />
          </svg>
        </span>
      ) : null}
      <span className="pin-face">{initial}</span>
    </div>
  );
}
