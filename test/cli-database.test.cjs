const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFile } = require('node:child_process');
const { mkdtemp, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Pool } = require('pg');
const { tenantTransaction } = require('../dist/database.js');
const { atlas, beacon, fixture } = require('./helpers.cjs');

const cli = join(__dirname, '..', 'cli', 'dist', 'main.js');

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, NO_COLOR: '1', ...env }, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr });
      },
    );
  });
}

function config() {
  return {
    version: 1,
    connection: { env: 'RLS_REHEARSAL_DATABASE_URL' },
    actors: {
      atlas: {
        tenant: atlas.workspaceId,
        settings: { 'tenantproof.workspace_id': atlas.workspaceId },
      },
      beacon: {
        tenant: beacon.workspaceId,
        settings: { 'tenantproof.workspace_id': beacon.workspaceId },
      },
    },
    resources: {
      items: {
        table: 'tenantproof.items',
        tenantColumn: 'workspace_id',
        identifierColumns: ['id'],
        minRows: 1,
      },
      closure_events: {
        table: 'tenantproof.closure_events',
        tenantColumn: 'workspace_id',
        identifierColumns: ['item_id'],
        minRows: 0,
      },
    },
    checks: [
      {
        name: 'atlas cannot read a beacon item by id',
        actor: 'atlas',
        resource: 'items',
        sql: 'SELECT id FROM tenantproof.items WHERE id = $1',
        params: [{ fromActor: 'beacon', fromResource: 'items', column: 'id' }],
        expect: { rows: 0 },
      },
      {
        name: 'atlas cannot insert into beacon',
        actor: 'atlas',
        kind: 'write',
        sql: 'INSERT INTO tenantproof.items (workspace_id, title) VALUES ($1, $2)',
        params: [
          { fromActor: 'beacon', fromResource: 'items', column: 'workspace_id' },
          'rls-rehearsal foreign insert',
        ],
        expect: { denied: true },
      },
      {
        name: 'atlas can insert its own item',
        actor: 'atlas',
        kind: 'write',
        sql: 'INSERT INTO tenantproof.items (workspace_id, title) VALUES ($1, $2)',
        params: [
          { fromActor: 'atlas', fromResource: 'items', column: 'workspace_id' },
          'rls-rehearsal own insert',
        ],
        expect: { succeeds: true },
      },
      {
        name: 'beacon cannot update an atlas item',
        actor: 'beacon',
        kind: 'write',
        sql: "UPDATE tenantproof.items SET status = 'closed' WHERE id = $1",
        params: [{ fromActor: 'atlas', fromResource: 'items', column: 'id' }],
        expect: { rows: 0 },
      },
    ],
    defaults: { statementTimeoutMs: 5000, failOnEmpty: true },
  };
}

async function seed(runtime) {
  for (const team of [atlas, beacon]) {
    await tenantTransaction(runtime, team.workspaceId, (tx) =>
      tx.query('INSERT INTO tenantproof.items (workspace_id, title) VALUES ($1, $2)', [
        team.workspaceId,
        `${team.name} baseline`,
      ]),
    );
  }
}

test('CLI runs the matrix, rolls back writes, leaks in control mode and writes every report', async (t) => {
  const { runtime, runtimeUrl, adminUrl } = await fixture(t);
  await seed(runtime);

  const dir = await mkdtemp(join(tmpdir(), 'rls-cli-'));
  const configPath = join(dir, 'rls.json');
  const out = join(dir, 'reports');
  await writeFile(configPath, JSON.stringify(config(), null, 2));

  const result = await runCli(
    [
      'run',
      '--config',
      configPath,
      '--format',
      'json,md,junit',
      '--out',
      out,
      '--control',
      '--admin-url',
      adminUrl,
    ],
    { RLS_REHEARSAL_DATABASE_URL: runtimeUrl },
  );

  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /matrix/);
  assert.match(result.stdout, /control \(RLS disabled/);
  assert.match(result.stdout, /0 failed/);

  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.leaks, 0);
  assert.equal(report.matrix.length, 4, 'two actors across two resources');
  assert.equal(report.checks.length, 4);
  assert.equal(report.control.length, 4);
  assert.ok(report.control.some((row) => row.status === 'leaked'));
  assert.ok(report.control.some((row) => row.status === 'skipped'));
  assert.match(await readFile(join(out, 'report.md'), 'utf8'), /## Control mode/);
  assert.match(await readFile(join(out, 'report.xml'), 'utf8'), /<testsuites/);

  const admin = new Pool({ connectionString: adminUrl });
  try {
    const items = await admin.query('SELECT count(*)::int AS count FROM tenantproof.items');
    assert.equal(items.rows[0].count, 2, 'write checks must roll back');
  } finally {
    await admin.end();
  }
});

test('doctor passes a healthy schema and the matrix catches a broken policy', async (t) => {
  const { runtime, runtimeUrl, adminUrl } = await fixture(t);
  await seed(runtime);
  const dir = await mkdtemp(join(tmpdir(), 'rls-cli-broken-'));
  const configPath = join(dir, 'rls.json');
  await writeFile(configPath, JSON.stringify(config(), null, 2));

  const healthy = await runCli(['doctor', '--config', configPath], {
    RLS_REHEARSAL_DATABASE_URL: runtimeUrl,
  });
  assert.equal(healthy.code, 0, healthy.stderr + healthy.stdout);
  assert.match(healthy.stdout, /doctor: ready/);
  assert.match(healthy.stdout, /RLS enabled and forced/);

  const admin = new Pool({ connectionString: adminUrl });
  try {
    await admin.query('ALTER TABLE tenantproof.items DISABLE ROW LEVEL SECURITY');
  } finally {
    await admin.end();
  }

  const broken = await runCli(
    ['run', '--config', configPath, '--format', 'json', '--out', join(dir, 'reports')],
    { RLS_REHEARSAL_DATABASE_URL: runtimeUrl },
  );
  assert.equal(broken.code, 1, broken.stderr + broken.stdout);
  assert.match(broken.stdout, /FAIL/);
  assert.match(broken.stdout, /foreign/);
  const report = JSON.parse(await readFile(join(dir, 'reports', 'report.json'), 'utf8'));
  assert.ok(report.matrix.some((row) => row.status === 'fail' && row.foreignRows > 0));
  assert.ok(report.summary.leaks >= 1);
});

test('a privileged tested role is refused unless explicitly allowed', async (t) => {
  const { runtime, runtimeUrl, adminUrl } = await fixture(t);
  await seed(runtime);
  const dir = await mkdtemp(join(tmpdir(), 'rls-cli-privileged-'));
  const configPath = join(dir, 'rls.json');
  await writeFile(configPath, JSON.stringify(config(), null, 2));

  const refused = await runCli(['run', '--config', configPath], {
    RLS_REHEARSAL_DATABASE_URL: adminUrl,
  });
  assert.equal(refused.code, 3, refused.stderr + refused.stdout);
  assert.match(refused.stderr, /superuser|BYPASSRLS/);

  const doctor = await runCli(['doctor', '--config', configPath], {
    RLS_REHEARSAL_DATABASE_URL: adminUrl,
  });
  assert.equal(doctor.code, 1);
  assert.match(doctor.stdout, /\[error\]/);
});
