const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { atlas, beacon, fixture, startApp, request } = require('./helpers.cjs');

const missing = 'f0000000-0000-4000-8000-000000000000';

test('both teams use the workflow without accepting caller-supplied scope or exposing foreign IDs', async (t) => {
  const { runtimeUrl } = await fixture(t);
  const { base, output } = await startApp(t, runtimeUrl);
  assert.equal((await request(base, '/healthz')).status, 200);
  assert.equal((await request(base, '/readyz')).status, 200);
  assert.equal((await request(base, '/v1/items')).status, 401);
  assert.equal((await request(base, '/v1/items', { key: 'wrong' })).status, 401);
  assert.equal((await request(base, '/v1/items/not-a-uuid', { key: atlas.key })).status, 400);
  assert.equal((await request(base, '/v1/items', {
    key: atlas.key, method: 'POST', body: { title: 'Injected', workspaceId: beacon.workspaceId },
  })).status, 400);
  const create = await request(base, '/v1/items', {
    key: atlas.key, method: 'POST', body: { title: 'Atlas private task' },
  });
  assert.equal(create.status, 201);
  assert.equal(create.body.status, 'open');
  assert.equal(create.body.title, 'Atlas private task');
  assert.match(create.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
  assert.equal(create.headers.get('cache-control'), 'no-store');
  const other = await request(base, '/v1/items', {
    key: beacon.key, method: 'POST', body: { title: 'Beacon task' },
  });
  assert.equal(other.status, 201);
  assert.deepEqual((await request(base, '/v1/items', {
    key: atlas.key, headers: { 'x-workspace-id': beacon.workspaceId },
  })).body.map((item) => item.id), [create.body.id]);
  assert.deepEqual((await request(base, '/v1/items', { key: beacon.key })).body.map((item) => item.id), [other.body.id]);

  const path = '/v1/items/' + create.body.id;
  const foreign = await request(base, path, { key: beacon.key });
  const absent = await request(base, '/v1/items/' + missing, { key: beacon.key });
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, absent.body);
  const close = { method: 'PATCH', body: { status: 'closed' } };
  assert.equal((await request(base, path, { ...close, key: beacon.key })).status, 404);
  assert.equal((await request(base, path, { key: atlas.key })).body.status, 'open');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await request(base, path, { ...close, key: atlas.key });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'closed');
  }
  assert.match(output(), /"route":"\/v1\/items\/:id"/);
  assert.doesNotMatch(output(), /Atlas private task|Bearer |local_test_runtime|demo_atlas_/);
});

test('the server refuses to listen with migration-owner credentials', async (t) => {
  const { migrationUrl } = await fixture(t);
  await assert.rejects(promisify(execFile)(process.execPath, ['dist/main.js'], {
    timeout: 5000,
    env: { ...process.env, DATABASE_URL: migrationUrl, PORT: '0', TENANTPROOF_DEMO: '1', TENANTPROOF_KEYS: '' },
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /unsafe_database_configuration/);
    assert.doesNotMatch(error.stdout, /listening/);
    assert.doesNotMatch(error.stderr, /local_test_migration/);
    return true;
  });
});

test('overlapping closes produce one event and conceal foreign activity', { timeout: 8000 }, async (t) => {
  const { runtimeUrl, adminUrl } = await fixture(t);
  const { base } = await startApp(t, runtimeUrl);
  const { body: item } = await request(base, '/v1/items', {
    key: atlas.key, method: 'POST', body: { title: 'Close once' },
  });
  const path = '/v1/items/' + item.id;
  const close = { key: atlas.key, method: 'PATCH', body: { status: 'closed' } };
  const { Pool } = require('pg');
  const { setTimeout: delay } = require('node:timers/promises');
  const admin = new Pool({ connectionString: adminUrl });
  t.after(() => admin.end());
  const lock = await admin.connect();
  let requests;
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM tenantproof.items WHERE id = $1 FOR UPDATE', [item.id]);
    requests = Promise.all([request(base, path, close), request(base, path, close)]);
    const deadline = Date.now() + 1500;
    for (;;) {
      const result = await admin.query(`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE usename = 'tenantproof_runtime' AND wait_event_type = 'Lock'
          AND query LIKE 'UPDATE tenantproof.items%'
      `);
      if (result.rows[0].waiting === 2) break;
      assert.ok(Date.now() < deadline, 'Both close operations must be in flight');
      await delay(20);
    }
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  const results = await requests;
  assert.deepEqual(results.map(({ status, body }) => [status, body.status]), [[200, 'closed'], [200, 'closed']]);
  const history = await request(base, path + '/activity', { key: atlas.key });
  assert.equal(history.status, 200);
  assert.equal(history.body.length, 1);
  assert.equal(history.body[0].type, 'closed');
  assert.ok(Number.isFinite(Date.parse(history.body[0].occurredAt)));
  const foreign = await request(base, path + '/activity', { key: beacon.key });
  const absent = await request(base, '/v1/items/' + missing + '/activity', { key: beacon.key });
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, absent.body);
});

test('a failed event insert rolls back the close and returns a safe error', async (t) => {
  const { runtimeUrl, owner } = await fixture(t);
  const { base, output } = await startApp(t, runtimeUrl);
  const { body: item } = await request(base, '/v1/items', {
    key: atlas.key, method: 'POST', body: { title: 'Rollback me' },
  });
  const path = '/v1/items/' + item.id;
  await owner.query('ALTER TABLE tenantproof.closure_events ADD CONSTRAINT test_failure CHECK (false) NOT VALID');
  const close = await request(base, path, { key: atlas.key, method: 'PATCH', body: { status: 'closed' } });
  assert.equal(close.status, 500);
  assert.equal(close.body.error.code, 'internal_error');
  assert.equal((await request(base, path, { key: atlas.key })).body.status, 'open');
  assert.deepEqual((await request(base, path + '/activity', { key: atlas.key })).body, []);
  assert.doesNotMatch(JSON.stringify(close.body) + output(), /test_failure|Rollback me/);
});
