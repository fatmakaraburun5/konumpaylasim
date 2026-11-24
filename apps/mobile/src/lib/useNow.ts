import type { EpochMs } from '@konum/core';
import { useEffect, useState } from 'react';
import { now } from './clock';

/** Sunucu saatine göre "şimdi"; verilen aralıkla yenilenir (tazelik etiketleri, önizleme satırı). */
export function useNow(intervalMs: number): EpochMs {
  const [t, setT] = useState(now);
  useEffect(() => {
    const id = setInterval(() => setT(now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return t;
}
