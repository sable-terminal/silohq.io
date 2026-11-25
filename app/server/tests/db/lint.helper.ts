// Catalogue checks for the build rules (docs/siloDatabaseDesign.doc.md) and spec 11.3:
// "The build rejects a tenant table lacking organisation_id, forced RLS or a policy."
// Each rule is a query over pg_catalog returning the objects that break it.
// tests/db/conventions.test.ts runs them over the real schemas (expecting none) and
// over a schema with planted violations (expecting every rule to fire).

import type pg from 'pg';

export interface Violation {
  rule: string;
  object: string;
}

export interface LintOptions {
  schemas: string[];
  ledgers: string[];
  encryptedColumns: string[];
  userKeyed: string[];
  neverDeleted: string[];
}

// Append-only ledgers (build rules). Checked where they exist.
export const LEDGERS = [
  'audit.audit_events', 'audit.auth_events', 'clone.render_selections', 'billing.token_transactions',
  'platform.model_calls', 'iam.credential_unwraps', 'connect.discovery_probes', 'siloes.transitions',
  'action.action_commits', 'gov.lineage_edges',
];

// Columns that may hold customer record values: bytea, encrypted, never indexed.
export const ENCRYPTED_COLUMNS = [
  'action.prior_states.value', 'action.mutations.diff', 'action.mutations.manifest_values',
  'action.mutations.intent', 'action.mutation_verifications.intended', 'action.mutation_verifications.observed',
  'action.revert_conflicts.post_write_value', 'action.revert_conflicts.current_value', 'action.receipts.document',
  'simulation.staged_action_bases.base_value', 'simulation.staged_action_bases.staged_value',
  'automation.automation_run_state.previous_value', 'workspace.ask_turns.question',
  'siloes.transitions.previous_value', 'siloes.transitions.new_value', 'siloes.silo_baselines.last_observed_value',
  'siloes.silo_extractions.value', 'workspace.ml_model_versions.artifact',
];

// Who-did-it identities. Their rows are never deleted (the never-deleted rule checks no
// service can), so a foreign key into one is never checked from the referencing side and
// needs no index for that; an actor column (created_by, granted_by and the like) is
// indexed only where a query reads by it.
export const NEVER_DELETED = ['iam.users', 'iam.memberships', 'iam.service_principals', 'platform.operators'];

export const CELL_SCHEMAS = [
  'iam', 'gov', 'audit', 'platform', 'connect', 'ontology', 'clone', 'workspace', 'recognition',
  'simulation', 'automation', 'files', 'action', 'fde', 'siloes', 'billing',
];

const APP_ROLES = ['silo_app', 'silo_auth', 'silo_audit_writer', 'silo_report', 'silo_credential', 'silo_outbox_relay'];

export const USER_KEYED = ['iam.users', 'iam.sessions', 'iam.password_resets', 'iam.mfa_factors', 'iam.user_identities'];

// Relations (tables and partitioned tables, partitions included) in the schemas.
const RELATIONS = `
  select c.oid, n.nspname, c.relname, c.relkind, c.relispartition,
         format('%I.%I', n.nspname, c.relname) as name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = any($1) and c.relkind in ('r', 'p')`;

const HAS_COLUMN = (column: string): string => `exists (
  select 1 from pg_attribute a where a.attrelid = r.oid and a.attname = '${column}' and not a.attisdropped)`;

