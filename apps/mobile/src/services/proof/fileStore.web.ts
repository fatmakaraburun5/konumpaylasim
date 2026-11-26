/**
 * Web demo: anlık fotoğraf önbelleği bellekte (`data:` adresleri). Sayfa yenilenince boşalır; süre dolunca / çıkışta
 * `cache.ts` siler. Native `fileStore.ts` önbellek dizinini kullanır.
 */
import { memoryProofBlobStore, type ProofBlobStore } from './cache';

let store: ProofBlobStore | null = null;

export function fileProofBlobStore(): ProofBlobStore {
  return (store ??= memoryProofBlobStore());
}
