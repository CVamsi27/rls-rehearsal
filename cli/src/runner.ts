import type { Pool, PoolClient } from 'pg';
import { ConfigError, PreflightError, UnsafeTargetError } from './errors.js';
import {
  assertSessionSafe,
  createPool,
  isPrivileged,
  quoteIdent,
  roleFacts,
  withActorSession,
} from './db.js';
import { inspectResource, type ResourceInspection } from './preflight.js';
import type {
  CheckConfig,
  CheckResult,
  Config,
  ControlResult,
  MatrixResult,
  Param,
  ParamReference,
  ParamValue,
  PreflightNote,
  Report,
  ReportTarget,
  ResolvedActor,
} from './types.js';
import { assertRemoteAllowed } from './url.js';
import { summarize } from './report.js';

export type RunOptions = {
  config: Config;
  configPath: string;
  actors: Map<string, ResolvedActor>;
  env: NodeJS.ProcessEnv;
  databaseUrl?: string;
  adminUrl?: string;
  control: boolean;
  allowRemote: boolean;
  allowPrivileged: boolean;
  failOnEmpty?: boolean;
  timeoutMs: number;
  version: string;
};

type ActorConnection = {
  actor: ResolvedActor;
  url: string;
  target: ReportTarget;
};

export type DoctorResult = {
  checks: { level: 'ok' | 'warning' | 'error'; message: string }[];
  errors: number;
  warnings: number;
  target: ReportTarget;
};

function resolveUrl(
  config: Config,
  actor: ResolvedActor,
  env: NodeJS.ProcessEnv,
  override?: string,
): string {
  const envName = actor.connectionEnv ?? config.connection.env;
  const value = override && !actor.connectionEnv ? override : env[envName];
  if (!value) {
    throw new ConfigError(
      `Environment variable ${envName} is not set${actor.connectionEnv ? ` for actor ${actor.name}` : ''}`,
    );
  }
  return value;
}

function connectionsFor(options: RunOptions): ActorConnection[] {
  const connections: ActorConnection[] = [];
  for (const actor of options.actors.values()) {
    const url = resolveUrl(options.config, actor, options.env, options.databaseUrl);
    const target = assertRemoteAllowed(url, options.allowRemote);
    connections.push({ actor, url, target });
  }
  return connections;
}

function uniqueTargets(connections: ActorConnection[]): ReportTarget[] {
  const seen = new Map<string, ReportTarget>();
  for (const connection of connections) seen.set(connection.url, connection.target);
  return [...seen.values()];
}

function matrixQuery(resource: Config['resources'][string]): string {
  const tenant = quoteIdent(resource.tenantColumn);
  return `SELECT ${tenant}::text AS tenant, count(*)::int AS rows FROM ${resource.table} GROUP BY ${tenant} ORDER BY 1`;
}

function leakSampleQuery(resource: Config['resources'][string]): string {
  const tenant = quoteIdent(resource.tenantColumn);
  const identifiers = (resource.identifierColumns ?? ['id'])
    .map((column, index) => `${quoteIdent(column)}::text AS "__rls_id_${index}"`)
    .join(', ');
  return `SELECT ${identifiers} FROM ${resource.table} WHERE ${tenant}::text IS DISTINCT FROM $1 LIMIT 5`;
}

