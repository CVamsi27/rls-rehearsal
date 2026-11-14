import { readFile } from 'node:fs/promises';
import { ConfigError } from './errors.js';
import type {
  ActorConfig,
  CheckConfig,
  Config,
  Expectation,
  Param,
  ParamReference,
  ResolvedActor,
  ResourceConfig,
} from './types.js';

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const TABLE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;
const SETTING = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const EXPECTATION_KEYS = ['rows', 'atMostRows', 'atLeastRows', 'denied', 'succeeds', 'sqlstate'] as const;

export const DEFAULT_TIMEOUT_MS = 5000;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, path: string, errors: string[]): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${path} must be a non-empty string`);
    return undefined;
  }
  return value.trim();
}

function validIdentifier(value: unknown, path: string, errors: string[]): string | undefined {
  const text = requiredString(value, path, errors);
  if (text !== undefined && !IDENTIFIER.test(text)) {
    errors.push(`${path} must be a PostgreSQL identifier (letters, digits, underscore, dollar)`);
    return undefined;
  }
  return text;
}

function validEnvName(value: unknown, path: string, errors: string[]): string | undefined {
  const text = requiredString(value, path, errors);
  if (text !== undefined && !ENV_NAME.test(text)) {
    errors.push(`${path} must be an environment variable name such as RLS_REHEARSAL_DATABASE_URL`);
    return undefined;
  }
  return text;
}

function validateActor(name: string, value: unknown, errors: string[]): ActorConfig | undefined {
  const path = `actors.${name}`;
  if (!IDENTIFIER.test(name)) errors.push(`actor name "${name}" must be a PostgreSQL-safe identifier`);
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }

  const actor: ActorConfig = {};
  const hasTenant = value.tenant !== undefined;
  const hasTenantEnv = value.tenantEnv !== undefined;
  if (hasTenant === hasTenantEnv) {
    errors.push(`${path} needs exactly one of tenant or tenantEnv`);
  } else if (hasTenant) {
    actor.tenant = requiredString(value.tenant, `${path}.tenant`, errors);
  } else {
    actor.tenantEnv = validEnvName(value.tenantEnv, `${path}.tenantEnv`, errors);
  }

  if (value.role !== undefined) actor.role = validIdentifier(value.role, `${path}.role`, errors);
  if (value.connectionEnv !== undefined) {
    actor.connectionEnv = validEnvName(value.connectionEnv, `${path}.connectionEnv`, errors);
  }

  if (value.claims !== undefined) {
    if (!isPlainObject(value.claims)) {
      errors.push(`${path}.claims must be an object`);
    } else {
      actor.claims = value.claims;
    }
  }

  if (value.settings !== undefined) {
    if (!isPlainObject(value.settings)) {
      errors.push(`${path}.settings must be an object of strings`);
    } else {
      const settings: Record<string, string> = {};
      for (const [key, setting] of Object.entries(value.settings)) {
        if (!SETTING.test(key)) {
          errors.push(`${path}.settings.${key} is not a safe PostgreSQL setting name`);
          continue;
        }
        if (typeof setting !== 'string') {
          errors.push(`${path}.settings.${key} must be a string`);
          continue;
        }
        settings[key] = setting;
      }
      actor.settings = settings;
    }
  }

  return actor;
}

function validateResource(name: string, value: unknown, errors: string[]): ResourceConfig | undefined {
  const path = `resources.${name}`;
  if (!IDENTIFIER.test(name)) errors.push(`resource name "${name}" must be a PostgreSQL-safe identifier`);
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }

  const table = requiredString(value.table, `${path}.table`, errors);
  if (table !== undefined && !TABLE.test(table)) {
    errors.push(`${path}.table must be a table name such as items or tenantproof.items`);
  }
  const tenantColumn = validIdentifier(value.tenantColumn, `${path}.tenantColumn`, errors);

  let identifierColumns: string[] = ['id'];
  if (value.identifierColumns !== undefined) {
    if (!Array.isArray(value.identifierColumns) || value.identifierColumns.length === 0) {
      errors.push(`${path}.identifierColumns must be a non-empty array of column names`);
    } else {
      identifierColumns = [];
      for (const [index, column] of value.identifierColumns.entries()) {
        const validated = validIdentifier(column, `${path}.identifierColumns[${index}]`, errors);
        if (validated) identifierColumns.push(validated);
      }
      if (new Set(identifierColumns).size !== identifierColumns.length) {
        errors.push(`${path}.identifierColumns must not contain duplicates`);
      }
    }
  }

  let minRows = 0;
  if (value.minRows !== undefined) {
    if (!Number.isInteger(value.minRows) || (value.minRows as number) < 0) {
      errors.push(`${path}.minRows must be a non-negative integer`);
    } else {
      minRows = value.minRows as number;
    }
  }

  if (!table || !tenantColumn) return undefined;
  return { table, tenantColumn, identifierColumns, minRows };
}

function validateParam(value: unknown, path: string, errors: string[]): Param | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (!isPlainObject(value)) {
    errors.push(`${path} must be a scalar or a fromActor/fromResource reference`);
    return undefined;
  }
  const fromActor = validIdentifier(value.fromActor, `${path}.fromActor`, errors);
  const fromResource = validIdentifier(value.fromResource, `${path}.fromResource`, errors);
  let column: string | undefined;
  if (value.column !== undefined) column = validIdentifier(value.column, `${path}.column`, errors);
  let index = 0;
  if (value.index !== undefined) {
    if (!Number.isInteger(value.index) || (value.index as number) < 0) {
      errors.push(`${path}.index must be a non-negative integer`);
    } else {
      index = value.index as number;
    }
  }
  if (!fromActor || !fromResource) return undefined;
  const reference: ParamReference = { fromActor, fromResource, index };
  if (column) reference.column = column;
  return reference;
}

function validateExpectation(value: unknown, path: string, errors: string[]): Expectation | undefined {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object with one expectation`);
    return undefined;
  }
  const present = EXPECTATION_KEYS.filter((key) => value[key] !== undefined);
  if (present.length !== 1) {
    errors.push(`${path} must contain exactly one of ${EXPECTATION_KEYS.join(', ')}`);
    return undefined;
  }

  const key = present[0]!;
  const expectation: Expectation = {};
  if (key === 'denied' || key === 'succeeds') {
    if (value[key] !== true) {
      errors.push(`${path}.${key} must be true`);
      return undefined;
    }
    expectation[key] = true;
    return expectation;
  }
  if (key === 'sqlstate') {
    const state = requiredString(value.sqlstate, `${path}.sqlstate`, errors);
    if (state !== undefined && !SQLSTATE.test(state.toUpperCase())) {
      errors.push(`${path}.sqlstate must be a five-character SQLSTATE`);
      return undefined;
    }
    if (state) expectation.sqlstate = state.toUpperCase();
    return expectation;
  }

  const count = value[key];
  if (!Number.isInteger(count) || (count as number) < 0) {
    errors.push(`${path}.${key} must be a non-negative integer`);
    return undefined;
  }
  expectation[key] = count as number;
  return expectation;
}

