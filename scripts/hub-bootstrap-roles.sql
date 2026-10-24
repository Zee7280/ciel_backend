-- CIEL PK Integration Hub — one-time database bootstrap (run as the database owner / superuser).
--
-- Creates the isolated schema and the two hub roles described in
-- docs/integration-hub-technical-design.md §2. After this, hub tables are created by the
-- version-controlled migrations in migrations/hub/ (run as ciel_hub_migrator), never by the app.
--
-- Usage (core_role = the role in DB_USERNAME that the core application connects with):
--   psql "$ADMIN_DATABASE_URL" -v core_role=ciel_app -f scripts/hub-bootstrap-roles.sql
-- Replace the two CHANGE-ME passwords first (or ALTER ROLE ... PASSWORD afterwards).

CREATE ROLE ciel_hub_migrator LOGIN PASSWORD 'CHANGE-ME-migrator';
CREATE ROLE ciel_hub_app       LOGIN PASSWORD 'CHANGE-ME-app';

CREATE SCHEMA external_hub AUTHORIZATION ciel_hub_migrator;

-- Hub roles get nothing in the core schema.
REVOKE ALL ON SCHEMA public FROM ciel_hub_app, ciel_hub_migrator;
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM ciel_hub_app, ciel_hub_migrator;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ciel_hub_app, ciel_hub_migrator;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ciel_hub_app, ciel_hub_migrator;
-- !!! PRODUCTION DBA REVIEW REQUIRED FOR THE NEXT TWO STATEMENTS !!!
-- Postgres grants USAGE on schema public to the PUBLIC pseudo-role by default, and PUBLIC grants
-- apply to every role (NOINHERIT does not shield from them). The only way to deny the hub roles
-- access to `public` is to revoke that default grant and re-grant USAGE explicitly to every role
-- that legitimately needs it (the core app role, migration/BI/monitoring roles, provider admin
-- roles). Run the listing below first and re-grant for each role you see:
--   SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname NOT LIKE 'pg_%';
-- Then, for each such role other than the two hub roles:  GRANT USAGE ON SCHEMA public TO <role>;
ALTER ROLE ciel_hub_app       NOINHERIT;
ALTER ROLE ciel_hub_migrator  NOINHERIT;
REVOKE USAGE ON SCHEMA public FROM PUBLIC;
GRANT  USAGE ON SCHEMA public TO :core_role;

-- The core role gets nothing in the hub schema.
REVOKE ALL ON SCHEMA external_hub FROM :core_role;
REVOKE ALL ON SCHEMA external_hub FROM PUBLIC;

-- Runtime role: read/write inside the hub schema only. DELETE is granted per table by the
-- migrations (retention needs it on events, evidence, records, summaries; not on audit).
GRANT USAGE ON SCHEMA external_hub TO ciel_hub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ciel_hub_migrator IN SCHEMA external_hub
  GRANT SELECT, INSERT, UPDATE ON TABLES TO ciel_hub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ciel_hub_migrator IN SCHEMA external_hub
  GRANT USAGE, SELECT ON SEQUENCES TO ciel_hub_app;

ALTER ROLE ciel_hub_app      SET search_path = external_hub;
ALTER ROLE ciel_hub_migrator SET search_path = external_hub;

-- Verify (expect: hub_app_sees_public = false, hub_app_sees_hub = true)
SELECT
  has_schema_privilege('ciel_hub_app', 'public', 'USAGE')       AS hub_app_sees_public,
  has_schema_privilege('ciel_hub_app', 'external_hub', 'USAGE') AS hub_app_sees_hub,
  has_schema_privilege(:'core_role', 'external_hub', 'USAGE')   AS core_sees_hub;
