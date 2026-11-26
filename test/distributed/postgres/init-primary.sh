#!/bin/sh
# Runs once, when the primary's data directory is created. Sets the database up as the PostgreSQL setup guide
# (packages/coding-agent/docs/storage/postgres.md) and the PgBouncer guide say: an owner role that runs
# `atomic storage migrate`, a runtime role with no DDL rights, PgBouncer's password lookup, and a role for the replica.
set -eu
psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres \
	-v owner="$ADT_OWNER_PASSWORD" \
	-v runtime="$ADT_RUNTIME_PASSWORD" \
	-v replication="$ADT_REPLICATION_PASSWORD" \
	-v auth="$ADT_PGBOUNCER_AUTH_PASSWORD" <<'SQL'
CREATE ROLE atomic_owner LOGIN PASSWORD :'owner';
CREATE ROLE atomic_runtime LOGIN PASSWORD :'runtime';
CREATE ROLE replicator LOGIN REPLICATION PASSWORD :'replication';
CREATE ROLE pgbouncer_auth LOGIN PASSWORD :'auth';
CREATE DATABASE atomic OWNER atomic_owner;
REVOKE ALL ON DATABASE atomic FROM PUBLIC;
GRANT CONNECT ON DATABASE atomic TO atomic_owner, atomic_runtime, pgbouncer_auth;
\connect atomic
-- Session search's index needs pg_trgm, which only an administrator can install.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA atomic AUTHORIZATION atomic_owner;
GRANT USAGE ON SCHEMA atomic TO atomic_runtime;
SET ROLE atomic_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO atomic_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT USAGE, SELECT ON SEQUENCES TO atomic_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT EXECUTE ON FUNCTIONS TO atomic_runtime;
RESET ROLE;
-- PgBouncer's password lookup, as in the PgBouncer guide.
CREATE SCHEMA pgbouncer;
GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer_auth;
CREATE FUNCTION pgbouncer.get_auth(p_usename text)
  RETURNS TABLE(usename text, passwd text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT rolname::text, rolpassword FROM pg_catalog.pg_authid
  WHERE rolname = p_usename
    AND rolcanlogin AND NOT rolsuper
    AND rolname = ANY (ARRAY['atomic_runtime', 'atomic_owner'])
    AND (rolvaliduntil IS NULL OR rolvaliduntil > now())
$$;
REVOKE ALL ON FUNCTION pgbouncer.get_auth(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(text) TO pgbouncer_auth;
SQL
