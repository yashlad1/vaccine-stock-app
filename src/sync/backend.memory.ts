import type { PushBatch, Row, SyncBackend } from './backend';
import type { SyncTable } from '../db/migrations/m002_sync';

/**
 * Test backend. Keyed by row id so it enforces the same idempotency the real
 * server does, which is the property most worth testing.
 */
export function memoryBackend(opts: { failEvery?: number } = {}) {
  const store = new Map<SyncTable, Map<string, Row>>();
  let pushes = 0;
  let seq = 0;

  const backend: SyncBackend = {
    async push(batch: PushBatch) {
      pushes += 1;
      if (opts.failEvery && pushes % opts.failEvery === 0) {
        throw new Error('simulated network failure');
      }
      const t = store.get(batch.table) ?? new Map<string, Row>();
      // A monotonic stand-in for Postgres's `now()` default, ONE per upload:
      // now() is fixed for the whole transaction, so every row of a batch
      // shares it. One stamp per row hid a pull bug that skipped rows.
      seq += 1;
      const stamp = String(seq).padStart(12, '0');
      for (const r of batch.rows) {
        const id = String(r.id);
        // stock_movements is append-only on the server too: first write wins.
        if (batch.table === 'stock_movements' && t.has(id)) continue;
        // Mirrors the server's stale-write guard: the newest EDIT wins, not
        // the newest UPLOAD. Without this the test backend would be more
        // permissive than Postgres and would hide the bug it exists to catch.
        const prev = t.get(id);
        if (prev && Number(r.updated_at ?? 0) < Number(prev.updated_at ?? 0)) continue;
        t.set(id, { ...r, synced_at: stamp });
      }
      store.set(batch.table, t);
    },
    async pullAll(table: SyncTable) {
      return [...(store.get(table)?.values() ?? [])];
    },
    async pullSince(table: SyncTable, since: string | null, limit: number, afterId?: string) {
      const key = (r: Row): [string, string] => [String(r.synced_at), String(r.id)];
      const rows = [...(store.get(table)?.values() ?? [])].sort((a, b) => {
        const [x, y] = [key(a), key(b)];
        return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0;
      });
      const after =
        !since
          ? rows
          : rows.filter(({ synced_at, id }) => {
              const s = String(synced_at);
              return s > since || (afterId !== undefined && s === since && String(id) > afterId);
            });
      return after.slice(0, limit);
    },
    async ping() {},
  };

  return {
    backend,
    rows: (table: SyncTable) => [...(store.get(table)?.values() ?? [])],
    count: (table: SyncTable) => store.get(table)?.size ?? 0,
    pushes: () => pushes,
  };
}
