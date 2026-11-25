-- Cell database bootstrap. Run once per cell database by the cluster administrator
-- (a superuser), before the first migration. Idempotent.
--
-- Creates the group roles from the build rules (spec 11.3, 64.2), the extensions,
-- and the database-level grants. Group roles are NOLOGIN: each service gets its own
-- login role that is a member of one or more of them, created by the deployment.
-- Role attributes such as BYPASSRLS are not inherited through membership, so the
-- migration runner logs in as a member of silo_migrate and runs SET ROLE silo_migrate.

do $$
declare
  r text;
begin
  -- DDL and BYPASSRLS. Used only by Fleet migration and partition jobs.
  if not exists (select 1 from pg_roles where rolname = 'silo_migrate') then
    create role silo_migrate nologin bypassrls;
  end if;

  -- Ordinary roles: no BYPASSRLS, no DDL, never table owners.
  foreach r in array array[
    'silo_app',            -- every service
    'silo_auth',           -- auth service only: users, sessions, resets, MFA, SSO links
    'silo_audit_writer',   -- insert and select on audit ledgers
    'silo_report',         -- read-only on the replica, still subject to RLS
    'silo_credential',     -- credential mediator only: sealed columns
    'silo_outbox_relay',   -- outbox relay functions only
    'silo_billing'         -- billing service only: an organisation's billing status
  ] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end
$$;

-- Extensions (build rules: engine). Created here because some are not trusted
-- extensions and need a superuser. They live in public; public is not writable.
create extension if not exists pgcrypto;
create extension if not exists ltree;
create extension if not exists citext;
create extension if not exists btree_gist;
create extension if not exists pg_trgm;
create extension if not exists vector;

revoke create on schema public from public;

-- Services reach this database through a transaction-mode pooler (spec 8.2: "Pooling is
-- transaction mode; session-scoped features are forbidden in application code"). So the
-- service roles get no TEMPORARY (temp tables live for a session), and the session
-- defaults a service needs are the database's own, since a pooler drops connection-time
-- options: every session runs in UTC. Timeouts are set per transaction by the service
-- (src/infra/postgres.infra.ts).
do $$
begin
  execute format('revoke all on database %I from public', current_database());
  execute format('revoke temporary on database %I from silo_app, silo_auth, silo_audit_writer, silo_report, silo_credential, silo_outbox_relay, silo_billing', current_database());
  execute format('grant connect on database %I to silo_app, silo_auth, silo_audit_writer, silo_report, silo_credential, silo_outbox_relay, silo_billing', current_database());
  execute format('grant connect, temporary, create on database %I to silo_migrate', current_database());
  execute format('alter database %I set timezone to %L', current_database(), 'UTC');
end
$$;

-- Tenant migrations (spec 6.4) load an organisation's rows into the destination cell and
-- purge them from the source after 30 days. Both run as silo_migrate in one transaction
-- with SET LOCAL session_replication_role = replica, so the rows go in and out as they are:
-- triggers that guard live writes (append-only ledgers, delegation checks, status moves)
-- do not re-judge history, and the load's per-table checksums prove nothing changed. Only
-- silo_migrate may set it (PostgreSQL 15 and later; on Cloud SQL, cloudsqlsuperuser grants).
grant set on parameter session_replication_role to silo_migrate;
