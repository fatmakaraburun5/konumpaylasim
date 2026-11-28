/**
 * Web demo · Faz 12: kilit ekranı canlı sayacının "yerel tarafı". Gerçekte iOS ActivityKit / Android ongoing bildirim
 * (modules/konum-widgets); burada f12Services'in çağrıları bu depoya yazılır ve kilit ekranı / Dynamic Island benzetimi
 * (Faz12.web.tsx) çizer. Görünüm: iOS (kilit ekranı kartı + Dynamic Island) ya da Android (canlı bildirim).
 */
import type { LiveShareAttributes, LiveShareContent } from '@konum/core';
import { createStore } from 'zustand/vanilla';
import { setLiveActivitySink } from '../../services/live/liveActivityBridge';

export type LiveSimPlatform = 'ios' | 'android';

export interface LiveSimState {
  attributes: LiveShareAttributes | null;
  content: LiveShareContent | null;
  dismissAt: number | null;
  platform: LiveSimPlatform;
  enabled: boolean;
  /** Yerel çağrı sayaçları (güncelleme bütçesi göstergesi). */
  calls: { start: number; update: number; end: number };
  islandExpanded: boolean;
}

export const liveSim = createStore<LiveSimState>()(() => ({
  attributes: null,
  content: null,
  dismissAt: null,
  platform: 'ios',
  enabled: true,
  calls: { start: 0, update: 0, end: 0 },
  islandExpanded: false,
}));

let dismissTimer: ReturnType<typeof setTimeout> | null = null;
const bump = (k: keyof LiveSimState['calls']) => liveSim.setState((s) => ({ calls: { ...s.calls, [k]: s.calls[k] + 1 } }));

setLiveActivitySink({
  enabled: () => liveSim.getState().enabled,
  start: async (attributes, content) => {
    if (dismissTimer) clearTimeout(dismissTimer);
    bump('start');
    liveSim.setState({ attributes, content, dismissAt: null });
    return true;
  },
  update: async (content) => {
    bump('update');
    liveSim.setState({ content, dismissAt: null });
  },
  end: async (content, dismissAt) => {
    bump('end');
    if (dismissTimer) clearTimeout(dismissTimer);
    if (!content || dismissAt === null) {
      liveSim.setState({ attributes: null, content: null, dismissAt: null, islandExpanded: false });
      return;
    }
    liveSim.setState({ content, dismissAt });
    dismissTimer = setTimeout(() => liveSim.setState({ attributes: null, content: null, dismissAt: null, islandExpanded: false }), Math.max(0, dismissAt - Date.now()));
  },
});
