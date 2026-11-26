/**
 * Faz 9: anlık fotoğraf arayüzünün saf yardımcıları (test edilir; core `proof.ts` metinleri).
 */
import { formatProofLeft, PROOF_TEXT, proofRemainingRatio, type EpochMs } from '@konum/core';
import type { FriendProofStatus } from '../../state/proofStore';

export type ProofViewState = 'loading' | 'ready' | 'expired' | 'unavailable' | 'error';

/** Görüntüleyicinin hâli: süre dolduysa (sunucu saati) görsel her durumda gizlenir. */
export function proofViewState(i: { expiresAt: EpochMs; now: EpochMs; status: FriendProofStatus | 'mine'; uri: string | null }): ProofViewState {
  if (i.expiresAt <= i.now || i.status === 'expired') return 'expired';
  if (i.status === 'not_found') return 'unavailable';
  if (i.status === 'error') return 'error';
  if (i.status === 'loading') return 'loading';
  return i.uri ? 'ready' : i.status === 'mine' ? 'unavailable' : 'loading';
}

/** Kalan süre satırı + halka oranı ("52 dk kaldı" / "Süresi doldu"). */
export function proofLeft(expiresAt: EpochMs, now: EpochMs): { text: string; ratio: number; expired: boolean } {
  return { text: formatProofLeft(expiresAt, now), ratio: proofRemainingRatio({ expires_at: expiresAt }, now), expired: expiresAt <= now };
}

/** Durum metni (görüntüleyici gövdesi). */
export const PROOF_VIEW_TEXT: Record<Exclude<ProofViewState, 'ready'>, string> = {
  loading: 'Fotoğraf yükleniyor…',
  expired: PROOF_TEXT.expired,
  unavailable: 'Bu fotoğraf artık görüntülenemiyor.',
  error: 'Fotoğraf yüklenemedi. Bağlantını kontrol et.',
};
