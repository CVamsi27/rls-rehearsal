const assert = require('node:assert/strict');
const { test } = require('node:test');

async function api() {
  return import('../dist/index.js');
}

test('the starter config validates and resolves both tenants', async () => {
  const { initConfigTemplate, validateConfig, resolveActors } = await api();
  const config = validateConfig(initConfigTemplate());
  assert.equal(config.version, 1);
  assert.deepEqual(Object.keys(config.actors), ['tenant_a', 'tenant_b']);
  assert.equal(config.resources.items.table, 'public.items');
  assert.equal(config.checks.length, 1);

  const actors = resolveActors(config, {});
  assert.equal(actors.get('tenant_a').tenant, 'a0000000-0000-4000-8000-000000000001');
  assert.deepEqual(actors.get('tenant_b').settings, {
    'app.tenant_id': 'b0000000-0000-4000-8000-000000000002',
  });
});

test('tenantEnv resolves at runtime and fails when unset', async () => {
  const { validateConfig, resolveActors } = await api();
  const config = validateConfig({
    version: 1,
    connection: { env: 'DATABASE_URL' },
    actors: {
      a: { tenantEnv: 'TENANT_A' },
      b: { tenant: 'b' },
    },
    resources: { items: { table: 'items', tenantColumn: 'tenant_id' } },
  });
  assert.throws(() => resolveActors(config, {}), /TENANT_A is not set/);
  const actors = resolveActors(config, { TENANT_A: 'a' });
  assert.equal(actors.get('a').tenant, 'a');
});

test('configuration errors are collected with paths', async () => {
  const { validateConfig, ConfigError } = await api();
  const base = {
    version: 1,
    connection: { env: 'DATABASE_URL' },
    actors: {
      a: { tenant: 'a' },
      b: { tenant: 'b' },
    },
    resources: { items: { table: 'items', tenantColumn: 'tenant_id' } },
  };

  assert.throws(
    () => validateConfig({ ...base, version: 2 }),
    (error) => error instanceof ConfigError && /version must be 1/.test(error.message),
  );

  assert.throws(
    () =>
      validateConfig({
        ...base,
        checks: [
          { name: 'one', actor: 'missing', sql: 'select 1', expect: { rows: 1 } },
          { name: 'two', actor: 'a', sql: 'select 1', expect: { rows: 1, succeeds: true } },
        ],
      }),
    (error) =>
      error instanceof ConfigError &&
      /checks\[0\]\.actor/.test(error.message) &&
      /exactly one of/.test(error.message),
  );

  assert.throws(
    () => validateConfig({ ...base, resources: { items: { table: 'items; drop table x', tenantColumn: 't' } } }),
    /resources\.items\.table/,
  );
});

test('one actor is rejected because a matrix needs a comparison', async () => {
  const { validateConfig } = await api();
  assert.throws(
    () =>
      validateConfig({
        version: 1,
        connection: { env: 'DATABASE_URL' },
        actors: { a: { tenant: 'a' } },
        resources: { items: { table: 'items', tenantColumn: 'tenant_id' } },
      }),
    /at least two tenants/,
  );
});

test('duplicate check names are rejected', async () => {
  const { validateConfig } = await api();
  assert.throws(
    () =>
      validateConfig({
        version: 1,
        connection: { env: 'DATABASE_URL' },
        actors: { a: { tenant: 'a' }, b: { tenant: 'b' } },
        resources: { items: { table: 'items', tenantColumn: 'tenant_id' } },
        checks: [
          { name: 'same', actor: 'a', sql: 'select 1', expect: { rows: 1 } },
          { name: 'same', actor: 'b', sql: 'select 1', expect: { rows: 1 } },
        ],
      }),
    /duplicated/,
  );
});
