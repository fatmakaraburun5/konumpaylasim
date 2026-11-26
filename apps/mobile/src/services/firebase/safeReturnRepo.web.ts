/** Web demo: `safe_returns` okuyucusu → bellek içi demo sunucusu (native `safeReturnRepo.ts` ile aynı API). */
import { parseSafeReturn, type SafeReturnDoc, type UserId } from '@konum/core';
import { demoServer } from '../../demo/server';
import { authStore } from '../../state/authStore';

export function listenSafeReturns(uid: UserId, onDocs: (docs: SafeReturnDoc[]) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().safeReturnsOf(uid),
    (list) => {
      const out: SafeReturnDoc[] = [];
      for (const d of list) {
        const doc = parseSafeReturn(d);
        if (doc) out.push(doc);
      }
      onDocs(out);
    },
  );
}

/** Tek kayıt (native: sunucudan `getDocFromServer`); kural gibi yalnızca sahibinin kaydı. */
export async function fetchSafeReturn(id: string): Promise<SafeReturnDoc | null> {
  const uid = authStore.getState().uid;
  const d = uid ? demoServer().safeReturnsOf(uid).find((x) => x.safe_return_id === id) : undefined;
  return d ? parseSafeReturn(d) : null;
}