async function matrixFor(
  pool: Pool,
  actor: ResolvedActor,
  resourceName: string,
  resource: Config['resources'][string],
  options: { timeoutMs: number },
): Promise<MatrixResult> {
  const started = Date.now();
  const minRows = resource.minRows ?? 0;
  try {
    const outcome = await withActorSession(pool, actor, options.timeoutMs, async (client) => {
      const grouped = await client.query<{ tenant: string | null; rows: number }>(matrixQuery(resource));
      const visibleRows = grouped.rows.reduce((sum, row) => sum + Number(row.rows), 0);
      const ownRows = grouped.rows
        .filter((row) => row.tenant === actor.tenant)
        .reduce((sum, row) => sum + Number(row.rows), 0);
      const foreignRows = visibleRows - ownRows;
      let leakedSample: Record<string, unknown>[] = [];
      if (foreignRows > 0) {
        const sample = await client.query<Record<string, unknown>>(leakSampleQuery(resource), [actor.tenant]);
        leakedSample = sample.rows;
      }
      return { visibleRows, ownRows, foreignRows, leakedSample };
    });

    const reasons: string[] = [];
    if (outcome.foreignRows > 0) {
      reasons.push(
        `Tenant ${actor.tenant} can see ${outcome.foreignRows} row(s) from other tenants`,
      );
    }
    if (outcome.ownRows < minRows) {
      reasons.push(`Expected at least ${minRows} own row(s), found ${outcome.ownRows}`);
    }

    return {
      actor: actor.name,
      resource: resourceName,
      table: resource.table,
      status: reasons.length > 0 ? 'fail' : 'pass',
      visibleRows: outcome.visibleRows,
      ownRows: outcome.ownRows,
      foreignRows: outcome.foreignRows,
      minRows,
      empty: outcome.visibleRows === 0,
      leakedSample: outcome.leakedSample,
      durationMs: Date.now() - started,
      ...(reasons.length > 0 ? { reason: reasons.join('. ') } : {}),
    };
  } catch (error) {
    return {
      actor: actor.name,
      resource: resourceName,
      table: resource.table,
      status: 'fail',
      visibleRows: 0,
      foreignRows: 0,
      ownRows: 0,
      minRows,
      empty: true,
      leakedSample: [],
      durationMs: Date.now() - started,
      reason: `Matrix query failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function paramReference(value: Param): value is ParamReference {
  return typeof value === 'object' && value !== null;
}

async function resolveParam(
  param: ParamReference,
  options: RunOptions & { pools: Map<string, Pool>; connections: Map<string, ActorConnection> },
  cache: Map<string, ParamValue>,
): Promise<ParamValue> {
  const key = JSON.stringify(param);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const actor = options.actors.get(param.fromActor);
  const resource = options.config.resources[param.fromResource];
  if (!actor) throw new Error(`Parameter reference uses unknown actor ${param.fromActor}`);
  if (!resource) throw new Error(`Parameter reference uses unknown resource ${param.fromResource}`);

  const connection = options.connections.get(actor.name);
  if (!connection) throw new Error(`No connection for actor ${actor.name}`);
  const pool = options.pools.get(connection.url);
  if (!pool) throw new Error(`No pool for actor ${actor.name}`);

  const column = param.column ?? resource.identifierColumns?.[0] ?? 'id';
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(column)) throw new Error(`Unsafe parameter column ${column}`);
  const index = param.index ?? 0;
  if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid parameter index ${index}`);

  const value = await withActorSession(pool, actor, options.timeoutMs, async (client) => {
    const result = await client.query<{ value: string | null }>(
      `SELECT ${quoteIdent(column)}::text AS value FROM ${resource.table} LIMIT 1 OFFSET ${index}`,
    );
    if (result.rows.length === 0) {
      throw new Error(
        `No row at index ${index} for ${param.fromActor}/${param.fromResource}.${column}; seed the fixture first`,
      );
    }
    return result.rows[0]!.value;
  });
  cache.set(key, value);
  return value;
}

async function resolveParams(
  check: CheckConfig,
  options: RunOptions & { pools: Map<string, Pool>; connections: Map<string, ActorConnection> },
  cache: Map<string, ParamValue>,
): Promise<ParamValue[]> {
  const values: ParamValue[] = [];
  for (const param of check.params ?? []) {
    values.push(paramReference(param) ? await resolveParam(param, options, cache) : param);
  }
  return values;
}

function evaluateCheck(check: CheckConfig, outcome: { rowCount: number | null; sqlstate?: string; message?: string }): {
  passed: boolean;
  reason?: string;
} {
  const expect = check.expect;
  if (expect.denied) {
    if (!outcome.sqlstate) {
      return { passed: false, reason: 'Expected the write to be denied, but it succeeded' };
    }
    if (outcome.sqlstate !== '42501') {
      return {
        passed: false,
        reason: `Expected an RLS denial (42501), got SQLSTATE ${outcome.sqlstate}: ${outcome.message ?? ''}`,
      };
    }
    if (!/row-level security/i.test(outcome.message ?? '')) {
      return {
        passed: false,
        reason:
          'Expected an RLS denial, got a privilege denial. Grant the required verb so the policy is what rejects the operation.',
      };
    }
    return { passed: true };
  }

  if (expect.succeeds) {
    if (outcome.sqlstate) {
      return {
        passed: false,
        reason: `Expected success, got SQLSTATE ${outcome.sqlstate}: ${outcome.message ?? ''}`,
      };
    }
    return { passed: true };
  }

  if (expect.sqlstate) {
    if (!outcome.sqlstate) return { passed: false, reason: `Expected SQLSTATE ${expect.sqlstate}, but the query succeeded` };
    if (outcome.sqlstate !== expect.sqlstate) {
      return {
        passed: false,
        reason: `Expected SQLSTATE ${expect.sqlstate}, got ${outcome.sqlstate}: ${outcome.message ?? ''}`,
      };
    }
    return { passed: true };
  }

  if (outcome.sqlstate) {
    return {
      passed: false,
      reason: `Query failed with SQLSTATE ${outcome.sqlstate}: ${outcome.message ?? ''}`,
    };
  }

  const rows = outcome.rowCount ?? 0;
  if (expect.rows !== undefined && rows !== expect.rows) {
    return { passed: false, reason: `Expected ${expect.rows} row(s), got ${rows}` };
  }
  if (expect.atMostRows !== undefined && rows > expect.atMostRows) {
    return { passed: false, reason: `Expected at most ${expect.atMostRows} row(s), got ${rows}` };
  }
  if (expect.atLeastRows !== undefined && rows < expect.atLeastRows) {
    return { passed: false, reason: `Expected at least ${expect.atLeastRows} row(s), got ${rows}` };
  }
  return { passed: true };
}

async function runCheck(
  check: CheckConfig,
  options: RunOptions & { pools: Map<string, Pool>; connections: Map<string, ActorConnection> },
  cache: Map<string, ParamValue>,
): Promise<CheckResult> {
  const started = Date.now();
  const actor = options.actors.get(check.actor);
  const connection = options.connections.get(check.actor);
  const pool = connection ? options.pools.get(connection.url) : undefined;
  if (!actor || !pool) {
    return {
      name: check.name,
      actor: check.actor,
      kind: check.kind ?? 'read',
      status: 'fail',
      durationMs: Date.now() - started,
      rowCount: null,
      reason: `Actor ${check.actor} has no connection`,
    };
  }

  try {
    const params = await resolveParams(check, options, cache);
    const outcome = await withActorSession(pool, actor, options.timeoutMs, async (client) => {
      try {
        const result = await client.query(check.sql, params);
        return { rowCount: result.rowCount, sqlstate: undefined, message: undefined };
      } catch (error) {
        const pgError = error as Error & { code?: string };
        return { rowCount: null, sqlstate: pgError.code ?? 'XXXXX', message: pgError.message };
      }
    });
    const evaluation = evaluateCheck(check, outcome);
    return {
      name: check.name,
      actor: check.actor,
      kind: check.kind ?? 'read',
      status: evaluation.passed ? 'pass' : 'fail',
      durationMs: Date.now() - started,
      rowCount: outcome.rowCount,
      ...(outcome.sqlstate ? { sqlstate: outcome.sqlstate } : {}),
      ...(evaluation.reason ? { reason: evaluation.reason } : {}),
    };
  } catch (error) {
    return {
      name: check.name,
      actor: check.actor,
      kind: check.kind ?? 'read',
      status: 'fail',
      durationMs: Date.now() - started,
      rowCount: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function controlFor(
  pool: Pool,
  matrix: MatrixResult,
  tenant: string,
  resource: Config['resources'][string],
  timeoutMs: number,
): Promise<ControlResult> {
  const started = Date.now();
  const client: PoolClient = await pool.connect();
  let broken = false;
  const base = {
    actor: matrix.actor,
    resource: matrix.resource,
    foreignRows: 0,
    leakedRows: 0,
    ownRowsVisible: matrix.ownRows,
    ownRowsActual: 0,
    coverageGap: 0,
  };
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${Math.max(100, Math.floor(timeoutMs))}`);
    await client.query('SET LOCAL row_security = off');
    const privilege = await isPrivileged(client);
    if (!privilege.privileged) {
      return {
        ...base,
        status: 'error',
        durationMs: Date.now() - started,
        reason:
          `Control mode needs a superuser or BYPASSRLS connection; ${privilege.role} is neither. ` +
          'Use a disposable admin connection, or skip --control.',
      };
    }

    const grouped = await client.query<{ tenant: string | null; rows: number }>(matrixQuery(resource));
    const totalRows = grouped.rows.reduce((sum, row) => sum + Number(row.rows), 0);
    const ownRowsActual = grouped.rows
      .filter((row) => row.tenant === tenant)
      .reduce((sum, row) => sum + Number(row.rows), 0);
    const foreignRows = totalRows - ownRowsActual;
    if (foreignRows === 0) {
      return {
        ...base,
        status: 'skipped',
        ownRowsActual,
        durationMs: Date.now() - started,
        reason: 'No foreign rows exist for this actor, so the control has nothing to leak',
      };
    }

    const sample = await client.query<Record<string, unknown>>(leakSampleQuery(resource), [tenant]);
    const leakedRows = sample.rowCount ?? sample.rows.length;
    const coverageGap = Math.max(0, ownRowsActual - matrix.ownRows);
    return {
      ...base,
      status: leakedRows > 0 ? 'leaked' : 'not-leaked',
      foreignRows,
      leakedRows,
      ownRowsActual,
      coverageGap,
      durationMs: Date.now() - started,
      ...(leakedRows === 0
        ? {
            reason:
              'RLS still filtered rows with row_security=off; the control cannot prove the assertion can fail',
          }
        : {}),
    };
  } catch (error) {
    broken = true;
    return {
      ...base,
      status: 'error',
      durationMs: Date.now() - started,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    client.release(broken);
  }
}

export async function runIsolation(options: RunOptions): Promise<Report> {
  const started = Date.now();
  const connections = connectionsFor(options);
  if (connections.length === 0) throw new ConfigError('No actors configured');

  const targets = uniqueTargets(connections);
  if (targets.length > 1) {
    // Different actor connection strings are valid; the report shows the first as the primary target.
  }
  const primaryTarget = targets[0]!;
  if (options.control) {
    const adminUrl = options.adminUrl ?? options.env.RLS_REHEARSAL_ADMIN_URL;
    if (!adminUrl) {
      throw new ConfigError('--control needs --admin-url or RLS_REHEARSAL_ADMIN_URL');
    }
    assertRemoteAllowed(adminUrl, options.allowRemote);
  }

  const pools = new Map<string, Pool>();
  const connectionByActor = new Map<string, ActorConnection>();
  for (const connection of connections) {
    connectionByActor.set(connection.actor.name, connection);
    if (!pools.has(connection.url)) {
      pools.set(connection.url, createPool(connection.url, options.timeoutMs));
    }
  }

  const preflight: PreflightNote[] = [];
  try {
    for (const connection of connections) {
      const pool = pools.get(connection.url)!;
      let inspections: ResourceInspection[] = [];
      try {
        inspections = await withActorSession(pool, connection.actor, options.timeoutMs, async (client) => {
          const warnings = await assertSessionSafe(client, connection.actor.name, options.allowPrivileged);
          for (const warning of warnings) {
            preflight.push({ level: 'warning', code: 'privileged-session', message: warning });
          }
          const results: ResourceInspection[] = [];
          for (const [name, resource] of Object.entries(options.config.resources)) {
            results.push(await inspectResource(client, name, resource, { doctor: false }));
          }
          return results;
        });
      } catch (error) {
        if (error instanceof UnsafeTargetError) throw error;
        throw new PreflightError(
          `Cannot open a session for actor "${connection.actor.name}": ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      for (const inspection of inspections) {
        for (const note of inspection.notes) {
          preflight.push({
            ...note,
            message: `[${connection.actor.name}/${inspection.resource}] ${note.message}`,
          });
        }
      }
      const errors = preflight.filter((note) => note.level === 'error');
      if (errors.length > 0) {
        throw new PreflightError(errors.map((note) => note.message).join('\n'));
      }
    }

    const matrix: MatrixResult[] = [];
    for (const connection of connections) {
      const pool = pools.get(connection.url)!;
      for (const [name, resource] of Object.entries(options.config.resources)) {
        matrix.push(
          await matrixFor(pool, connection.actor, name, resource, {
            timeoutMs: options.timeoutMs,
          }),
        );
      }
    }

    const failOnEmpty = options.failOnEmpty ?? options.config.defaults?.failOnEmpty ?? false;
    if (failOnEmpty) {
      for (const connection of connections) {
        const rows = matrix.filter((row) => row.actor === connection.actor.name);
        const visible = rows.reduce((sum, row) => sum + row.visibleRows, 0);
        if (visible === 0 && rows.length > 0) {
          for (const row of rows) {
            row.status = 'fail';
            row.reason = [
              row.reason,
              'Actor saw no rows in any configured resource; seed the fixture before running',
            ]
              .filter(Boolean)
              .join('. ');
          }
        }
      }
    }

    const checkContext = {
      ...options,
      pools,
      connections: connectionByActor,
    };
    const paramCache = new Map<string, ParamValue>();
    const checks: CheckResult[] = [];
    for (const check of options.config.checks ?? []) {
      checks.push(await runCheck(check, checkContext, paramCache));
    }

    const control: ControlResult[] = [];
    if (options.control) {
      const adminUrl = options.adminUrl ?? options.env.RLS_REHEARSAL_ADMIN_URL;
      if (!adminUrl) throw new ConfigError('--control needs --admin-url or RLS_REHEARSAL_ADMIN_URL');
      const adminPool = createPool(adminUrl, options.timeoutMs);
      try {
        for (const row of matrix) {
          const resource = options.config.resources[row.resource];
          if (!resource) continue;
          control.push(
            await controlFor(adminPool, row, actorTenant(options, row.actor), resource, options.timeoutMs),
          );
        }
      } finally {
        await adminPool.end();
      }
    }

    const report = summarize(
      {
        tool: { name: 'rls-rehearsal', version: options.version },
        config: options.configPath,
        target: primaryTarget,
        mode: {
          control: options.control,
          failOnEmpty: options.failOnEmpty ?? options.config.defaults?.failOnEmpty ?? false,
          allowRemote: options.allowRemote,
          allowPrivileged: options.allowPrivileged,
        },
        preflight,
        matrix,
        checks,
        control,
      },
      started,
    );
    return report;
  } finally {
    await Promise.all([...pools.values()].map(async (pool) => pool.end()));
  }
}

function actorTenant(options: RunOptions, name: string): string {
  const actor = options.actors.get(name);
  if (!actor) throw new Error(`Unknown actor ${name}`);
  return actor.tenant;
}

export async function doctor(options: RunOptions): Promise<DoctorResult> {
  const checks: DoctorResult['checks'] = [];
  const connections = connectionsFor(options);
  const first = connections[0];
  if (!first) throw new ConfigError('No actors configured');
  const primaryTarget = first.target;
  const pools = new Map<string, Pool>();
  for (const connection of connections) {
    if (!pools.has(connection.url)) pools.set(connection.url, createPool(connection.url, options.timeoutMs));
  }

  try {
    for (const connection of connections) {
      const pool = pools.get(connection.url)!;
      if (connection.actor.role) {
        const membership = await pool.query<{ member: boolean }>(
          'SELECT pg_has_role(current_user, $1, \'MEMBER\') AS member',
          [connection.actor.role],
        );
        if (membership.rows[0]?.member !== true) {
          checks.push({
            level: 'error',
            message: `Actor ${connection.actor.name}: current role cannot SET ROLE ${connection.actor.role}`,
          });
        }
      }

      let inspections: ResourceInspection[] = [];
      let facts: Awaited<ReturnType<typeof roleFacts>>;
      try {
        const session = await withActorSession(pool, connection.actor, options.timeoutMs, async (client) => {
          const currentFacts = await roleFacts(client);
          const results: ResourceInspection[] = [];
          for (const [name, resource] of Object.entries(options.config.resources)) {
            results.push(await inspectResource(client, name, resource, { doctor: true }));
          }
          return { facts: currentFacts, results };
        });
        inspections = session.results;
        facts = session.facts;
      } catch (error) {
        checks.push({
          level: 'error',
          message: `Actor ${connection.actor.name}: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      const privileged = facts.rolsuper || facts.rolbypassrls;
      if (privileged) {
        checks.push({
          level: options.allowPrivileged ? 'warning' : 'error',
          message:
            `Actor ${connection.actor.name} runs as ${facts.current_user} ` +
            `(${facts.rolsuper ? 'superuser' : 'BYPASSRLS'}); isolation checks may be bypassed`,
        });
      } else {
        checks.push({
          level: 'ok',
          message: `Actor ${connection.actor.name} runs as ${facts.current_user} without superuser or BYPASSRLS`,
        });
      }
      for (const inspection of inspections) {
        for (const note of inspection.notes) {
          checks.push({
            level: note.level === 'warning' ? 'warning' : 'error',
            message: `[${connection.actor.name}/${inspection.resource}] ${note.message}`,
          });
        }
        if (inspection.exists && inspection.rlsEnabled && inspection.canSelect && inspection.notes.length === 0) {
          checks.push({
            level: 'ok',
            message:
              `[${connection.actor.name}/${inspection.resource}] ${inspection.table} ` +
              `RLS ${inspection.rlsForced ? 'enabled and forced' : 'enabled'}, ` +
              `${inspection.policyCount} policy/policies, owner ${inspection.owner}`,
          });
        }
      }
    }
  } finally {
    await Promise.all([...pools.values()].map(async (pool) => pool.end()));
  }

  return {
    checks,
    errors: checks.filter((check) => check.level === 'error').length,
    warnings: checks.filter((check) => check.level === 'warning').length,
    target: primaryTarget,
  };
}

export function resolveAdminUrl(options: RunOptions): string | undefined {
  return options.adminUrl ?? options.env.RLS_REHEARSAL_ADMIN_URL;
}

export type { MatrixResult };
