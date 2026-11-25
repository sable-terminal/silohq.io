-- Directory database bootstrap (global tier, or the local directory of a
-- self-managed install). Run once by the cluster administrator. Idempotent.
-- The directory holds no customer data: no plaintext email, no organisation name.

do $$
declare
  r text;
begin
  -- status_writer and fleet_writer: the status and fleet-control services' own tables.
  foreach r in array array['directory_migrate', 'directory_reader', 'directory_writer', 'status_writer', 'fleet_writer'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end
$$;

create extension if not exists citext;

revoke create on schema public from public;

do $$
begin
  execute format('revoke all on database %I from public', current_database());
  execute format('grant connect on database %I to directory_reader, directory_writer, status_writer, fleet_writer', current_database());
  execute format('grant connect, create on database %I to directory_migrate', current_database());
  -- Session defaults belong to the database: a transaction-mode pooler drops
  -- connection-time options (spec 8.2).
  execute format('alter database %I set timezone to %L', current_database(), 'UTC');
end
$$;
