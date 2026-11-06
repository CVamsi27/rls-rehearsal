const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Pool } = require('pg');
const { tenantTransaction, verifyRuntime } = require('../dist/database.js');
const { atlas, beacon, fixture } = require('./helpers.cjs');

async function seed(runtime) {
  for (const team of [atlas, beacon]) {
    await tenantTransaction(runtime, team.workspaceId, (tx) => tx.query(
      'INSERT INTO tenantproof.items (workspace_id, title) VALUES ($1, $2)', [team.workspaceId, team.name],
    ));
  }
  const beaconRow = await tenantTransaction(runtime, beacon.workspaceId, (tx) =>
    tx.query('SELECT id FROM tenantproof.items WHERE title = $1', [beacon.name]));
  assert.equal(beaconRow.rowCount, 1, 'Beacon fixture must exist');
  return beaconRow.rows[0].id;
}

async function assertAtlasIsolation(runtime) {
  const result = await tenantTransaction(runtime, atlas.workspaceId, (tx) =>
    tx.query('SELECT title FROM tenantproof.items ORDER BY title'));
  assert.deepEqual(result.rows.map((row) => row.title), ['Atlas'], 'unfiltered tenant read');
}

test('RLS isolates unfiltered reads and foreign writes under runtime credentials', async (t) => {
  const { runtime } = await fixture(t);
  await verifyRuntime(runtime);
  const id = await seed(runtime);
  await assertAtlasIsolation(runtime);
  await tenantTransaction(runtime, atlas.workspaceId, async (tx) => {
    assert.equal((await tx.query('SELECT id FROM tenantproof.items WHERE id = $1', [id])).rowCount, 0);
    assert.equal((await tx.query("UPDATE tenantproof.items SET status = 'closed' WHERE id = $1", [id])).rowCount, 0);
  });
  for (const [statement, params] of [
    ["INSERT INTO tenantproof.items (workspace_id, title) VALUES ($1, 'foreign')", [beacon.workspaceId]],
    ['UPDATE tenantproof.items SET workspace_id = $1', [beacon.workspaceId]],
    ['DELETE FROM tenantproof.items', []],
    ['TRUNCATE tenantproof.items', []],
    ['ALTER TABLE tenantproof.items DISABLE ROW LEVEL SECURITY', []],
  ]) {
    await assert.rejects(tenantTransaction(runtime, atlas.workspaceId, (tx) => tx.query(statement, params)), { code: '42501' });
  }
  await tenantTransaction(runtime, beacon.workspaceId, async (tx) => {
    assert.equal((await tx.query('SELECT status FROM tenantproof.items WHERE id = $1', [id])).rows[0].status, 'open');
  });
});

test('one pooled connection forgets scope after commit and rollback', async (t) => {
  const { runtime } = await fixture(t);
  await seed(runtime);
  let scopedPid;
  for (const rollback of [false, true]) {
    const run = tenantTransaction(runtime, atlas.workspaceId, async (tx) => {
      scopedPid = (await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      assert.equal((await tx.query('SELECT id FROM tenantproof.items')).rowCount, 1);
      if (rollback) throw new Error('force rollback');
    });
    if (rollback) await assert.rejects(run, /force rollback/);
    else await run;
    const result = await runtime.query('SELECT pg_backend_pid() AS pid, (SELECT count(*)::int FROM tenantproof.items) AS visible');
    assert.deepEqual(result.rows, [{ pid: scopedPid, visible: 0 }]);
    await assert.rejects(runtime.query("INSERT INTO tenantproof.items (workspace_id, title) VALUES ($1, 'unscoped')",
      [atlas.workspaceId]), { code: '42501' });
  }
});

test('two simultaneous transactions keep separate tenant contexts', { timeout: 5000 }, async (t) => {
  const { runtime, runtimeUrl } = await fixture(t);
  await seed(runtime);
  const pool = new Pool({ connectionString: runtimeUrl, max: 2, connectionTimeoutMillis: 1000 });
  t.after(() => pool.end());
  let arrive;
  const barrier = new Promise((resolve) => { arrive = resolve; });
  let waiting = 0;
  const results = await Promise.all([atlas, beacon].map((team) =>
    tenantTransaction(pool, team.workspaceId, async (tx) => {
      if (++waiting === 2) arrive();
      await Promise.race([barrier, new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Second transaction never acquired a connection')), 1500).unref();
      })]);
      const result = await tx.query('SELECT pg_backend_pid() AS pid, title FROM tenantproof.items');
      assert.deepEqual(result.rows.map((row) => row.title), [team.name]);
      return result.rows[0].pid;
    })));
  assert.notEqual(results[0], results[1]);
});

test('broken fixture: the same unfiltered-read assertion catches the leak', async (t) => {
  const { runtime, owner } = await fixture(t);
  await seed(runtime);
  await assertAtlasIsolation(runtime);
  await owner.query('ALTER TABLE tenantproof.items DISABLE ROW LEVEL SECURITY');
  await assert.rejects(assertAtlasIsolation(runtime), (error) => {
    assert.equal(error.code, 'ERR_ASSERTION');
    assert.deepEqual(error.actual, ['Atlas', 'Beacon']);
    assert.deepEqual(error.expected, ['Atlas']);
    return true;
  });
  await assert.rejects(verifyRuntime(runtime), /unsafe database configuration/i);
  t.diagnostic('Control caught Beacon’s seeded row in Atlas’s unfiltered read.');
});

test('activity foreign keys reject a valid item ID from another workspace', async (t) => {
  const { runtime } = await fixture(t);
  const id = await seed(runtime);
  await assert.rejects(tenantTransaction(runtime, atlas.workspaceId, (tx) => tx.query(
    'INSERT INTO tenantproof.closure_events (workspace_id, item_id) VALUES ($1, $2)',
    [atlas.workspaceId, id],
  )), { code: '23503' });
  await tenantTransaction(runtime, atlas.workspaceId, async (tx) => {
    assert.equal((await tx.query('SELECT item_id FROM tenantproof.closure_events')).rowCount, 0);
  });
});

test('the activity policy isolates unfiltered reads and denies forged ownership', async (t) => {
  const { runtime } = await fixture(t);
  await seed(runtime);
  let beaconItemId;
  for (const team of [atlas, beacon]) {
    await tenantTransaction(runtime, team.workspaceId, async (tx) => {
      const { rows } = await tx.query('SELECT id FROM tenantproof.items');
      const id = rows[0].id;
      await tx.query('INSERT INTO tenantproof.closure_events (workspace_id, item_id) VALUES ($1, $2)',
        [team.workspaceId, id]);
      if (team === beacon) beaconItemId = id;
    });
  }
  const own = await tenantTransaction(runtime, atlas.workspaceId, (tx) =>
    tx.query('SELECT workspace_id FROM tenantproof.closure_events'));
  assert.deepEqual(own.rows, [{ workspace_id: atlas.workspaceId }]);
  await assert.rejects(tenantTransaction(runtime, atlas.workspaceId, (tx) =>
    tx.query('INSERT INTO tenantproof.closure_events (workspace_id, item_id) VALUES ($1, $2)',
      [beacon.workspaceId, beaconItemId])), { code: '42501' });
});
