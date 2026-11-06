import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

const directory = join(import.meta.dirname, '../db/migrations');

export async function migrate(connectionString: string): Promise<void> {
  const files = (await readdir(directory)).filter(name => /^\d{3}_[a-z_]+\.sql$/.test(name)).sort();
  if (!files.length) throw new Error('No migration files found');

  const client = new Client({ connectionString, connectionTimeoutMillis: 3000, statement_timeout: 15_000 });
  try {
    await client.connect();
    const { rows } = await client.query<{ role: string }>('SELECT current_user AS role');
    if (rows[0]?.role !== 'tenantproof_migrator') throw new Error('Expected the migration owner');
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1348943372)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenantproof_meta.migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM tenantproof_meta.migrations ORDER BY name',
    );
    if (applied.rows.some((row, index) => row.name !== files[index])) {
      throw new Error('Applied migrations are not a prefix of this release');
    }
    for (const [index, name] of files.entries()) {
      const sql = await readFile(join(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.rows[index];
      if (previous) {
        if (previous.checksum !== checksum) throw new Error('Applied migration checksum changed');
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO tenantproof_meta.migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
    }
    await client.query('COMMIT');
  } finally {
    // Closing this dedicated connection rolls back an incomplete migration.
    await client.end();
  }
}

if (import.meta.main) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('MIGRATION_DATABASE_URL is required');
    process.exitCode = 1;
  } else {
    void migrate(url).then(() => console.log('Migrations applied')).catch(() => {
      console.error('Migration failed. Check connectivity, migration ownership, and schema history.');
      process.exitCode = 1;
    });
  }
}
