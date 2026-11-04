import type { SyncTable } from '../db/migrations/m002_sync';
import { SyncAuthError, SyncNetworkError, type PushBatch, type Row, type SyncBackend } from './backend';

/**
 * Supabase adapter, written against the REST API with plain `fetch`.
 *
 * No `@supabase/supabase-js`, deliberately, and for the same reasons the top
 * tab bar and the expiry wheel are hand-written: a dependency here would have
 * to be carried forever, would rotate the OTA fingerprint on every upgrade, and
 * we use perhaps four endpoints of it. PostgREST is a plain HTTP API.
 *
 * This is the ONLY file that knows the server is Supabase.
 */

export interface SupabaseConfig {
  url: string;
  /** The publishable (formerly "anon") key. Safe on a device; RLS is the guard. */
  publishableKey: string;
  email: string;
  password: string;
}

interface Session {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
}

/** Upsert behaviour per table, mirroring the local invariants. */
function conflictPolicy(table: SyncTable): string {
  // The ledger is append-only on both sides: if the row is already there, that
  // is a successful retry, not something to overwrite.
  return table === 'stock_movements' ? 'ignore-duplicates' : 'merge-duplicates';
}

const clean = (url: string) => url.replace(/\/+$/, '');

export function supabaseBackend(cfg: SupabaseConfig): SyncBackend & { signOut: () => void } {
  let session: Session | null = null;

  const request = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetch(`${clean(cfg.url)}${path}`, init);
    } catch (e) {
      // fetch only rejects on a genuine transport failure. Everything else -
      // 401, 409, 500 - arrives as a Response, so this really is "no network".
      throw new SyncNetworkError(e instanceof Error ? e.message : 'Network request failed');
    }
  };

  const toSession = (j: { access_token: string; refresh_token: string; expires_in: number }): Session => ({
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    // 60s of slack, so a long push does not expire mid-flight.
    expiresAt: Date.now() + (j.expires_in - 60) * 1000,
  });

  const passwordGrant = async (): Promise<Response> =>
    request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: cfg.publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: cfg.email, password: cfg.password }),
    });

  /**
   * Sign in, creating the account on first run if it does not exist yet.
   *
   * This is what removes the last manual setup step: the clinic phone provisions
   * its own account instead of someone creating one in the Supabase dashboard
   * and relaying the details. Self-provisioning only succeeds if email
   * confirmation is off for the project - if it is on, the account is created
   * but cannot sign in, so that case gets its own message rather than a generic
   * auth failure, because the fix is a project setting and nothing the phone can
   * do about it.
   */
  const signIn = async (): Promise<Session> => {
    let res = await passwordGrant();
    if (res.ok) return toSession(await res.json());

    const first = await res.text().catch(() => '');
    // 400 "Invalid login credentials" covers both a wrong password and an
    // account that was never created; signing up distinguishes them.
    if (res.status !== 400) {
      throw new SyncAuthError(`Sign-in failed (${res.status}). ${first.slice(0, 160)}`);
    }

    const signup = await request('/auth/v1/signup', {
      method: 'POST',
      headers: { apikey: cfg.publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: cfg.email, password: cfg.password }),
    });
    if (!signup.ok) {
      const body = await signup.text().catch(() => '');
      // Signups disabled means the account really must be made by hand.
      throw new SyncAuthError(
        `Could not sign in, and could not create the account (${signup.status}). ${body.slice(0, 160)}`,
      );
    }

    res = await passwordGrant();
    if (res.ok) return toSession(await res.json());
    throw new SyncAuthError(
      'The account was created but cannot sign in yet. In Supabase, open ' +
        'Authentication → Providers → Email and turn OFF "Confirm email", or add the ' +
        'user manually with "Auto Confirm User" ticked.',
    );
  };

  const token = async (): Promise<string> => {
    if (session && Date.now() < session.expiresAt) return session.accessToken;
    if (session) {
      const res = await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: cfg.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
      });
      if (res.ok) {
        session = toSession(await res.json());
        return session.accessToken;
      }
      // A refresh token can be revoked or simply expire; fall through and use
      // the stored password rather than making her re-enter it.
      session = null;
    }
    session = await signIn();
    return session.accessToken;
  };

  const headers = async (extra: Record<string, string> = {}) => ({
    apikey: cfg.publishableKey,
    Authorization: `Bearer ${await token()}`,
    'Content-Type': 'application/json',
    ...extra,
  });

  return {
    async push(batch: PushBatch) {
      if (!batch.rows.length) return;
      const res = await request(`/rest/v1/${batch.table}?on_conflict=id`, {
        method: 'POST',
        headers: await headers({
          Prefer: `resolution=${conflictPolicy(batch.table)},return=minimal`,
        }),
        body: JSON.stringify(batch.rows),
      });
      if (res.status === 401 || res.status === 403) {
        throw new SyncAuthError(`The server rejected this account (${res.status}).`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Surfaced verbatim into sync_log: a PostgREST message names the exact
        // column, which is what makes a schema mismatch diagnosable over
        // WhatsApp instead of needing the phone in hand.
        throw new Error(`Upload of ${batch.table} failed (${res.status}): ${body.slice(0, 300)}`);
      }
    },

    async annotate(rows: Row[]) {
      // One PATCH per row: the values differ per row, and an upsert would need
      // the UPDATE policy for its insert half too, failing whole batches of
      // doses on a server without it. That server matches no row here
      // (no UPDATE policy), so it answers [] and nothing else changes.
      const taken = new Set<string>();
      try {
        for (const { id, ...annotations } of rows) {
          const res = await request(
            `/rest/v1/stock_movements?id=eq.${encodeURIComponent(String(id))}&select=id`,
            {
              method: 'PATCH',
              headers: await headers({ Prefer: 'return=representation' }),
              body: JSON.stringify(annotations),
            },
          );
          if (!res.ok || !((await res.json()) as Row[]).length) break;
          taken.add(String(id));
        }
      } catch {
        // Offline or signed out: the rows stay queued for the next pass.
      }
      return taken;
    },

    async pullSince(table: SyncTable, since: string | null, limit: number, afterId?: string) {
      // Ordered and filtered by the SERVER's clock, so a device with a wrong
      // clock cannot make its own rows invisible to everyone else. The id
      // breaks ties, because one upload stamps all of its rows alike.
      // Quoted, because a timestamp holds `.` and `:`, which PostgREST's
      // or=(...) syntax reserves.
      const q = (v: string) => `"${v}"`;
      const filter =
        !since
          ? ''
          : afterId === undefined
          ? `&synced_at=gt.${encodeURIComponent(since)}`
          : `&or=${encodeURIComponent(
              `(synced_at.gt.${q(since)},and(synced_at.eq.${q(since)},id.gt.${q(afterId)}))`,
            )}`;
      const res = await request(
        `/rest/v1/${table}?select=*${filter}&order=synced_at.asc,id.asc&limit=${limit}`,
        { method: 'GET', headers: await headers() },
      );
      if (res.status === 401 || res.status === 403) {
        throw new SyncAuthError(`The server rejected this account (${res.status}).`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Download of ${table} failed (${res.status}): ${body.slice(0, 300)}`);
      }
      return (await res.json()) as Row[];
    },

    async pullAll(table: SyncTable) {
      const PAGE = 1000;
      const all: Row[] = [];
      for (let from = 0; ; from += PAGE) {
        const res = await request(`/rest/v1/${table}?select=*&order=id.asc`, {
          method: 'GET',
          headers: await headers({ Range: `${from}-${from + PAGE - 1}` }),
        });
        if (res.status === 401 || res.status === 403) {
          throw new SyncAuthError(`The server rejected this account (${res.status}).`);
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`Download of ${table} failed (${res.status}): ${body.slice(0, 300)}`);
        }
        const page = (await res.json()) as Row[];
        all.push(...page);
        if (page.length < PAGE) return all;
      }
    },

    async ping() {
      // Proves three things at once: the URL resolves, the key is accepted, and
      // the account can actually read its own rows through RLS.
      const res = await request('/rest/v1/vaccines?select=id&limit=1', {
        method: 'GET',
        headers: await headers(),
      });
      if (res.status === 401 || res.status === 403) {
        throw new SyncAuthError('The email or password was not accepted.');
      }
      if (res.status === 404) {
        throw new Error('Connected, but the tables are missing. Run supabase/schema.sql first.');
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Server error (${res.status}): ${body.slice(0, 200)}`);
      }
    },

    signOut() {
      session = null;
    },
  };
}
