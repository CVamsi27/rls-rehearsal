# Changelog

## 0.3.0

- Add the publishable `rls-rehearsal` CLI: config-driven actors, tenant matrix, explicit read/write checks, JWT claims, PostgreSQL settings and unconditional rollback.
- Add control mode, which disables RLS in a privileged transaction and fails when the same assertion cannot detect a leak.
- Add JSON, Markdown and JUnit reports, `init`, `doctor`, safety guards for remote and privileged targets, and a composite GitHub Action.
- Add CLI unit and disposable-PostgreSQL integration tests, a Supabase recipe and a package smoke check.

## 0.2.0

- Same-origin work-item ledger with workspace switching, keyboard navigation, and closure history.
- Atomic closure recording, one event per item, and a composite tenant foreign key.
- Real browser and concurrent-close tests, plus an image-based upgrade, outage, and rollback rehearsal.

## 0.1.0

- Work item API with two synthetic workspaces and PostgreSQL row level security.
- Versioned migrations, separate database roles, runtime role checks, and Compose quickstart.
- Real database and HTTP tests, including an intentionally broken control in its own disposable database.
