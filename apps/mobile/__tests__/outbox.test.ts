/**
 * Faz 3: çevrimdışı kuyruk — SQLite deposu (sahte veritabanı) üzerinde kalıcılık, boşaltma (canlı `q: 1` +
 * iz partileri), onay, bitmiş hedeflerin atılması, geri çekilme, "Durdur" / çıkış temizliği, hesap değişimi.
 */
import { HOUR, MINUTE, type OutboxSample, type OutboxTarget } from '@konum/core';
import { createOutboxRepo, type FlushDeps } from '../src/services/outbox/outboxRepo';
import { asyncStorageOutboxStore, type PendingCall } from '../src/services/outbox/outboxStore';
import { createSqliteOutboxStore, type SqliteDb } from '../src/services/outbox/sqliteOutboxStore';

const NOW = Date.UTC(2026, 10, 24, 8, 0, 0);

/** Kuyruğun kullandığı SQL alt kümesini anlayan bellek içi veritabanı ("uygulama yeniden açıldı" = aynı nesne). */
function fakeDb() {
  const points = new Map<string, { ts: number; body: string }>();
  const meta = new Map<string, string>();
  let failNextTx = false;
  const db: SqliteDb & { points: typeof points; meta: typeof meta; failNextTx: () => void } = {
    points,
    meta,
    failNextTx: () => {
      failNextTx = true;
    },
    execAsync: async () => undefined,
    runAsync: async (sql, params) => {
      if (sql.startsWith('DELETE FROM outbox_points WHERE id IN')) for (const id of params) points.delete(String(id));
      else if (sql === 'DELETE FROM outbox_points') points.clear();
      else if (sql === 'DELETE FROM outbox_meta') meta.clear();
      else if (sql.startsWith('INSERT OR REPLACE INTO outbox_points')) points.set(String(params[0]), { ts: Number(params[1]), body: String(params[2]) });
      else if (sql.startsWith('INSERT OR REPLACE INTO outbox_meta')) meta.set(String(params[0]), String(params[1]));
      else throw new Error(`beklenmeyen SQL: ${sql}`);
      return undefined;
    },
    getAllAsync: async <T,>(sql: string) => {
      if (sql.startsWith('SELECT body FROM outbox_points'))
        return [...points.entries()].sort((a, b) => a[1].ts - b[1].ts || a[0].localeCompare(b[0])).map(([, v]) => ({ body: v.body })) as T[];
      if (sql.startsWith('SELECT k, v FROM outbox_meta')) return [...meta.entries()].map(([k, v]) => ({ k, v })) as T[];
      if (sql.startsWith('SELECT COUNT(*)')) return [{ n: points.size }] as T[];
      throw new Error(`beklenmeyen SQL: ${sql}`);
    },
    withTransactionAsync: async (fn) => {
      // Basit geri alma: işlem başarısızsa önceki hal geri yüklenir.
      const p0 = new Map(points);
      const m0 = new Map(meta);
      try {
        if (failNextTx) {
          failNextTx = false;
          throw new Error('disk dolu');
        }
        await fn();
      } catch (e) {
        points.clear();
        p0.forEach((v, k) => points.set(k, v));
        meta.clear();
        m0.forEach((v, k) => meta.set(k, v));
        throw e;
      }
    },
  };
  return db;
}

const share = (r: string, over: Partial<Extract<OutboxTarget, { kind: 'share' }>> = {}): OutboxTarget => ({
  kind: 'share',
  share_id: `me_${r}`,
  receiver_id: r,
  share_mode: 'indefinite',
  expires_at: null,
  started_at: NOW - HOUR,
  ...over,
});
const link = (h: string): OutboxTarget => ({ kind: 'link', token_hash: h, share_mode: 'timed', expires_at: NOW + HOUR, sender_name: 'Ece', started_at: NOW - HOUR });
const sample = (at: number, d = 0): OutboxSample => ({
  lat: 41 + d,
  lng: 29,
  accuracy: 10,
  speed_mps: 10,
  heading: null,
  activity_state: 'automotive',
  battery_pct: 42,
  is_charging: false,
  timestamp: at,
  recorded_at: at,
  hb: 60_000,
});

