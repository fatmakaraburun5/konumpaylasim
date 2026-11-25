/**
 * Faz 8: görünmez mod akışları (Profil kartı, harita şeridi, paylaş düğmesi aynı akışı kullanır).
 *
 *  - `confirmInvisibleOn`: onay (Alert; web demoda AlertHost) → `invisibleStore.setInvisible()`.
 *  - `openRestoreFlow`: görünür olma sayfasını açar (InvisibleRestoreSheet, (main) yerleşiminde tek örnek).
 *  - `explainInvisibleShare`: görünmezken paylaş düğmesi → "Görünmez moddasın" + "Görünür ol".
 */
import { selectSessions } from '@konum/core';
import { Alert } from 'react-native';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { invisibleStore, INVISIBLE_TEXT } from '../../state/invisibleStore';
import { sharingStore } from '../../state/sharingStore';
import { selectOutgoingSosActive, sosStore } from '../../state/sosStore';
import { invisibleConfirmBody } from './invisibleModel';

interface RestoreFlowState {
  open: boolean;
}

export const restoreFlowStore = createStore<RestoreFlowState>()(() => ({ open: false }));

export function useRestoreFlowOpen(): boolean {
  return useStore(restoreFlowStore, (s) => s.open);
}

export function openRestoreFlow(): void {
  restoreFlowStore.setState({ open: true });
}

export function closeRestoreFlow(): void {
  restoreFlowStore.setState({ open: false });
}

export function confirmInvisibleOn(onError?: (message: string) => void): void {
  const body = invisibleConfirmBody(selectSessions(sharingStore.getState().state), selectOutgoingSosActive(sosStore.getState()));
  Alert.alert(INVISIBLE_TEXT.confirmTitle, body, [
    { text: INVISIBLE_TEXT.cancel, style: 'cancel' },
    {
      text: INVISIBLE_TEXT.confirmAction,
      style: 'destructive',
      onPress: () => {
        void invisibleStore
          .getState()
          .setInvisible()
          .then((r) => {
            if (!r.ok) onError?.(r.message);
          });
      },
    },
  ]);
}

export function explainInvisibleShare(): void {
  Alert.alert(INVISIBLE_TEXT.shareBlockedTitle, INVISIBLE_TEXT.shareBlockedBody, [
    { text: INVISIBLE_TEXT.cancel, style: 'cancel' },
    { text: INVISIBLE_TEXT.bannerAction, onPress: openRestoreFlow },
  ]);
}
