/**
 * Faz 8: seçiciler için izin sorgusu (grantsStore). İlk anlık görüntü gelmeden "izin yok" çıkarılmaz: o sırada her
 * şey izinli sayılır, sunucu yine de zorlar (gerekirse `needs_grant_receiver_ids` / `not_permitted` döner).
 */
import { useMemo } from 'react';
import { grantsStore, selectCan, useGrantsStore, type GrantsStoreState } from '../../state/grantsStore';
import type { CanFn } from './accessModel';

function canFrom(s: Pick<GrantsStoreState, 'given' | 'received' | 'loaded'>): CanFn {
  return (scope, uid, direction) => !s.loaded || selectCan(s, scope, uid, direction);
}

export function useCanFn(): CanFn {
  const given = useGrantsStore((s) => s.given);
  const received = useGrantsStore((s) => s.received);
  const loaded = useGrantsStore((s) => s.loaded);
  return useMemo(() => canFrom({ given, received, loaded }), [given, received, loaded]);
}

/** Olay işleyicilerinde güncel durum. */
export function canNow(): CanFn {
  return canFrom(grantsStore.getState());
}
