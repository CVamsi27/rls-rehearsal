export const NAME = 'rls-rehearsal';

export function usage(): string {
  return `Usage:
  rls-rehearsal run [options]
  rls-rehearsal doctor [options]
  rls-rehearsal init [--config rls-rehearsal.config.json] [--force]

Commands:
  run      Run the isolation matrix, explicit checks and optional control mode.
  doctor   Validate the connection, roles, tables, RLS policies and grants.
  init     Write a starter configuration.

Options:
  --config <path>          Config file. Default: rls-rehearsal.config.json
  --database-url <url>     Override the connection env named in the config.
  --admin-url <url>        Privileged connection for --control.
                           Defaults to RLS_REHEARSAL_ADMIN_URL.
  --control                Disable RLS as a privileged role and prove a leak is visible.
  --format <list>          Comma-separated: json, md, junit. Default: json,md
  --out <dir>              Report directory. Default: .rls-rehearsal
  --fail-on-empty          Fail when an actor sees no rows in any configured resource.
  --allow-remote           Permit a non-loopback host. Use only for disposable data.
  --allow-privileged       Permit a superuser or BYPASSRLS role for the tested session.
  --force                  Overwrite an existing config with init.
  --help, -h               Show this help.
  --version, -v            Print the version.

Environment:
  RLS_REHEARSAL_DATABASE_URL   Default connection env used by the starter config.
  RLS_REHEARSAL_ADMIN_URL      Privileged connection for control mode.

Exit codes:
  0  All checks passed.
  1  At least one check failed.
  2  Usage, configuration, connection or setup error.
  3  Unsafe target refused before connecting.`;
}
