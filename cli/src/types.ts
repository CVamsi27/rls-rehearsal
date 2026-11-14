export type ActorConfig = {
  /** Tenant value compared with the resource tenant column. */
  tenant?: string;
  /** Environment variable that supplies the tenant value. */
  tenantEnv?: string;
  /** Database role to enter with SET LOCAL ROLE for this actor. */
  role?: string;
  /** Environment variable with a dedicated connection string for this actor. */
  connectionEnv?: string;
  /** Claims exposed as request.jwt.claims and request.jwt.claim.*. */
  claims?: Record<string, unknown>;
  /** Custom PostgreSQL settings set for the transaction, e.g. app.tenant_id. */
  settings?: Record<string, string>;
};

export type ResourceConfig = {
  /** Qualified table name, e.g. tenantproof.items or public.items. */
  table: string;
  /** Column that holds the tenant key. */
  tenantColumn: string;
  /** Columns used in leak samples and parameter references. Defaults to ["id"]. */
  identifierColumns?: string[];
  /** Fail an actor/resource pair when the actor sees fewer than this many own rows. */
  minRows?: number;
};

export type ParamValue = string | number | boolean | null;

export type ParamReference = {
  fromActor: string;
  fromResource: string;
  column?: string;
  index?: number;
};

export type Param = ParamValue | ParamReference;

export type Expectation = {
  rows?: number;
  atMostRows?: number;
  atLeastRows?: number;
  denied?: true;
  succeeds?: true;
  sqlstate?: string;
};

export type CheckConfig = {
  name: string;
  actor: string;
  resource?: string;
  kind?: 'read' | 'write';
  description?: string;
  sql: string;
  params?: Param[];
  expect: Expectation;
};

export type Config = {
  $schema?: string;
  version: 1;
  connection: {
    env: string;
  };
  actors: Record<string, ActorConfig>;
  resources: Record<string, ResourceConfig>;
  checks?: CheckConfig[];
  defaults?: {
    statementTimeoutMs?: number;
    failOnEmpty?: boolean;
  };
};

export type ResolvedActor = {
  name: string;
  tenant: string;
  role?: string;
  connectionEnv?: string;
  claims?: Record<string, unknown>;
  settings?: Record<string, string>;
};

export type MatrixRow = {
  tenant: string;
  rows: number;
};

export type MatrixSample = Record<string, unknown>;

export type MatrixResult = {
  actor: string;
  resource: string;
  table: string;
  status: 'pass' | 'fail';
  visibleRows: number;
  foreignRows: number;
  ownRows: number;
  minRows: number;
  empty: boolean;
  leakedSample: MatrixSample[];
  durationMs: number;
  reason?: string;
};

export type CheckResult = {
  name: string;
  actor: string;
  kind: 'read' | 'write';
  status: 'pass' | 'fail';
  durationMs: number;
  rowCount: number | null;
  sqlstate?: string;
  reason?: string;
};

export type ControlResult = {
  actor: string;
  resource: string;
  status: 'leaked' | 'not-leaked' | 'skipped' | 'error';
  foreignRows: number;
  leakedRows: number;
  ownRowsVisible: number;
  ownRowsActual: number;
  coverageGap: number;
  durationMs: number;
  reason?: string;
};

export type PreflightNote = {
  level: 'warning' | 'error';
  code: string;
  message: string;
};

export type ReportTarget = {
  host: string;
  port: string;
  database: string;
  user: string;
  redacted: string;
};

export type Report = {
  tool: {
    name: 'rls-rehearsal';
    version: string;
  };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  config: string;
  target: ReportTarget;
  mode: {
    control: boolean;
    failOnEmpty: boolean;
    allowRemote: boolean;
    allowPrivileged: boolean;
  };
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    warnings: number;
    leaks: number;
    exitCode: number;
  };
  preflight: PreflightNote[];
  matrix: MatrixResult[];
  checks: CheckResult[];
  control: ControlResult[];
};
