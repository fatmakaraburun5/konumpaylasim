/**
 * Faz 8: Firestore `permission_grants` okuyucusu (istemci YAZMAZ; tüm geçişler callable ile).
 *
 * Kural filtre değildir: iki ayrı sorgu (`granter_id == ben` → verdiğim izinler, `grantee_id == ben` → bana verilen
 * izinler) birleştirilir. İkisi de ilk anlık görüntüsünü verene kadar geri çağrı yapılmaz (yarım liste "izin yok"
 * gibi görünmesin).
 *
 * Üçüncü sorgu `permission_declines where granter_id == ben` (yalnızca granter okur): reddettiğim kapsamlar karşı
 * tarafın gördüğü bekleyen istekte süresi dolana kadar durur (ret sızmasın); bu ret anları VERDİĞİM belgelere
 * `declined_at` olarak birleşir ve "İzin istekleri" kartı onları göstermez (core `liveRequestScopes`). Bu sorgu
 * hata verirse ret anları boş sayılır (izin listesi yine gelir).
 */
import { ACCESS_SCOPES, PATHS, parsePermissionGrantDoc, type PermissionGrantDoc, type UserId } from '@konum/core';
import { collection, getFirestore, onSnapshot, query, where, type QuerySnapshot } from '@react-native-firebase/firestore';

function parseSnapshot(snap: QuerySnapshot): PermissionGrantDoc[] {
  const out: PermissionGrantDoc[] = [];
  for (const d of snap.docs) {
    const doc = parsePermissionGrantDoc(d.data());
    if (doc) out.push(doc);
    else if (__DEV__) console.warn('[konum] bozuk permission_grants belgesi atlandı', d.id);
  }
  return out;
}

type Declines = Record<UserId, PermissionGrantDoc['declined_at']>;

function parseDeclines(snap: QuerySnapshot, uid: UserId): Declines {
  const out: Declines = {};
  for (const d of snap.docs) {
    const r = d.data() as { granter_id?: unknown; grantee_id?: unknown; declined_at?: Record<string, unknown> };
    if (r.granter_id !== uid || typeof r.grantee_id !== 'string') continue;
    const at: PermissionGrantDoc['declined_at'] = {};
    for (const s of ACCESS_SCOPES) {
      const v = r.declined_at?.[s];
      if (typeof v === 'number' && Number.isFinite(v)) at[s] = v;
    }
    out[r.grantee_id] = at;
  }
  return out;
}

/** Benimle ilgili tüm izin belgeleri (iki yön); verdiklerime ret anlarım birleşir. */
export function listenGrants(uid: UserId, onDocs: (docs: PermissionGrantDoc[]) => void, onError?: (e: Error) => void): () => void {
  const col = collection(getFirestore(), PATHS.permissionGrants);
  let given: PermissionGrantDoc[] | null = null;
  let received: PermissionGrantDoc[] | null = null;
  let declines: Declines | null = null;
  const emit = () => {
    if (!given || !received || !declines) return;
    const d = declines;
    onDocs([...given.map((g) => (d[g.grantee_id] ? { ...g, declined_at: d[g.grantee_id] ?? {} } : g)), ...received]);
  };
  const u3 = onSnapshot(
    query(collection(getFirestore(), PATHS.permissionDeclines), where('granter_id', '==', uid)),
    (snap) => {
      declines = parseDeclines(snap, uid);
      emit();
    },
    () => {
      declines ??= {};
      emit();
    },
  );
  const u1 = onSnapshot(
    query(col, where('granter_id', '==', uid)),
    (snap) => {
      given = parseSnapshot(snap);
      emit();
    },
    (e) => onError?.(e),
  );
  const u2 = onSnapshot(
    query(col, where('grantee_id', '==', uid)),
    (snap) => {
      received = parseSnapshot(snap);
      emit();
    },
    (e) => onError?.(e),
  );
  return () => {
    u1();
    u2();
    u3();
  };
}
