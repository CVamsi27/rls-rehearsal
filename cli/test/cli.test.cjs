const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const main = join(__dirname, '..', 'dist', 'main.js');

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [main, ...args], {
      env: { ...process.env, NO_COLOR: '1', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('help and version exit zero', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /rls-rehearsal run/);
  assert.match(help.stdout, /Exit codes:/);

  const version = await run(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^rls-rehearsal 0\.3\.0/);
});

test('unknown options fail with a usage error', async () => {
  const result = await run(['run', '--nope']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option --nope/);
});

test('init writes a config and refuses to overwrite without --force', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rls-init-'));
  const config = join(dir, 'nested', 'rls.json');
  const first = await run(['init', '--config', config]);
  assert.equal(first.code, 0);
  const parsed = JSON.parse(await readFile(config, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.equal(Object.keys(parsed.actors).length, 2);

  const second = await run(['init', '--config', config]);
  assert.equal(second.code, 2);
  assert.match(second.stderr, /already exists/);

  const forced = await run(['init', '--config', config, '--force']);
  assert.equal(forced.code, 0);
});

test('a remote host is refused before connecting and the password is never printed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rls-remote-'));
  const config = join(dir, 'rls.json');
  await run(['init', '--config', config]);
  const result = await run([
    'run',
    '--config',
    config,
    '--database-url',
    'postgres://runtime:super-secret@db.example.com:5432/app',
  ]);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /Refusing to test db\.example\.com/);
  assert.doesNotMatch(result.stdout + result.stderr, /super-secret/);
});

test('an invalid config exits 2 with the field path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rls-invalid-'));
  const config = join(dir, 'rls.json');
  await run(['init', '--config', config]);
  const body = JSON.parse(await readFile(config, 'utf8'));
  body.resources.items.table = 'items; drop table x';
  await writeFile(config, JSON.stringify(body));
  const result = await run(['run', '--config', config]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /resources\.items\.table/);
});
