/**
 * Faz 3: çevrimdışı kuyruğun SQLite deposu (expo-sqlite, yalnızca native).
 *
 * Tablolar:
 *   outbox_points(id TEXT PK, ts INTEGER, body TEXT)  — core `OutboxPoint` JSON; `ts` = timestamp (sıralama)
 *   outbox_meta(k TEXT PK, v TEXT)                    — 'state' (seq/thinned/lost), 'meta' (OutboxMeta)
 *
 * Arka plan görevinden (başsız) de kullanılır: veritabanı ilk kullanımda açılır, bağlantı süreç boyunca
 * paylaşılır. Yazmalar tek işlemde (transaction) yapılır: süreç ortada ölse de kuyruk tutarlı kalır.
 * [Varsayım] WAL kipi expo-sqlite varsayılanı; cihazda doğrulanmalı.
 *
 * Bu dosya YALNIZCA backgroundTask.ts'ten (native) içe aktarılır: web demo paketine expo-sqlite girmez.
 */
import { emptyOutbox, type OutboxPoint } from '@konum/core';
import { diffPoints, emptyMeta, type OutboxMeta, type OutboxStore, type PersistedOutbox } from './outboxStore';

/** Testte sahte uygulanabilen asgari expo-sqlite yüzeyi. */
export interface SqliteDb {
  execAsync: (sql: string) => Promise<void>;
  runAsync: (sql: string, params: (string | number | null)[]) => Promise<unknown>;
  getAllAsync: <T>(sql: string, params: (string | number | null)[]) => Promise<T[]>;
  withTransactionAsync: (fn: () => Promise<void>) => Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox_points (id TEXT PRIMARY KEY NOT NULL, ts INTEGER NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS outbox_points_ts ON outbox_points (ts);
CREATE TABLE IF NOT EXISTS outbox_meta (k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL);
`;

const CHUNK = 200;

export function createSqliteOutboxStore(open: () => Promise<SqliteDb>): OutboxStore {
  let dbp: Promise<SqliteDb> | null = null;
  const db = () =>
    (dbp ??= open()
      .then(async (d) => {
        await d.execAsync(SCHEMA);
        return d;
      })
      .catch((e: unknown) => {
        dbp = null; // bir sonraki çağrıda yeniden dene
        throw e;
      }));

  const load = async (): Promise<PersistedOutbox> => {
    const d = await db();
    const rows = await d.getAllAsync<{ body: string }>('SELECT body FROM outbox_points ORDER BY ts ASC, id ASC', []);
    const metaRows = await d.getAllAsync<{ k: string; v: string }>('SELECT k, v FROM outbox_meta', []);
    const points: OutboxPoint[] = [];
    for (const r of rows) {
      try {
        points.push(JSON.parse(r.body) as OutboxPoint);
      } catch {
        // bozuk satır: atla (bir sonraki kayıtta silinir)
      }
    }
    const kv = new Map(metaRows.map((r) => [r.k, r.v] as const));
    const parse = <T,>(k: string, fallback: T): T => {
      try {
        const v = kv.get(k);
        return v ? { ...fallback, ...(JSON.parse(v) as T) } : fallback;
      } catch {
        return fallback;
      }
    };
    const st = parse('state', { seq: 0, thinned: 0, lost: 0 });
    return { state: { ...emptyOutbox(), ...st, points }, meta: parse<OutboxMeta>('meta', emptyMeta()) };
  };

  const save = async (prev: PersistedOutbox, next: PersistedOutbox): Promise<void> => {
    const d = await db();
    const { removed, upserted } = diffPoints(prev.state.points, next.state.points);
    await d.withTransactionAsync(async () => {
      for (let i = 0; i < removed.length; i += CHUNK) {
        const ids = removed.slice(i, i + CHUNK);
        await d.runAsync(`DELETE FROM outbox_points WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      }
      for (const p of upserted) {
        await d.runAsync('INSERT OR REPLACE INTO outbox_points (id, ts, body) VALUES (?, ?, ?)', [p.id, p.timestamp, JSON.stringify(p)]);
      }
      const { points: _p, ...rest } = next.state;
      await d.runAsync('INSERT OR REPLACE INTO outbox_meta (k, v) VALUES (?, ?)', ['state', JSON.stringify(rest)]);
      await d.runAsync('INSERT OR REPLACE INTO outbox_meta (k, v) VALUES (?, ?)', ['meta', JSON.stringify(next.meta)]);
    });
  };

  return {
    load,
    save,
    count: async () => {
      const d = await db();
      const rows = await d.getAllAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outbox_points', []);
      return Number(rows[0]?.n ?? 0);
    },
    clear: async () => {
      const d = await db();
      await d.withTransactionAsync(async () => {
        await d.runAsync('DELETE FROM outbox_points', []);
        await d.runAsync('DELETE FROM outbox_meta', []);
      });
    },
  };
}

/** Gerçek expo-sqlite bağlantısı (dinamik içe aktarma yok: dosya yalnızca native girişten yüklenir). */
export function expoSqliteOutboxStore(): OutboxStore {
  return createSqliteOutboxStore(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SQLite = require('expo-sqlite') as typeof import('expo-sqlite');
    const d = await SQLite.openDatabaseAsync('konum-outbox.db');
    return d as unknown as SqliteDb;
  });
}

