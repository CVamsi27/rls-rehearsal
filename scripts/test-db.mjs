import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const mode = process.argv[2] ?? 'all';
const entries = {
  all: [process.execPath, '--test', '--test-concurrency=1', 'test/database.test.cjs', 'test/http.test.cjs'],
  control: [process.execPath, '--test', '--test-name-pattern=broken fixture', 'test/database.test.cjs'],
};
const command = entries[mode];
if (!command) throw new Error('Unknown database test mode');

const image = 'postgres:17-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994';
const name = 'tenantproof-test-' + randomUUID().slice(0, 12);
const init = fileURLToPath(new URL('../db/init.sh', import.meta.url));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();

let child;
const interrupt = () => child?.kill('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

try {
  docker('run', '--detach', '--rm', '--name', name, '--publish', '127.0.0.1::5432',
    '--mount', 'type=bind,src=' + init + ',dst=/docker-entrypoint-initdb.d/10-roles.sh,readonly',
    '-e', 'POSTGRES_DB=tenantproof_template', '-e', 'POSTGRES_PASSWORD=local_test_admin',
    '-e', 'TENANTPROOF_MIGRATION_PASSWORD=local_test_migration',
    '-e', 'TENANTPROOF_RUNTIME_PASSWORD=local_test_runtime', image);
  const address = docker('port', name, '5432/tcp');
  const adminUrl = 'postgres://postgres:local_test_admin@' + address + '/postgres';
  const deadline = Date.now() + 25_000;
  for (;;) {
    const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 500 });
    try {
      await client.connect();
      const { rows } = await client.query("select 1 from pg_roles where rolname = 'tenantproof_runtime'");
      if (rows.length === 1) break;
    } catch {
      // The temporary initialization server does not accept TCP connections.
    } finally {
      await client.end();
    }
    if (Date.now() >= deadline) throw new Error('Disposable PostgreSQL did not initialize');
    await delay(250);
  }

  const [executable, ...args] = command;
  process.exitCode = await new Promise((resolve, reject) => {
    child = spawn(executable, args, {
      stdio: 'inherit',
      env: { ...process.env, TEST_ADMIN_URL: adminUrl },
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
  // Remove only the container created for this run and its anonymous volume.
  try {
    docker('rm', '-fv', name);
  } catch {
    // A container that already exited has been removed by --rm.
  }
}
