/**
 * Faz 9: arayüzün gördüğü Güvenli Dönüş hâli. Alarm (`status: 'alarm'`) yalnızca bağlı SOS etkin kaldıkça gösterilir:
 * "Güvendeyim" SOS'u kapatınca (bu cihazdan ya da SOS ekranından) bant ve ekran alarmı bırakır.
 */
import type { SafeReturnPhase } from '@konum/core';
import { useSafeReturnStore } from '../../state/safeReturnStore';
import { useOutgoingSosActive } from '../../state/sosStore';

export function effectiveSafeReturnPhase(phase: SafeReturnPhase | 'idle', sosActive: boolean): SafeReturnPhase | 'idle' {
  return phase === 'alarm' && !sosActive ? 'ended' : phase;
}

export function useSafeReturnPhase(): SafeReturnPhase | 'idle' {
  const phase = useSafeReturnStore((s) => s.phase);
  const sosActive = useOutgoingSosActive();
  return effectiveSafeReturnPhase(phase, sosActive);
}
