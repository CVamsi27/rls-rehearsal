# Operations and rollback

## Local install

Run `docker compose up -d --build --wait` from a release checkout. Compose starts PostgreSQL, waits for its TCP listener, runs migrations with the owner credential, then starts the application with the restricted runtime credential. The API and browser use the same loopback origin.

- `docker compose ps -a` shows whether the migration exited successfully and the app is healthy.
- `docker compose logs --tail=80 app migrate db` shows startup and migration events. The app logs request IDs, methods, route templates, status, duration, and safe error codes.
- `curl --fail-with-body http://127.0.0.1:3100/readyz` checks the runtime role and required tables. `/healthz` confirms the process can serve a request.
- `docker compose down` keeps the volume for the next run. Use `--volumes` only to discard a synthetic environment.

On `startup_failed`, check the database connection, role provisioning, and required environment variables. On `unsafe_database_configuration`, check the application URL and compare the role, table ownership, policy status, and grants with the checked-in migrations. Changing ownership or disabling RLS to make startup pass breaks the isolation guarantee.

For an adapted installation, apply migrations with `MIGRATION_DATABASE_URL` and deploy the app with only its runtime `DATABASE_URL`. Use an unprivileged runtime role, a dedicated migration owner, encrypted transport where applicable, and deployment-specific credentials. See the [threat boundary and key provisioning instructions](../SECURITY.md).

## Rehearse using release images

From a checkout with both reference tags, run:

```sh
npm run rehearse -- v0.1.0-rc.1 v0.2.0-rc.2
```

For a new release, substitute the two candidate refs and record the results using the [outcome verification checklist](outcome-verification.md). The script builds each image from its Git revision. It creates its own Compose project, ephemeral loopback port, and data volume. It checks both teams before and after each step, stops and restarts PostgreSQL, and measures a small concurrent list baseline. It removes the rehearsal resources on exit.

## Upgrade and roll back

1. Record the currently running image digest and take a backup of the target database. In staging, verify the backup can be restored before rolling out the new migration.
2. Run the v0.2 migration before replacing the v0.1 app. Migration 002 creates the closure table and its policy. The existing item schema and records remain available to the old app.
3. Start the v0.2 image. Check readiness, run an own-item and foreign-item smoke check, and close an item to confirm it records one event. Watch readiness failures, request errors, and latency against the current baseline.
4. If rollback is needed, switch the **app image** back to v0.1 and keep the additive schema. Recheck readiness and both workspaces. Use the v0.2 migrator for schema checks because the v0.1 runner deliberately rejects newer migration history.
5. During rollback the core workflow remains available. v0.1 can close items but does not record history. When v0.2 returns, recorded history is still present. Items closed during rollback have no recorded event.

The closure ledger records events from the v0.2 app. It does not guarantee historical completeness during a mixed-version rollout or a rollback.
