import { useEffect, useState } from 'react';
import { now as serverNow } from '../../lib/clock';

/** Sunucu saatine göre "şimdi"; `everyMs`'de bir yenilenir (geri sayım, göreli zaman). */
export function useNow(everyMs = 15_000): number {
  const [t, setT] = useState(() => serverNow());
  useEffect(() => {
    const id = setInterval(() => setT(serverNow()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return t;
}