const RULES: Record<string, string> = {
  // Spec 64.2: every table carrying organisation_id has RLS enabled and forced, with a policy.
  'tenant-rls': `
    with r as (${RELATIONS})
    select r.name as object from r join pg_class c on c.oid = r.oid
    where ${HAS_COLUMN('organisation_id')}
      and (not c.relrowsecurity or not c.relforcerowsecurity
           or not exists (select 1 from pg_policy p where p.polrelid = r.oid))`,

  // Tables keyed by user carry user-keyed RLS too.
  'user-keyed-rls': `
    with r as (${RELATIONS})
    select r.name as object from r join pg_class c on c.oid = r.oid
    where r.name = any($2::text[])
      and (not c.relrowsecurity or not c.relforcerowsecurity
           or not exists (select 1 from pg_policy p where p.polrelid = r.oid))`,

  // Every tenant table with an id has unique (organisation_id, id); one without an id
  // has a primary key that starts with organisation_id. Partitioned ledgers are exempt.
  'tenant-key': `
    with r as (${RELATIONS}),
    idx as (
      select i.indrelid, i.indisprimary,
             array(select a.attname from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
                   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                   order by k.ord) as cols
      from pg_index i
      where i.indisunique and i.indpred is null and i.indexprs is null)
    select r.name as object from r
    where r.relkind = 'r' and not r.relispartition and ${HAS_COLUMN('organisation_id')}
      and case when ${HAS_COLUMN('id')}
               then not exists (select 1 from idx where idx.indrelid = r.oid
                                 and idx.cols = array['organisation_id', 'id']::name[])
               else not exists (select 1 from idx where idx.indrelid = r.oid and idx.indisprimary
                                 and idx.cols[1] = 'organisation_id')
          end`,

  // A foreign key into a tenant table maps the referencing tenant column onto the
  // referenced organisation_id, so a row can never reference another tenant's row.
  'composite-tenant-fk': `
    select format('%s (%s)', con.conname, con.conrelid::regclass) as object
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where con.contype = 'f' and con.conparentid = 0 and n.nspname = any($1)
      and exists (select 1 from pg_attribute a where a.attrelid = con.confrelid
                  and a.attname = 'organisation_id' and not a.attisdropped)
      and not exists (
        select 1 from unnest(con.conkey, con.confkey) as k(src, dst)
        join pg_attribute sa on sa.attrelid = con.conrelid and sa.attnum = k.src
        join pg_attribute da on da.attrelid = con.confrelid and da.attnum = k.dst
        where da.attname = 'organisation_id'
          and sa.attname = case when con.conrelid = to_regclass('iam.organisations')
                                then 'id' else 'organisation_id' end)
      and coalesce(obj_description(con.oid, 'pg_constraint'), '') not like 'lint:cross-tenant%'`,

  // Indexing rule 1: every foreign key has an index whose leading columns are the key's
  // columns (in any order), optionally after organisation_id. Keys into a never-deleted
  // identity table are exempt (actor columns). Any other deliberate exception carries a
  // 'lint:no-index <reason>' comment on the constraint.
  'fk-index': `
    select format('%s (%s)', con.conname, con.conrelid::regclass) as object
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_class tc on tc.oid = con.confrelid
    join pg_namespace tn on tn.oid = tc.relnamespace
    where con.contype = 'f' and con.conparentid = 0 and n.nspname = any($1)
      and format('%s.%s', tn.nspname, tc.relname) <> all($6::text[])
      and coalesce(obj_description(con.oid, 'pg_constraint'), '') not like 'lint:no-index%'
      and not exists (
        select 1 from pg_index i
        cross join lateral (select array(select k.attnum from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
                                         order by k.ord) as keys) ik
        where i.indrelid = con.conrelid and i.indexprs is null
          and (
            (select array_agg(x order by x) from unnest(ik.keys[1:cardinality(con.conkey)]) x)
              = (select array_agg(x order by x) from unnest(con.conkey) x)
            or (ik.keys[1] = (select attnum from pg_attribute where attrelid = con.conrelid and attname = 'organisation_id')
                and (select array_agg(x order by x) from unnest(ik.keys[2:cardinality(con.conkey) + 1]) x)
                    = (select array_agg(x order by x) from unnest(con.conkey) x))))`,

  // The never-deleted identity tables: no service may delete from them.
  'never-deleted': `
    with r as (${RELATIONS})
    select format('%s on %s', role, r.name) as object
    from r cross join unnest($4::text[]) role
    where r.name = any($6::text[]) and has_table_privilege(role, r.oid, 'DELETE')`,

  // Every range-partitioned table has a default partition, so a write never fails for
  // want of a partition, whatever its date.
  'partition-default': `
    with r as (${RELATIONS})
    select r.name as object from r
    join pg_partitioned_table pt on pt.partrelid = r.oid
    where pt.partstrat = 'r' and pt.partdefid = 0`,

  // Enumerations are text with a check, never enum types.
  'no-enum-types': `
    select format('%I.%I', n.nspname, t.typname) as object
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = any($1) and t.typtype = 'e'`,

  // Timestamps are timestamptz, always.
  'timestamptz-only': `
    select format('%I.%I.%I', n.nspname, c.relname, a.attname) as object
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = any($1) and c.relkind in ('r', 'p', 'v') and not c.relispartition
      and a.attnum > 0 and not a.attisdropped and a.atttypid = 'timestamp'::regtype`,

  // A table with updated_at keeps it current with the shared trigger.
  'updated-at-trigger': `
    with r as (${RELATIONS})
    select r.name as object from r
    where not r.relispartition and ${HAS_COLUMN('updated_at')}
      and not exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                      where t.tgrelid = r.oid and p.proname = 'set_updated_at')`,

  // Ledgers reject update, delete and truncate, and no service may update or delete.
  'append-only-ledger': `
    with r as (${RELATIONS})
    select r.name as object from r
    where r.name = any($3::text[])
      and (not exists (select 1 from pg_trigger t where t.tgrelid = r.oid and t.tgname = 'ledger_no_update')
           or not exists (select 1 from pg_trigger t where t.tgrelid = r.oid and t.tgname = 'ledger_no_delete')
           or exists (select 1 from unnest($4::text[]) role
                      where has_table_privilege(role, r.oid, 'UPDATE') or has_table_privilege(role, r.oid, 'DELETE')))`,

  // Service roles never truncate, never own, never bypass RLS (spec 64.2).
  'service-role-limits': `
    with r as (${RELATIONS})
    select format('%s on %s', role, r.name) as object
    from r cross join unnest($4::text[]) role
    where has_table_privilege(role, r.oid, 'TRUNCATE')
       or has_table_privilege(role, r.oid, 'TRIGGER')
       or has_table_privilege(role, r.oid, 'REFERENCES')
       or pg_get_userbyid((select relowner from pg_class where oid = r.oid)) = role
    union all
    select rolname from pg_roles where rolname = any($4::text[]) and (rolbypassrls or rolsuper or rolcreaterole)`,

  // Only the auth service reads user-keyed tables.
  'user-keyed-privileges': `
    with r as (${RELATIONS})
    select format('%s on %s', role, r.name) as object
    from r cross join unnest(array['silo_app', 'silo_report', 'silo_audit_writer', 'silo_credential',
                                   'silo_outbox_relay']) role
    where r.name = any($2::text[]) and has_any_column_privilege(role, r.oid, 'SELECT')`,

  // No function is executable by PUBLIC; every grant is explicit.
  'function-not-public': `
    select p.oid::regprocedure::text as object
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = any($1)
      and (p.proacl is null
           or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))`,

  // Security definer functions pin search_path.
  'definer-search-path': `
    select p.oid::regprocedure::text as object
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = any($1) and p.prosecdef
      and not exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%')`,

  // Record values: bytea, never indexed.
  'encrypted-columns': `
    select format('%I.%I.%I', n.nspname, c.relname, a.attname) as object
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where format('%s.%s.%s', n.nspname, c.relname, a.attname) = any($5::text[])
      and not c.relispartition and not a.attisdropped
      and (a.atttypid <> 'bytea'::regtype
           or exists (select 1 from pg_index i where i.indrelid = c.oid and a.attnum = any(i.indkey::int2[])))`,

  // A foreign key deferred until its target exists must be added once it does.
  'fk-pending-resolved': `
    select format('%I.%I.%I -> %s', n.nspname, c.relname, a.attname,
                  substring(col_description(c.oid, a.attnum) from '^fk-pending: ([a-z_]+\\.[a-z_]+)')) as object
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = any($1) and c.relkind in ('r', 'p') and not c.relispartition and a.attnum > 0
      and col_description(c.oid, a.attnum) like 'fk-pending: %'
      and to_regclass(substring(col_description(c.oid, a.attnum) from '^fk-pending: ([a-z_]+\\.[a-z_]+)')) is not null`,
};

export const RULE_NAMES = Object.keys(RULES);

export async function lint(client: pg.Client, options: LintOptions): Promise<Violation[]> {
  const params = [options.schemas, options.userKeyed, options.ledgers, APP_ROLES, options.encryptedColumns,
                  options.neverDeleted];
  const violations: Violation[] = [];
  for (const [rule, sql] of Object.entries(RULES)) {
    // Every rule receives all six parameters; the outer filter references each one
    // so Postgres can type those a rule does not use.
    const wrapped = `select q.object from (${sql}) q
      where $1::text[] is not null and $2::text[] is not null and $3::text[] is not null
        and $4::text[] is not null and $5::text[] is not null and $6::text[] is not null`;
    const { rows } = await client.query<{ object: string }>(wrapped, params);
    for (const row of rows) violations.push({ rule, object: row.object });
  }
  return violations;
}
