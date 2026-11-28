/**
 * Faz 12: "Sık paylaştıkların" listesi (core `rankFrequentContacts`) + kısayolun başlatma kararı (`planShortcutStart`).
 */
import {
  planShortcutStart,
  rankFrequentContacts,
  type EpochMs,
  type FrequentContact,
  type ShortcutPlan,
  type UserId,
} from '@konum/core';
import { useMemo } from 'react';
import { breakStore } from '../../state/breakStore';
import { useFavoriteIds } from '../../state/favoritesStore';
import { useFriendsById, useFriendsStore } from '../../state/friendsStore';
import { grantsStore, isLocationRevoked, selectCan } from '../../state/grantsStore';
import { invisibleStore, selectIsInvisible } from '../../state/invisibleStore';
import { isConsentHeld } from '../../state/publishHold';
import { useShareHistory } from '../../state/shareHistoryStore';
import { sharingStore } from '../../state/sharingStore';
import { activeShareTo } from '../quickShare/quickShareModel';
import { isOnBreak } from '@konum/core';

export function useFrequentContacts(now: EpochMs): FrequentContact[] {
  const history = useShareHistory((s) => s.entries);
  const favorites = useFavoriteIds();
  const byId = useFriendsById();
  const loaded = useFriendsStore((s) => s.loaded);
  // Dakikada bir yeniden sıralamak yeter (puan günlerle değişir).
  const minute = Math.floor(now / 60_000);
  return useMemo(
    () =>
      rankFrequentContacts({
        history,
        favorites,
        friendIds: loaded ? new Set(Object.keys(byId)) : null,
        now: minute * 60_000,
        nameOf: (u) => byId[u]?.displayName ?? u,
      }).filter((c) => !loaded || byId[c.uid]),
    [history, favorites, byId, loaded, minute],
  );
}

export interface ShortcutContext {
  plan: ShortcutPlan;
  grantFromThem: boolean;
  activeUntil: EpochMs | null | undefined;
}

/** Dokunma anındaki karar (depolardan senkron okunur). */
export function shortcutContextFor(uid: UserId, minutes: number, now: EpochMs): ShortcutContext {
  const g = grantsStore.getState();
  const grantToThem = selectCan(g, 'location_view', uid, 'given') && !isLocationRevoked(g, uid);
  const grantFromThem = selectCan(g, 'location_view', uid, 'received');
  const active = activeShareTo(sharingStore.getState().state, uid, now);
  const activeUntil = active ? active.expires_at : undefined;
  const plan = planShortcutStart({
    invisible: selectIsInvisible(invisibleStore.getState()),
    consentRequired: isConsentHeld(),
    grantToThem,
    grantFromThem,
    activeUntil,
    onBreak: isOnBreak(breakStore.getState().brk, now),
    now,
    minutes,
  });
  return { plan, grantFromThem, activeUntil };
}
