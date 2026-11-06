import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [oldRef, newRef] = process.argv.slice(2);
if (!oldRef || !newRef || ![oldRef, newRef].every(ref => /^[\w][\w./-]*$/.test(ref))) {
  throw new Error('Usage: npm run rehearse -- <v0.1 ref> <v0.2 ref>');
}

const dir = mkdtempSync(join(tmpdir(), 'tenantproof-rehearsal-'));
const suffix = randomUUID().slice(0, 8);
const project = 'tenantproof-rehearsal-' + suffix;
const oldImage = 'tenantproof-rehearsal:' + suffix + '-old';
const newImage = 'tenantproof-rehearsal:' + suffix + '-new';
const [atlas, beacon] = JSON.parse(readFileSync(new URL('../examples/workspaces.json', import.meta.url), 'utf8'));
let image = oldImage;
let base;

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', timeout: 240_000, ...options });
}

function compose(...args) {
  return run('docker', ['compose', '--file', 'compose.yaml', '--project-name', project, ...args], {
    env: { ...process.env, APP_PORT: '0', TENANTPROOF_IMAGE: image },
  }).trim();
}

function build(ref, tag, label) {
  const commit = run('git', ['rev-parse', '--verify', ref + '^{commit}']).trim();
  const folder = join(dir, label);
  const archive = join(dir, label + '.tar');
  mkdirSync(folder);
  run('git', ['archive', '--format=tar', '--output=' + archive, commit]);
  run('tar', ['-xf', archive, '-C', folder]);
  run('docker', ['build', '--tag', tag, folder], { stdio: 'inherit' });
  console.log('Built ' + ref + ' at ' + commit);
}

async function call(path, status, { team, method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(team ? { authorization: 'Bearer ' + team.key } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(6000),
  });
  assert.equal(response.status, status, method + ' ' + path);
  return response.json();
}

async function start(version) {
  image = version;
  compose('up', '-d', '--no-deps', '--no-build', '--force-recreate', '--wait', 'app');
  base = 'http://' + compose('port', 'app', '3000');
  await call('/readyz', 200);
}

const itemPath = (item) => '/v1/items/' + item.id;
const create = (team, title) => call('/v1/items', 201, { team, method: 'POST', body: { title } });
const close = (team, item, status = 200) => call(itemPath(item), status, {
  team, method: 'PATCH', body: { status: 'closed' },
});

async function checkIsolation(a, b) {
  for (const [team, own, foreign] of [[atlas, a, b], [beacon, b, a]]) {
    const visible = await call('/v1/items', 200, { team });
    assert.ok(visible.some(item => item.id === own.id));
    assert.ok(!visible.some(item => item.id === foreign.id));
    await call(itemPath(foreign), 404, { team });
    await close(team, foreign, 404);
  }
}

function sql(statement) {
  return compose('exec', '-T', 'db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', 'tenantproof', '-c', statement);
}

async function baseline() {
  assert.match(atlas.workspaceId, /^[a-f0-9-]{36}$/i);
  sql(`BEGIN;
    SET LOCAL ROLE tenantproof_runtime;
    SELECT set_config('tenantproof.workspace_id', '${atlas.workspaceId}', true);
    INSERT INTO tenantproof.items(workspace_id, title)
      SELECT '${atlas.workspaceId}'::uuid, 'Baseline ' || n FROM generate_series(1, 2000) AS n;
    COMMIT;
    ANALYZE tenantproof.items;`);

  const times = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const items = await call('/v1/items', 200, { team: atlas });
      assert.equal(items.length, 50);
      times.push(performance.now() - start);
    }
  }));
  times.sort((a, b) => a - b);
  console.log('Baseline: 80 successful list calls at concurrency 4, 2,000 seeded items; p95 ' +
    times[Math.ceil(times.length * 0.95) - 1].toFixed(1) + ' ms.');
  console.log(sql(`BEGIN;
    SET LOCAL ROLE tenantproof_runtime;
    SELECT set_config('tenantproof.workspace_id', '${atlas.workspaceId}', true);
    EXPLAIN (ANALYZE, BUFFERS) SELECT id, title, status, created_at
    FROM tenantproof.items WHERE workspace_id = '${atlas.workspaceId}'::uuid
    ORDER BY created_at DESC, id DESC LIMIT 50;
    ROLLBACK;`));
}

try {
  build(oldRef, oldImage, 'old');
  build(newRef, newImage, 'new');
  compose('up', '-d', '--wait', 'db');
  compose('run', '--rm', '--no-deps', 'migrate');
  await start(oldImage);
  const a = await create(atlas, 'Before upgrade');
  const b = await create(beacon, 'Other workspace');
  await checkIsolation(a, b);

  image = newImage;
  compose('run', '--rm', '--no-deps', 'migrate');
  await checkIsolation(a, b);
  console.log('PASS: The old app remained usable after migration 002.');

  await start(newImage);
  await checkIsolation(a, b);
  assert.deepEqual(await call(itemPath(a) + '/activity', 200, { team: atlas }), []);
  assert.equal((await close(atlas, a)).status, 'closed');
  const [event] = await call(itemPath(a) + '/activity', 200, { team: atlas });
  assert.equal(event.type, 'closed');
  const c = await create(atlas, 'Close during rollback');
  console.log('PASS: The new image preserved old data and recorded one closure.');

  compose('stop', 'db');
  await call('/healthz', 200);
  await call('/readyz', 503);
  compose('start', 'db');
  const recoveryDeadline = Date.now() + 15_000;
  for (;;) {
    try {
      await call('/readyz', 200);
      break;
    } catch (error) {
      if (Date.now() >= recoveryDeadline) throw error;
      await delay(300);
    }
  }
  await checkIsolation(a, b);
  console.log('PASS: Liveness stayed 200, readiness returned 503, and the app recovered after PostgreSQL restarted.');

  await start(oldImage);
  await checkIsolation(a, b);
  assert.equal((await call(itemPath(a), 200, { team: atlas })).status, 'closed');
  assert.equal((await close(atlas, c)).status, 'closed');
  await call(itemPath(a) + '/activity', 404, { team: atlas });
  console.log('PASS: The old image ran on the upgraded schema and preserved tenant boundaries.');

  await start(newImage);
  await checkIsolation(a, b);
  assert.deepEqual(await call(itemPath(a) + '/activity', 200, { team: atlas }), [event]);
  assert.deepEqual(await call(itemPath(c) + '/activity', 200, { team: atlas }), []);
  console.log('PASS: Re-upgrade preserved recorded history and left rollback-era history empty.');

  await baseline();
} finally {
  try {
    compose('down', '--volumes', '--remove-orphans');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const tag of [oldImage, newImage]) {
      try { run('docker', ['image', 'rm', tag], { stdio: 'ignore' }); } catch { /* Build may have failed. */ }
    }
  }
}
