const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');
const { migrate } = require('../dist/migrate.js');
const [atlas, beacon] = require('../examples/workspaces.json');

function urlFor(name, role, password) {
  const root = process.env.TEST_ADMIN_URL;
  if (!root) throw new Error('Use npm run test:db to create disposable PostgreSQL');
  const url = new URL(root);
  if (url.hostname !== '127.0.0.1' || url.username !== 'postgres' || url.password !== 'local_test_admin') {
    throw new Error('Expected credentials for the disposable test PostgreSQL');
  }
  url.pathname = '/' + name;
  url.username = role;
  url.password = password;
  return url.toString();
}

async function fixture(t) {
  const name = 'tp_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: urlFor('postgres', 'postgres', 'local_test_admin') });
  try {
    await admin.query('CREATE DATABASE ' + name + ' TEMPLATE tenantproof_template');
  } finally {
    await admin.end();
  }
  const migrationUrl = urlFor(name, 'tenantproof_migrator', 'local_test_migration');
  const runtimeUrl = urlFor(name, 'tenantproof_runtime', 'local_test_runtime');
  const adminUrl = urlFor(name, 'postgres', 'local_test_admin');
  const owner = new Pool({ connectionString: migrationUrl });
  const runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
  t.after(async () => {
    await runtime.end();
    await owner.end();
  });
  await migrate(migrationUrl);
  return { migrationUrl, runtimeUrl, adminUrl, owner, runtime };
}

async function startApp(t, runtimeUrl) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    env: {
      ...process.env, DATABASE_URL: runtimeUrl, PORT: '0',
      LISTEN_HOST: '127.0.0.1', TENANTPROOF_DEMO: '1', TENANTPROOF_KEYS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
  });
  const deadline = Date.now() + 5000;
  for (;;) {
    const line = output.split('\n').find((value) => value.includes('"event":"listening"'));
    if (line) return { base: 'http://127.0.0.1:' + JSON.parse(line).port, output: () => output };
    if (child.exitCode !== null || Date.now() >= deadline) {
      throw new Error('App did not start: ' + output);
    }
    await delay(25);
  }
}

async function request(base, path, { key, method = 'GET', body, headers } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(key ? { authorization: 'Bearer ' + key } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

module.exports = { atlas, beacon, fixture, startApp, request };