function validateCheck(
  value: unknown,
  index: number,
  actors: Record<string, ActorConfig>,
  resources: Record<string, ResourceConfig>,
  errors: string[],
): CheckConfig | undefined {
  const path = `checks[${index}]`;
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  const name = requiredString(value.name, `${path}.name`, errors);
  const actor = requiredString(value.actor, `${path}.actor`, errors);
  if (actor !== undefined && !actors[actor]) errors.push(`${path}.actor "${actor}" is not declared in actors`);
  if (name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,80}$/.test(name)) {
    errors.push(`${path}.name must be 1-81 characters using letters, digits, spaces, dot, underscore or dash`);
  }

  let resource: string | undefined;
  if (value.resource !== undefined) {
    resource = requiredString(value.resource, `${path}.resource`, errors);
    if (resource !== undefined && !resources[resource]) {
      errors.push(`${path}.resource "${resource}" is not declared in resources`);
    }
  }

  const kind = value.kind === undefined ? 'read' : value.kind;
  if (kind !== 'read' && kind !== 'write') errors.push(`${path}.kind must be read or write`);
  const validKind: 'read' | 'write' = kind === 'write' ? 'write' : 'read';

  const sql = requiredString(value.sql, `${path}.sql`, errors);
  const params: Param[] = [];
  if (value.params !== undefined) {
    if (!Array.isArray(value.params)) {
      errors.push(`${path}.params must be an array`);
    } else {
      for (const [paramIndex, param] of value.params.entries()) {
        const validated = validateParam(param, `${path}.params[${paramIndex}]`, errors);
        if (validated !== undefined) params.push(validated);
      }
    }
  }

  const expect = validateExpectation(value.expect, `${path}.expect`, errors);
  if (!name || !actor || !sql || !expect) return undefined;

  const check: CheckConfig = { name, actor, kind: validKind, sql, params, expect };
  if (resource) check.resource = resource;
  if (typeof value.description === 'string' && value.description.trim()) {
    check.description = value.description.trim();
  }
  return check;
}

