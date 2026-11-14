# rls-rehearsal

`rls-rehearsal` checks PostgreSQL row level security (RLS) the way an attacker would: it opens a transaction for each tenant, drops into that tenant's role, claims and settings, and runs an unfiltered read. If one tenant can see another tenant's rows, the command fails.

It is the reusable CLI extracted from [RLS Rehearsal](https://github.com/CVamsi27/rls-rehearsal), a small NestJS and PostgreSQL reference implementation. The demo is the executable example; this package lets you point the same idea at your own schema.

## What it proves

- **Matrix:** every actor reads every configured table without an application `WHERE` clause. Rows whose tenant key differs from the actor's tenant are leaks.
- **Explicit checks:** assert a foreign ID returns zero rows, a forged insert is denied by RLS (SQLSTATE `42501`), an update affects zero rows, or an operation succeeds.
- **Control mode:** a privileged connection disables RLS in a transaction and reruns the same read. If the read still hides foreign rows, the assertion cannot detect a broken policy.
- **Rollback:** every write check runs in a transaction that is always rolled back. The command does not commit fixture changes.

A passing run is evidence for the configured roles, tables, claims, settings and checks. It is not proof that every policy is correct, and it does not protect against a `BYPASSRLS` role or replace application authorization.

## Quickstart

Node.js 24.22.2 or newer is required.

Until the npm release is published, run the package from a checkout:

```sh
npm ci --ignore-scripts
npm run build:cli
node cli/dist/main.js init
```

Edit `rls-rehearsal.config.json`, then:

```sh
export RLS_REHEARSAL_DATABASE_URL='postgres://app_runtime:...@127.0.0.1:5432/app'
node cli/dist/main.js doctor
node cli/dist/main.js run --config rls-rehearsal.config.json
```

After `rls-rehearsal@0.3.0` is published, the same commands are available through `npx rls-rehearsal init`, `npx rls-rehearsal doctor` and `npx rls-rehearsal run`.

The config needs one row per tenant to make the matrix meaningful. Set `minRows` on a resource to fail when an actor sees too few of its own rows.

## Configuration

```json
{
  "version": 1,
  "connection": { "env": "RLS_REHEARSAL_DATABASE_URL" },
  "actors": {
    "acme": {
      "tenant": "a0000000-0000-4000-8000-000000000001",
      "settings": { "app.tenant_id": "a0000000-0000-4000-8000-000000000001" },
      "claims": { "sub": "user-acme", "role": "authenticated" }
    },
    "globex": {
      "tenant": "b0000000-0000-4000-8000-000000000002",
      "settings": { "app.tenant_id": "b0000000-0000-4000-8000-000000000002" },
      "claims": { "sub": "user-globex", "role": "authenticated" }
    }
  },
  "resources": {
    "items": {
      "table": "public.items",
      "tenantColumn": "tenant_id",
      "identifierColumns": ["id"],
      "minRows": 1
    }
  },
  "checks": [
    {
      "name": "acme cannot read a globex row by id",
      "actor": "acme",
      "resource": "items",
      "sql": "SELECT id FROM public.items WHERE id = $1",
      "params": [
        { "fromActor": "globex", "fromResource": "items", "column": "id" }
      ],
      "expect": { "rows": 0 }
    }
  ]
}
```

### Actors

| Field | Meaning |
| --- | --- |
| `tenant` | The expected tenant value, compared with `tenantColumn`. |
| `tenantEnv` | Read the tenant value from an environment variable instead of `tenant`. |
| `role` | Enter this role with `SET LOCAL ROLE` for the actor's transaction. |
| `connectionEnv` | Use a dedicated connection string from this environment variable. |
| `claims` | Exposed as `request.jwt.claims` JSON and `request.jwt.claim.<key>`. |
| `settings` | Custom PostgreSQL settings set with `set_config(..., true)`. |

Use a restricted login role that is a member of every actor role, like PostgREST's `authenticator`. The session starts as that login role and switches to the actor role inside the transaction. If you do not set `role`, the connection's own role is the tested role.

### Resources

| Field | Meaning |
| --- | --- |
| `table` | Table name, optionally schema-qualified. Defaults to the `public` schema. |
| `tenantColumn` | Column compared with the actor's tenant. |
| `identifierColumns` | Columns included in leak samples and parameter references. Defaults to `["id"]`. |
| `minRows` | Fail when the actor sees fewer than this many own rows. Defaults to `0`. |

### Checks

Each check runs in its own transaction. `params` accepts scalars or a reference to another actor's visible row:

```json
{ "fromActor": "globex", "fromResource": "items", "column": "id", "index": 0 }
```

The reference is resolved by running a `SELECT` as that actor, so the CLI only uses IDs the actor can legitimately see. Seed both tenants before running.

`expect` accepts exactly one of:

| Expectation | Passes when |
| --- | --- |
| `{ "rows": 0 }` | The statement returns or affects exactly zero rows. |
| `{ "atMostRows": 5 }` | The row count is at most five. |
| `{ "atLeastRows": 1 }` | The row count is at least one. |
| `{ "denied": true }` | PostgreSQL raises `42501` with a row-level security message. |
| `{ "succeeds": true }` | The statement does not raise an error. |
| `{ "sqlstate": "42501" }` | PostgreSQL raises the exact SQLSTATE. |

`denied` deliberately distinguishes an RLS denial from a missing grant. If a write is rejected by a privilege check instead of a policy, the check fails and tells you to grant the verb so the policy is what rejects it.

Mark write checks with `"kind": "write"`. The rollback is unconditional; the label is for reports and reviewers.

## Commands

### `run`

```sh
rls-rehearsal run --config rls-rehearsal.config.json --format json,md,junit --out .rls-rehearsal
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--config` | `rls-rehearsal.config.json` | Configuration file. |
| `--database-url` | — | Override the connection env named in the config. |
| `--control` | off | Run the control pass. Requires `--admin-url` or `RLS_REHEARSAL_ADMIN_URL`. |
| `--admin-url` | `RLS_REHEARSAL_ADMIN_URL` | Privileged connection for control mode. |
| `--format` | `json,md` | Comma-separated `json`, `md`, `junit`. |
| `--out` | `.rls-rehearsal` | Report directory. |
| `--fail-on-empty` | config | Fail when an actor sees no rows across every resource. |
| `--allow-remote` | off | Permit a non-loopback host. |
| `--allow-privileged` | off | Permit a superuser or `BYPASSRLS` tested role. |

### `doctor`

Validates the connection, role membership, table existence, RLS flags, policies and `SELECT` grants. It exits `1` when it finds an error.

```sh
rls-rehearsal doctor --config rls-rehearsal.config.json
```

### `init`

Writes a starter config. It refuses to overwrite an existing file unless `--force` is passed.

## Reports

Every run writes the requested formats:

- `report.json`: complete machine-readable result.
- `report.md`: reviewable summary with matrix, checks, control and limitations.
- `report.xml`: JUnit XML for CI test reporters.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | All checks passed. |
| `1` | At least one matrix, check or control assertion failed. |
| `2` | Usage, configuration, connection or setup error. |
| `3` | Unsafe target refused before connecting. |

## GitHub Actions

This example becomes usable after the `v0.3.0` tag exists and `rls-rehearsal@0.3.0` is published to npm. Until then, run the checkout path above.

```yaml
name: Tenant isolation
on: [pull_request]

jobs:
  rls:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v6
      - uses: CVamsi27/rls-rehearsal@v0.3.0
        with:
          database-url: ${{ secrets.RLS_REHEARSAL_DATABASE_URL }}
          config: rls-rehearsal.config.json
          control: true
          admin-database-url: ${{ secrets.RLS_REHEARSAL_ADMIN_URL }}
          formats: json,md,junit
```

The action installs the package version from the `version` input (default `latest`), runs the checks with `--allow-remote`, and uploads the report directory as an artifact. Pin the action to a tag or commit, and use a disposable database or a transaction-safe test fixture. The action does not seed data.

## Supabase

Supabase exposes the PostgREST role model: the `authenticator` login role can `SET ROLE authenticated`, and policies read `auth.uid()` or `request.jwt.claims`. Point the CLI at a direct or session-mode Postgres connection, not the transaction pooler, because `SET LOCAL` and custom settings are transaction-scoped:

```json
{
  "connection": { "env": "SUPABASE_DB_URL" },
  "actors": {
    "org_a": {
      "tenant": "00000000-0000-4000-8000-000000000001",
      "role": "authenticated",
      "claims": {
        "sub": "00000000-0000-4000-8000-000000000011",
        "role": "authenticated",
        "org_id": "00000000-0000-4000-8000-000000000001"
      }
    },
    "org_b": {
      "tenant": "00000000-0000-4000-8000-000000000002",
      "role": "authenticated",
      "claims": {
        "sub": "00000000-0000-4000-8000-000000000012",
        "role": "authenticated",
        "org_id": "00000000-0000-4000-8000-000000000002"
      }
    }
  },
  "resources": {
    "projects": {
      "table": "public.projects",
      "tenantColumn": "org_id",
      "identifierColumns": ["id"],
      "minRows": 1
    }
  }
}
```

Use a connection role that is a member of `authenticated` (usually `authenticator` or `postgres`). `postgres` is privileged; pass `--allow-privileged` only if you understand that the tested session is still switched to `authenticated` and verified with `current_user`. Never put a service-role key in the config; the CLI needs a Postgres connection string, not an API key.

## Safety

- The tested connection must be loopback unless `--allow-remote` is passed.
- A tested session that is a superuser or has `BYPASSRLS` is refused unless `--allow-privileged` is passed. The CLI verifies `SET LOCAL ROLE` took effect.
- Passwords are redacted from the console, reports and errors.
- Every transaction is rolled back. Control mode uses `SET LOCAL row_security = off` and never alters a table.
- Control mode requires a superuser or `BYPASSRLS` admin connection. Use a disposable database; do not point control mode at production.
- Reports contain schema names, tenant values and sampled identifiers. Treat them as internal artifacts.

## Development

```sh
npm ci --ignore-scripts
npm run build:cli
npm test -w rls-rehearsal
```

The integration suite is part of the repository's disposable PostgreSQL run:

```sh
npm run test:cli:db
```

See the root [README](../README.md), [design notes](../docs/design.md) and [release handoff](../docs/release.md) for the demo, architecture and publication checklist.
