import { Pool, type PoolClient } from 'pg';
import { UnsafeTargetError } from './errors.js';
import type { ResolvedActor } from './types.js';

const CLAIM_KEY = /^[A-Za-z0-9_.-]+$/;
const SETTING_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function createPool(connectionString: string, statementTimeoutMs: number): Pool {
  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 3000,
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: Math.max(10_000, statementTimeoutMs * 2),
    application_name: 'rls-rehearsal',
  });
  pool.on('error', () => {
    // A pool error must not crash a CLI run; the active query reports the failure.
  });
  return pool;
}

type RoleFacts = {
  current_user: string;
  session_user: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
};

export async function roleFacts(client: PoolClient): Promise<RoleFacts> {
  const result = await client.query<RoleFacts>(`
    SELECT current_user::text AS current_user,
           session_user::text AS session_user,
           r.rolsuper,
           r.rolbypassrls
    FROM pg_roles r
    WHERE r.rolname = current_user
  `);
  const row = result.rows[0];
  if (!row) throw new Error('Cannot read the current database role');
  return row;
}

async function applySession(client: PoolClient, actor: ResolvedActor): Promise<void> {
  if (actor.role) {
    await client.query(`SET LOCAL ROLE ${quoteIdent(actor.role)}`);
    const identity = await roleFacts(client);
    if (identity.current_user !== actor.role) {
      throw new Error(`SET LOCAL ROLE did not switch to ${actor.role}`);
    }
  }

  if (actor.claims && Object.keys(actor.claims).length > 0) {
    await client.query('SELECT set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify(actor.claims),
    ]);
    for (const [key, value] of Object.entries(actor.claims)) {
      if (!CLAIM_KEY.test(key)) continue;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
      await client.query('SELECT set_config($1, $2, true)', [
        `request.jwt.claim.${key}`,
        String(value),
      ]);
    }
  }

  for (const [key, value] of Object.entries(actor.settings ?? {})) {
    if (!SETTING_KEY.test(key)) throw new Error(`Unsafe setting name: ${key}`);
    await client.query('SELECT set_config($1, $2, true)', [key, value]);
  }
}

export async function withActorSession<T>(
  pool: Pool,
  actor: ResolvedActor,
  statementTimeoutMs: number,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${Math.max(100, Math.floor(statementTimeoutMs))}`);
    await applySession(client, actor);
    return await run(client);
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    client.release(broken);
  }
}

export async function assertSessionSafe(
  client: PoolClient,
  actorName: string,
  allowPrivileged: boolean,
): Promise<string[]> {
  const warnings: string[] = [];
  const facts = await roleFacts(client);
  if (facts.rolsuper || facts.rolbypassrls) {
    const kind = facts.rolsuper ? 'superuser' : 'BYPASSRLS role';
    if (!allowPrivileged) {
      throw new UnsafeTargetError(
        `Actor "${actorName}" runs as the ${kind} "${facts.current_user}". ` +
          'A privileged session can bypass RLS, so the matrix would not test a policy. ' +
          'Connect through a restricted role or pass --allow-privileged to acknowledge the risk.',
      );
    }
    warnings.push(
      `Actor "${actorName}" runs as the ${kind} "${facts.current_user}"; RLS may be bypassed.`,
    );
  }
  return warnings;
}

export async function isPrivileged(client: PoolClient): Promise<{ privileged: boolean; role: string; reason: string }> {
  const facts = await roleFacts(client);
  const privileged = facts.rolsuper || facts.rolbypassrls;
  return {
    privileged,
    role: facts.current_user,
    reason: facts.rolsuper ? 'superuser' : facts.rolbypassrls ? 'BYPASSRLS' : '',
  };
}
