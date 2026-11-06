import { Pool, type PoolClient } from 'pg';
import { UUID } from './config.js';

export class UnsafeDatabaseError extends Error {
  constructor() {
    super('Unsafe database configuration');
  }
}

export async function tenantTransaction<T>(
  pool: Pool,
  workspace: string,
  run: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(workspace)) throw new Error('Expected verified workspace scope');
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('tenantproof.workspace_id', $1, true)", [workspace]);
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

export async function verifyRuntime(pool: Pool): Promise<void> {
  const role = await pool.query<{ safe: boolean }>(`
    SELECT current_user = 'tenantproof_runtime' AND current_user = session_user
      AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database() AND d.datdba = r.oid)
      AND NOT has_schema_privilege(r.oid, 'tenantproof', 'CREATE')
      AS safe
    FROM pg_roles r WHERE r.rolname = current_user
  `);
  if (role.rows[0]?.safe !== true) throw new UnsafeDatabaseError();

  const result = await pool.query<{ relname: string; safe: boolean }>(`
    SELECT c.relname, owner.rolname = 'tenantproof_migrator'
      AND c.relrowsecurity AND c.relforcerowsecurity AND row_security_active(c.oid)
      AND has_table_privilege(c.oid, 'SELECT')
      AND NOT has_table_privilege(c.oid, 'DELETE, TRUNCATE, TRIGGER')
      AND NOT has_any_column_privilege(c.oid, 'REFERENCES')
      AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
      AS safe
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles owner ON owner.oid = c.relowner
    WHERE n.nspname = 'tenantproof' AND c.relname = ANY($1::text[]) AND c.relkind = 'r'
  `, [['items']]);
  if (result.rows.length !== 1 || result.rows.some(row => !row.safe)) throw new UnsafeDatabaseError();
}

export function runtimePool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 1500,
    statement_timeout: 3000,
    idle_in_transaction_session_timeout: 5000,
  });
  pool.on('error', () => console.error(JSON.stringify({ event: 'database_pool_error' })));
  return pool;
}
