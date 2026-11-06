#!/bin/sh
set -eu

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv db POSTGRES_DB
\getenv migration_password TENANTPROOF_MIGRATION_PASSWORD
\getenv runtime_password TENANTPROOF_RUNTIME_PASSWORD

CREATE ROLE tenantproof_migrator LOGIN PASSWORD :'migration_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE tenantproof_runtime LOGIN PASSWORD :'runtime_password'
  NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO tenantproof_migrator, tenantproof_runtime;
CREATE SCHEMA tenantproof AUTHORIZATION tenantproof_migrator;
CREATE SCHEMA tenantproof_meta AUTHORIZATION tenantproof_migrator;
GRANT USAGE ON SCHEMA tenantproof TO tenantproof_runtime;
SQL