function setup() {
  const db = fakeDb();
  const store = createSqliteOutboxStore(async () => db);
  const repo = createOutboxRepo(() => store);
  const write = jest.fn<Promise<void>, [Record<string, unknown>]>().mockResolvedValue(undefined);
  const flushDeps = (over: Partial<FlushDeps> = {}): FlushDeps => ({
    uid: 'me',
    now: NOW,
    targets: [share('a'), share('b')],
    isAllowed: () => true,
    write,
    rand: () => 0.5,
    ...over,
  });
  return { db, store, repo, write, flushDeps, reopen: () => createOutboxRepo(() => createSqliteOutboxStore(async () => db)) };
}

describe('çevrimdışı kuyruk (SQLite)', () => {
  it('tünel: noktalar kalıcıdır, uygulama yeniden açılınca aynı sırayla okunur', async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) await t.repo.enqueue('me', sample(NOW - (5 - i) * MINUTE, i * 0.001), [share('a'), share('b')], NOW);
    expect(t.db.points.size).toBe(5);
    const again = t.reopen();
    const loaded = await again.load();
    expect(loaded.state.points.map((p) => p.timestamp)).toEqual([5, 4, 3, 2, 1].map((m) => NOW - m * MINUTE));
    expect(loaded.state.points[0]!.target_ids).toEqual(['s:me_a', 's:me_b']);
    expect(loaded.meta.uid).toBe('me');
    expect(await again.pendingCount()).toBe(5);
  });

  it('boşaltma: hedef başına en yeni nokta canlıya q:1 + recorded_at, tüm noktalar ize; başarıda kuyruk boşalır', async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) await t.repo.enqueue('me', sample(NOW - (3 - i) * MINUTE, i * 0.001), [share('a')], NOW);
    const r = await t.repo.flush(t.flushDeps({ targets: [share('a')] }));
    expect(r).toMatchObject({ status: 'ok', synced: 3, pending: 0, liveTs: NOW - MINUTE });
    const [live, trail] = t.write.mock.calls.map((c) => c[0]);
    expect(live!['live_locations/a/me_a']).toMatchObject({ q: 1, recorded_at: NOW - MINUTE, timestamp: NOW - MINUTE, hb: 60_000 });
    expect(Object.keys(trail!).filter((k) => k.startsWith('live_trail/a/me_a/'))).toHaveLength(3);
    expect(t.db.points.size).toBe(0);
    expect((await t.repo.load()).meta.synced).toBe(3);
  });

  it('alıcıda daha yeni canlı nokta varsa (lastLiveTs) kuyruktaki eski nokta canlıyı ezmez, yalnızca ize gider', async () => {
    const t = setup();
    await t.repo.enqueue('me', sample(NOW - 2 * MINUTE), [share('a')], NOW);
    await t.repo.flush(t.flushDeps({ targets: [share('a')], lastLiveTs: NOW - MINUTE }));
    const paths = t.write.mock.calls.flatMap((c) => Object.keys(c[0]));
    expect(paths.some((p) => p.startsWith('live_locations/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('live_trail/a/me_a/'))).toBe(true);
  });

  it('bitmiş / durdurulmuş hedefin noktaları yazılmadan atılır; bağlantıya iz yazılmaz', async () => {
    const t = setup();
    await t.repo.enqueue('me', sample(NOW - 2 * MINUTE), [share('a'), share('b'), link('h1')], NOW);
    // b sunucuda bitti (hedef listesinde yok), a için kesme anahtarı kapalı ("Durdur").
    const r = await t.repo.flush(t.flushDeps({ targets: [share('a'), link('h1')], isAllowed: (x) => !(x.kind === 'share' && x.share_id === 'me_a') }));
    const paths = t.write.mock.calls.flatMap((c) => Object.keys(c[0]));
    expect(paths).toEqual(['link_live/h1']);
    expect(r.status).toBe('ok');
    expect(t.db.points.size).toBe(0);

    await t.repo.enqueue('me', sample(NOW - MINUTE), [share('b')], NOW);
    const r2 = await t.repo.flush(t.flushDeps({ targets: [share('a')] }));
    expect(r2.dropped).toBe(1);
    expect(t.db.points.size).toBe(0);
  });

  it('yazma hatası: noktalar kalır, üstel geri çekilme; force (bağlantı geldi) beklemeyi atlar', async () => {
    const t = setup();
    await t.repo.enqueue('me', sample(NOW - MINUTE), [share('a')], NOW);
    t.write.mockRejectedValue(new Error('network'));
    const r = await t.repo.flush(t.flushDeps({ targets: [share('a')] }));
    expect(r.status).toBe('partial');
    expect(r.pending).toBe(1);
    const meta = (await t.repo.load()).meta;
    expect(meta.attempt).toBe(1);
    expect(meta.nextAttemptAt).toBeGreaterThan(NOW);

    t.write.mockResolvedValue(undefined);
    expect(await t.repo.flush(t.flushDeps({ targets: [share('a')], now: NOW + 1 }))).toMatchObject({ status: 'backoff' });
    expect(await t.repo.flush(t.flushDeps({ targets: [share('a')], now: NOW + 1, force: true }))).toMatchObject({ status: 'ok', pending: 0 });
    expect((await t.repo.load()).meta).toMatchObject({ attempt: 0, nextAttemptAt: null });
  });

  it('bekleyen callable (düşük pil): ok → silinir, retry → kalır (deneme artar), drop → atılır; aynı op_id bir kez', async () => {
    const t = setup();
    const call = (op: string): Omit<PendingCall, 'attempts'> => ({ op_id: op, name: 'battery_low_notify', payload: { op_id: op }, created_at: NOW });
    await t.repo.queueCall('me', call('op1'));
    await t.repo.queueCall('me', call('op1'));
    await t.repo.queueCall('me', call('op2'));
    await t.repo.queueCall('me', call('op3'));
    expect((await t.repo.load()).meta.calls).toHaveLength(3);
    const outcome: Record<string, 'ok' | 'retry' | 'drop'> = { op1: 'ok', op2: 'retry', op3: 'drop' };
    const r = await t.repo.flush(t.flushDeps({ call: async (c) => outcome[c.op_id]! }));
    expect(r.status).toBe('partial');
    expect((await t.repo.load()).meta.calls).toEqual([expect.objectContaining({ op_id: 'op2', attempts: 1 })]);
    // 6 saatten eski çağrı atılır.
    const late = await t.repo.flush(t.flushDeps({ now: NOW + 7 * HOUR, force: true, call: async () => 'ok' }));
    expect(late.status).toBe('empty');
    expect((await t.repo.load()).meta.calls).toEqual([]);
  });

  it('"Durdur": yalnızca o hedef çıkarılır, hedefi kalmayan nokta silinir; çıkış: tüm kuyruk silinir', async () => {
    const t = setup();
    await t.repo.enqueue('me', sample(NOW - 2 * MINUTE), [share('a'), share('b')], NOW);
    await t.repo.enqueue('me', sample(NOW - MINUTE), [share('a')], NOW);
    expect(await t.repo.dropTargets(['s:me_a'])).toBe(1);
    const left = (await t.repo.load()).state.points;
    expect(left).toHaveLength(1);
    expect(left[0]!.target_ids).toEqual(['s:me_b']);
    await t.repo.purge();
    expect(t.db.points.size).toBe(0);
    expect(t.db.meta.size).toBe(0);
    expect(await t.repo.pendingCount()).toBe(0);
  });

  it('başka hesap girerse eski hesabın kuyruğu hiçbir şey göndermeden silinir', async () => {
    const t = setup();
    await t.repo.enqueue('me', sample(NOW - MINUTE), [share('a')], NOW);
    const r = await t.repo.flush(t.flushDeps({ uid: 'other' }));
    expect(r.status).toBe('empty');
    expect(t.write).not.toHaveBeenCalled();
    expect(t.db.points.size).toBe(0);
  });

  it('işlem yarıda kalırsa (disk hatası) depo tutarlı kalır', async () => {
    const t = setup();
    await t.repo.enqueue('me', sample(NOW - 2 * MINUTE), [share('a')], NOW);
    t.db.failNextTx();
    await expect(t.repo.enqueue('me', sample(NOW - MINUTE), [share('a')], NOW)).rejects.toThrow('disk dolu');
    expect(t.db.points.size).toBe(1);
    expect((await t.reopen().load()).state.points).toHaveLength(1);
  });

  it('AsyncStorage yedeği (web / jest) aynı sözleşmeyle çalışır', async () => {
    const repo = createOutboxRepo(() => asyncStorageOutboxStore);
    await repo.purge();
    await repo.enqueue('me', sample(NOW - MINUTE), [share('a')], NOW);
    expect(await asyncStorageOutboxStore.count()).toBe(1);
    const write = jest.fn<Promise<void>, [Record<string, unknown>]>().mockResolvedValue(undefined);
    expect(await repo.flush({ uid: 'me', now: NOW, targets: [share('a')], isAllowed: () => true, write })).toMatchObject({ status: 'ok', synced: 1 });
    expect(await asyncStorageOutboxStore.count()).toBe(0);
  });
});
