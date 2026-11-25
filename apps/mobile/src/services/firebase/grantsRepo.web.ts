/** Web demo: `permission_grants` okuyucusu → bellek içi demo sunucusu (iki yön, core ayrıştırıcıdan geçer). */
import { parsePermissionGrantDoc, type PermissionGrantDoc, type UserId } from '@konum/core';
import { demoServer } from '../../demo/server';

function parseAll(list: readonly unknown[]): PermissionGrantDoc[] {
  const out: PermissionGrantDoc[] = [];
  for (const d of list) {
    const doc = parsePermissionGrantDoc(d);
    if (doc) out.push(doc);
  }
  return out;
}

export function listenGrants(uid: UserId, onDocs: (docs: PermissionGrantDoc[]) => void, _onError?: (e: Error) => void): () => void {
  return demoServer().subscribe(
    () => demoServer().grantsOf(uid),
    (list) => onDocs(parseAll(list)),
  );
}
