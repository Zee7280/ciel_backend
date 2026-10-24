-- CIEL PK Integration Hub — one-time database bootstrap (run as the database owner / superuser).
--
-- Creates the isolated schema `external_hub` and two roles described in
-- docs/integration-hub-technical-design.md §2. Hub tables are then created by the migrations in
-- migrations/hub/ (run as ciel_hub_migrator), never by the application.
--
-- Usage (all three variables are required; the script refuses to run without them):
--   psql "$ADMIN_DATABASE_URL" \
--     -v core_role=ciel_app \
--     -v hub_app_pw='<strong random password>' \
--     -v hub_migrator_pw='<strong random password>' \
--     -f scripts/hub-bootstrap-roles.sql
--
-- Everything runs in ONE transaction with ON_ERROR_STOP, so a typo leaves the database unchanged.
--
-- What this does NOT do: it does not touch the PUBLIC pseudo-role's default grant on schema
-- public. Isolation does not need it: PUBLIC holds no table privileges, and the hub roles are
-- explicitly denied every table/sequence/function in public and own nothing there. The
-- isolation check (npm run hub:isolation-check) proves this against the live grants.
-- Optional hardening for Postgres < 15 (where PUBLIC may still CREATE in public):
--   add  -v revoke_public_create=1   to also run  REVOKE CREATE ON SCHEMA public FROM PUBLIC.

\set ON_ERROR_STOP on

-- Each missing variable raises an error, which (with ON_ERROR_STOP) exits psql non-zero.
\if :{?core_role}
\else
  DO $$ BEGIN RAISE EXCEPTION 'pass -v core_role=<role used by DB_USERNAME of the core app>'; END $$;
\endif
\if :{?hub_app_pw}
\else
  DO $$ BEGIN RAISE EXCEPTION 'pass -v hub_app_pw=<password for ciel_hub_app>'; END $$;
\endif
\if :{?hub_migrator_pw}
\else
  DO $$ BEGIN RAISE EXCEPTION 'pass -v hub_migrator_pw=<password for ciel_hub_migrator>'; END $$;
\endif

BEGIN;

CREATE ROLE ciel_hub_migrator LOGIN NOINHERIT PASSWORD :'hub_migrator_pw';
CREATE ROLE ciel_hub_app       LOGIN NOINHERIT PASSWORD :'hub_app_pw';

CREATE SCHEMA external_hub AUTHORIZATION ciel_hub_migrator;

-- Hub roles: nothing in the core schema (now, and for objects created later by the core role).
REVOKE ALL ON SCHEMA public FROM ciel_hub_app, ciel_hub_migrator;
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM ciel_hub_app, ciel_hub_migrator;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ciel_hub_app, ciel_hub_migrator;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ciel_hub_app, ciel_hub_migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE :core_role IN SCHEMA public
  REVOKE ALL ON TABLES FROM ciel_hub_app, ciel_hub_migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE :core_role IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM ciel_hub_app, ciel_hub_migrator;

-- Core role: nothing in the hub schema.
REVOKE ALL ON SCHEMA external_hub FROM :core_role;
REVOKE ALL ON SCHEMA external_hub FROM PUBLIC;

-- Runtime role: read/write inside the hub schema only. DELETE is granted per table by the
-- migrations (retention needs it on events, evidence, records, summaries; never on audit).
GRANT USAGE ON SCHEMA external_hub TO ciel_hub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ciel_hub_migrator IN SCHEMA external_hub
  GRANT SELECT, INSERT, UPDATE ON TABLES TO ciel_hub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ciel_hub_migrator IN SCHEMA external_hub
  GRANT USAGE, SELECT ON SEQUENCES TO ciel_hub_app;

ALTER ROLE ciel_hub_app      SET search_path = external_hub;
ALTER ROLE ciel_hub_migrator SET search_path = external_hub;

\if :{?revoke_public_create}
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
\endif

COMMIT;

-- Verify (expect: hub_app_can_read_users = false, hub_app_sees_hub = true, core_sees_hub = false
-- unless the core role is a superuser locally).
SELECT
  has_table_privilege('ciel_hub_app', 'public.users', 'SELECT')    AS hub_app_can_read_users,
  has_schema_privilege('ciel_hub_app', 'external_hub', 'USAGE')    AS hub_app_sees_hub,
  has_schema_privilege(:'core_role', 'external_hub', 'USAGE')      AS core_sees_hub;