export function validateConfig(input: unknown): Config {
  const errors: string[] = [];
  if (!isPlainObject(input)) throw new ConfigError('Configuration must be a JSON object');

  if (input.version !== 1) errors.push('version must be 1');
  if (!isPlainObject(input.connection)) {
    errors.push('connection must be an object');
  }
  const connectionEnv = isPlainObject(input.connection)
    ? validEnvName(input.connection.env, 'connection.env', errors)
    : undefined;

  if (!isPlainObject(input.actors)) {
    errors.push('actors must be an object');
  }
  if (!isPlainObject(input.resources)) {
    errors.push('resources must be an object');
  }

  const actors: Record<string, ActorConfig> = {};
  if (isPlainObject(input.actors)) {
    const names = Object.keys(input.actors);
    if (names.length < 2) errors.push('actors must declare at least two tenants so the matrix can compare them');
    for (const name of names) {
      const actor = validateActor(name, input.actors[name], errors);
      if (actor) actors[name] = actor;
    }
  }

  const resources: Record<string, ResourceConfig> = {};
  if (isPlainObject(input.resources)) {
    const names = Object.keys(input.resources);
    if (names.length === 0) errors.push('resources must declare at least one table');
    for (const name of names) {
      const resource = validateResource(name, input.resources[name], errors);
      if (resource) resources[name] = resource;
    }
  }

  const checks: CheckConfig[] = [];
  if (input.checks !== undefined) {
    if (!Array.isArray(input.checks)) {
      errors.push('checks must be an array');
    } else {
      const names = new Set<string>();
      for (const [index, check] of input.checks.entries()) {
        const validated = validateCheck(check, index, actors, resources, errors);
        if (!validated) continue;
        if (names.has(validated.name)) errors.push(`checks[${index}].name "${validated.name}" is duplicated`);
        names.add(validated.name);
        for (const param of validated.params ?? []) {
          if (typeof param !== 'object' || param === null) continue;
          if (!actors[param.fromActor]) {
            errors.push(`checks[${index}] references undeclared actor "${param.fromActor}"`);
          }
          if (!resources[param.fromResource]) {
            errors.push(`checks[${index}] references undeclared resource "${param.fromResource}"`);
          }
        }
        checks.push(validated);
      }
    }
  }

  let timeout = DEFAULT_TIMEOUT_MS;
  let failOnEmpty = false;
  if (input.defaults !== undefined) {
    if (!isPlainObject(input.defaults)) {
      errors.push('defaults must be an object');
    } else {
      if (input.defaults.statementTimeoutMs !== undefined) {
        const value = input.defaults.statementTimeoutMs;
        if (!Number.isInteger(value) || (value as number) < 100 || (value as number) > 60000) {
          errors.push('defaults.statementTimeoutMs must be an integer between 100 and 60000');
        } else {
          timeout = value as number;
        }
      }
      if (input.defaults.failOnEmpty !== undefined) {
        if (typeof input.defaults.failOnEmpty !== 'boolean') {
          errors.push('defaults.failOnEmpty must be a boolean');
        } else {
          failOnEmpty = input.defaults.failOnEmpty;
        }
      }
    }
  }

  if (errors.length > 0 || !connectionEnv) {
    throw new ConfigError(errors.length > 0 ? errors : ['connection.env is required']);
  }

  const config: Config = {
    version: 1,
    connection: { env: connectionEnv },
    actors,
    resources,
    checks,
    defaults: { statementTimeoutMs: timeout, failOnEmpty },
  };
  if (typeof input.$schema === 'string') config.$schema = input.$schema;
  return config;
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read config file: ${path}`);
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Config file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateConfig(input);
}

export function resolveActors(config: Config, env: NodeJS.ProcessEnv): Map<string, ResolvedActor> {
  const actors = new Map<string, ResolvedActor>();
  const errors: string[] = [];
  for (const [name, actor] of Object.entries(config.actors)) {
    let tenant = actor.tenant;
    if (!tenant && actor.tenantEnv) {
      tenant = env[actor.tenantEnv];
      if (!tenant) errors.push(`actors.${name}.tenantEnv ${actor.tenantEnv} is not set`);
    }
    if (!tenant) {
      errors.push(`actors.${name} has no tenant value`);
      continue;
    }
    const resolved: ResolvedActor = { name, tenant };
    if (actor.role) resolved.role = actor.role;
    if (actor.connectionEnv) resolved.connectionEnv = actor.connectionEnv;
    if (actor.claims) resolved.claims = actor.claims;
    if (actor.settings) resolved.settings = actor.settings;
    actors.set(name, resolved);
  }
  if (errors.length > 0) throw new ConfigError(errors);
  return actors;
}

export function initConfigTemplate(): Config {
  const atlas = 'a0000000-0000-4000-8000-000000000001';
  const beacon = 'b0000000-0000-4000-8000-000000000002';
  return {
    $schema: 'https://raw.githubusercontent.com/CVamsi27/rls-rehearsal/main/cli/schema.json',
    version: 1,
    connection: { env: 'RLS_REHEARSAL_DATABASE_URL' },
    actors: {
      tenant_a: {
        tenant: atlas,
        claims: { sub: 'tenant-a', role: 'authenticated' },
        settings: { 'app.tenant_id': atlas },
      },
      tenant_b: {
        tenant: beacon,
        claims: { sub: 'tenant-b', role: 'authenticated' },
        settings: { 'app.tenant_id': beacon },
      },
    },
    resources: {
      items: {
        table: 'public.items',
        tenantColumn: 'tenant_id',
        identifierColumns: ['id'],
        minRows: 1,
      },
    },
    checks: [
      {
        name: 'tenant A cannot read a tenant B row by id',
        actor: 'tenant_a',
        resource: 'items',
        sql: 'SELECT id FROM public.items WHERE id = $1',
        params: [{ fromActor: 'tenant_b', fromResource: 'items', column: 'id' }],
        expect: { rows: 0 },
      },
    ],
    defaults: { statementTimeoutMs: DEFAULT_TIMEOUT_MS, failOnEmpty: true },
  };
}
