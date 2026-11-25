# Database

Postgres 16 schema for a Silo cell, plus the directory database. The design these
migrations implement is `docs/siloDatabaseDesign.doc.md`; the build rules at the top of
that file apply to every table.

## Layout

| Path | What it is |
|---|---|
| `bootstrap/cell.bootstrap.sql`, `bootstrap/directory.bootstrap.sql` | Run once per database by the cluster administrator: roles, extensions, database grants. |
| `migrations/0001Initial.migration.sql` | The whole cell schema, applied as `silo_migrate`. |
| `directory/migrations/0001Directory.migration.sql` | The directory database (a separate database), applied as `directory_migrate`. |
| `scripts/migrate.script.ts` | The runner. |
| `scripts/bootstrapLocal.script.ts` | Local development only: creates and bootstraps the two databases in the local container. |
| `scripts/maintainPartitions.script.ts` | The daily partition job. Exits 1 when a partitioned table needs attention, so a failed run is the alert. |
| `scripts/generateModels.script.ts` | Generates the models and schemas, and scaffolds the repos (see "Models, schemas and repos"). |
| `scripts/generateSchemas.script.ts` | Builds each table's Zod schema from its columns and checks, for `generateModels`. |
| `../models/<schema>/<name>.model.ts` | One per table: the row type, what a service may insert and change, and the table spec. Generated. |
| `../repos/<schema>/<name>.repo.ts` | One per table: plain-SQL data access. Scaffolded once, then hand-maintained. |
| `../../tests/db/` | Database tests (`*.test.ts`) and their helpers (`*.helper.ts`), including the build-rule linter. |

File names follow `fileName.layer.extension`: a camelCase name, then the layer
(`migration`, `bootstrap`, `script`, `test`, `helper`), then the extension.

## Running locally

```sh
npm run db:up          # Postgres 16 + pgvector on 127.0.0.1:55432, PgBouncer on 56432
npm run db:bootstrap   # creates silo_cell and silo_directory and bootstraps them
CELL_MIGRATE_URL=postgres://postgres:postgres@127.0.0.1:55432/silo_cell npm run db:migrate
DIRECTORY_MIGRATE_URL=postgres://postgres:postgres@127.0.0.1:55432/silo_directory npm run db:migrate:directory
CELL_MIGRATE_URL=postgres://postgres:postgres@127.0.0.1:55432/silo_cell npm run db:partitions
CELL_MIGRATE_URL=... DIRECTORY_MIGRATE_URL=... npm run db:models   # after any migration change
npm run test:db        # fresh databases per test file, dropped afterwards
```

## Models, schemas and repos

No ORM. Services reach Postgres through plain parameterised SQL (`pg`), with one model,
one Zod schema and one repo per table (243: every table a service can read; the
migration ledgers and the partition plan have none).

- **Models** (`src/models/<schema>/<name>.model.ts`) are generated from the migrated
  database by `npm run db:models` and never edited. Each holds the row type (camelCase
  properties; a text column whose check lists its values is a union of them),
  `New<Model>` (the columns a service role may insert, by grant), `<Model>Changes` (the
  columns a service role may update, less keys, frozen columns and timestamps), the key
  type, and the table spec the repo builds its SQL from. `tests/db/models.test.ts` fails
  when a model no longer matches the migrations, so a schema change and its models ship
  together.
- **Schemas** (`src/schemas/<schema>/<name>.schema.ts`) are generated in the same run and
  never edited. Each states as Zod what Postgres states about each column: its type,
  whether it may be null, and the single-column checks that translate (enums, non-blank,
  lengths in characters or bytes, ranges, patterns, JSON type and size, array sizes),
  built from `src/schemas/column.schema.ts`. There are three per table: the row,
  `new<Model>Schema` and `<model>ChangesSchema`; the last two refuse unknown properties.
  Each is checked against its model at compile time (`satisfies z.ZodType<...>`).
  A check that does not translate is listed at the end of the file and left to the
  database, as are keys, foreign keys, row-level security and checks across columns.
  `tests/db/schemas.test.ts` checks that a value the schema refuses is one Postgres
  refuses, and the reverse. Endpoint and message schemas are built from these with
  `.pick()` and `.extend()`.
- **Repos** (`src/repos/<schema>/<name>.repo.ts`) are scaffolded once with insert, update
  and remove only where a service role holds the privilege, and one finder per primary or
  unique key, so every generated query has an index. After that a repo belongs to its
  authors: a table's own queries go there, and `db:models` never overwrites it.
- **Indexes:** each schema folder has `index.model.ts`, `index.schema.ts` and `index.repo.ts`, regenerated
  every run, so a service imports a schema in one line:
  `import { organisationRepo, membershipRepo } from '../repos/iam/index.repo.ts'`.
  Per schema rather than one index for everything: `platform` and `directory` both have a
  `Cell`, and Node loads every module an index re-exports. A primary key type is
  `<Model>PrimaryKey`, so it never clashes with a table named `*_keys`.
- **Shared code:** `src/models/table.model.ts`, `src/schemas/column.schema.ts` and
  `src/repos/base.repo.ts` (the four statement helpers). Pools and `inTransaction`, which
  sets the request context with `SET LOCAL` for row-level security, are in
  `src/infra/postgres.infra.ts`.
- **Values** arrive exactly as stored: timestamps as ISO 8601 strings with microseconds
  (a JavaScript `Date` drops them, and ledger keys include the timestamp), dates as
  `YYYY-MM-DD`, bigint and numeric as strings, jsonb as JSON values, bytea as `Buffer`.

## What 0001Initial.migration.sql contains

16 schemas, 242 tables, 181 partitions, 5 views, 508 triggers and 117 functions:
every Postgres table in the design. In order:

1. Foundation: schemas, schema grants, shared functions (UUIDv7, `updated_at`, the
   append-only guard, column freeze, the tenant RLS helper, partition plan and maintenance).
2. Platform core (`platform.cells`, `platform.operators`) and identity (`iam`):
   organisations, policy versions, organisation keys, users, sessions, MFA, memberships,
   scopes, roles, service principals, SSO configuration and links, invitations.
3. Audit ledger, outbox (with relay functions), model calls, operator access.
4. One section per domain: governance and the rest of `iam` and `platform`; Connect;
   ontology (with compiled manifests); clones and workspace; recognition and simulation;
   automation, files and the AI FDE; Actions; Siloes and billing.
5. Cross-domain keys: each domain declares keys to its own tables inline; keys into a
   later domain are added here, once every table exists.
6. Partitions for every range-partitioned ledger, each with a default partition.

Not in Postgres by design: `action.action_ledger` (BigQuery), and the Redis, BigQuery and
object storage layouts in section 08 of the design.

## Pooling

Services never connect to Postgres directly. Each process keeps a small `pg.Pool`
(`PG_POOL_MAX`) of connections to PgBouncer in transaction mode, which shares server
connections across every replica of every service (spec 8.2). A server connection
serves a different client after each transaction, so application code uses nothing
session-scoped, and `tests/architecture/layers.test.ts` fails on any of it:

- Context and limits are set per transaction by `withTransaction`
  (`src/infra/postgres.infra.ts`) with `set_config(..., true)`. That covers the
  organisation, membership, user and principal, the time zone, `statement_timeout` and
  `idle_in_transaction_session_timeout`.
- The database defaults to UTC (bootstrap), because a pooler drops connection-time
  options.
- There is no `SET`, `SET ROLE`, session advisory lock, `LISTEN`, temporary table, `WITH
  HOLD` cursor or named prepared statement. Service roles have no `TEMPORARY` privilege.
- PgBouncer's own `query_timeout` and `idle_transaction_timeout` are backstops behind the
  per-transaction timeouts.

Services open their databases with `openDatabases(config, service, targets)` and run
every transaction through `inTransaction`:

- A serialization failure or deadlock rolls the transaction back and runs it again, up to
  3 attempts with jittered backoff, then fails as a retryable conflict. That is safe
  because the work touches only the database: events go through the outbox in the same
  transaction, and calls to anything else come after `inTransaction` returns.
- Failures arrive as `AppError`s, never driver errors: no free connection in time is a
  capacity refusal with a retry time; an unreachable database or a lost connection is
  `unavailable`; a statement over its timeout is `timeout`.
- A connection that drops while idle or between statements is logged and discarded,
  never left to crash the process.
- Every transaction on the reporting replica (`report`) is read-only.
- Gauges `silo.db_pool.connections` (idle, busy) and `silo.db_pool.waiting`, and counters
  for lost connections and retried transactions, per target and service.
- `close()` refuses new transactions and waits for in-flight ones, for shutdown.

Migration jobs, `db:partitions` and `db:models` need a session (`SET ROLE`, the
migration lock) and connect to Postgres directly. `tests/infra/pooling.test.ts` runs
through the pooler and proves that tenant context never reaches the next client of a
shared server connection; `tests/infra/postgres.test.ts` covers retries, dropped
connections, error mapping and shutdown.

## How migrations run

- Forward only (spec 11.3: expand and contract). There are no down migrations: a release
  rolls back without a schema change because each expand step works with the previous
  and next release. Contract steps ship in a later release.
- Each file runs in one transaction. The runner records a SHA-256 checksum per file and
  refuses to run if an applied file has changed or gone missing. To change the schema,
  write `0002Name.migration.sql`; never edit `0001Initial.migration.sql` once a cell has applied it.
- The runner logs in as a member of the migration role and runs `SET ROLE silo_migrate`,
  because `BYPASSRLS` is not inherited through role membership. Application pods never
  hold these credentials.
- One run at a time per database (advisory lock).

## Roles

Created by `bootstrap/cell.bootstrap.sql` as `NOLOGIN` group roles. A deployment gives each service
its own login that is a member of the roles it needs (for example the auth service is
in `silo_auth` and `silo_app`; the credential service in `silo_credential` and `silo_app`).

| Role | Use |
|---|---|
| `silo_migrate` | DDL and `BYPASSRLS`. Owns every object. Migrations and partition jobs only. |
| `silo_app` | Every service. No bypass, no DDL, no truncate. |
| `silo_auth` | Auth service: users, sessions, password resets, MFA factors, SSO links. |
| `silo_audit_writer` | Insert and select on the audit ledgers and model calls. |
| `silo_report` | Read-only on the replica, still under RLS; cannot read any encrypted value column. |
| `silo_credential` | The credential mediator: sealed columns, wrapped keys, the unwrap ledger. |
| `silo_outbox_relay` | Execute on the three outbox relay functions; no table access. |

## Writing a migration

1. Name it `NNNNShortName.migration.sql` with the next number, for example
   `0002AuditIndexes.migration.sql`; the runner refuses any other name. Start with a
   comment naming the design section and any decisions it implements.
2. Every tenant table: `organisation_id uuid not null`, `unique (organisation_id, id)`,
   composite foreign keys `(organisation_id, x_id)`, and
   `select platform.enable_tenant_rls('schema.table')`.
3. Mutable tables with `updated_at`: `select platform.add_updated_at_trigger(...)`.
   Ledgers: `select platform.make_append_only(...)` and grant `insert, select` only.
   Columns that never change: a `platform.freeze_columns(...)` trigger.
4. Grant explicitly, table by table. Functions are not executable by `PUBLIC`; a
   `security definer` function must `set search_path`.
5. Index every foreign key, leading with its columns (optionally after
   `organisation_id`). Actor columns are the rule's one blanket exception: a key into
   `iam.users`, `iam.memberships`, `iam.service_principals` or `platform.operators`
   (`created_by`, `granted_by`, `revoked_by` and the like) needs no index, because those
   rows are never deleted and the linter checks no service can delete them. Index an
   actor column only when a query reads by it. Any other deliberate exception carries
   `comment on constraint ... is 'lint:no-index <reason>'`; a deliberate non-composite
   key into a tenant table carries `'lint:cross-tenant <reason>'`.
6. A foreign key whose target table does not exist yet is recorded as a column comment
   `fk-pending: schema.table`; the linter fails once the target exists without the key.
7. Range-partitioned ledgers: add the parent to `platform.partition_plan`. Every
   range-partitioned table gets a default partition (the linter checks), so no write is
   ever refused for its date. The daily job (`npm run db:partitions`, as `silo_migrate`)
   runs `platform.maintain_partitions()`, which keeps partitions ahead and moves any row
   that reached a default into a partition of its own, then fails if
   `platform.partition_status()` reports a table behind, missing, or with rows in its
   default. `siloes.create_capture_partitions(organisation_id)` adds an organisation's
   Capture partitions to the plan when its first Capture Silo is created.

`npm run test:db` runs the linter (`tests/db/lint.helper.ts`) over every schema. It is the
check spec 11.3 requires: the build fails on a tenant table without forced RLS and a
policy, and on any break of the build rules. Each rule is proven against a planted
violation in the same run.

## Next

1. Seed the permission catalogue (chapter 76) and the seeded roles, then add the
   triggers that need it: role and connection grant delegation (56.7), the holder checks
   for `clearance.grant`, `purpose.define` and `marking.declassify`, the declassification
   execution check, and ending purpose sessions when eligibility is revoked.
2. Seed `recognition.detectors`: blocked until the six missing detector names are known.
3. Port the slice-level behaviour checks run while building (about 500, in SQL) into
   `tests/db` so every trigger is covered in CI, not only identity, ledgers and outbox.

## Open design items

Found while implementing; each needs a product or design decision.

- **Roles not yet defined:** the admin portal (writes operators and operator access
  sessions) and the billing webhook (the only writer of `iam.organisations.billing_status`).
  The contract renewal job must run with an operator session or as `silo_migrate`.
- **Discovery scans:** the authorisation and its approval chain reference each other
  (deferrable), so the authorisation row exists before approval; the design says it is
  written after. The agent scans only once the chain is approved and the signed hash set.
- **Purges:** a purge request is inserted first, its approval chain second, then the
  request is updated with the chain id. Retention sweeps have no scope value in
  `purge_receipts`, which requires a request.
- **Credentials:** revoking a connection revokes its credentials in the same
  transaction, which needs a login in both `silo_app` and `silo_credential`.
- **Ontology:** `proposal_approvals` is unique per proposal, member and permission, so one
  person cannot approve two markings; functions and field authorities have no `proposed`
  status for elements created on a branch.
- **Siloes:** `warehouse_projects` allows one Warehouse per organisation ever, while
  `siloes` allows a new one after the old is disabled (suggest a partial unique).
- **Workspace:** a draft app version cannot remove a reference (no delete on
  `app_references`); Ask thread titles are plain text and could carry values the
  encrypted question protects.
- **Automation:** Cron conditions and actions cannot be removed once saved (no delete,
  no retired column).
- **AI FDE:** a deferred proposal counts as decided and cannot be decided later; a
  handed-over engagement can never move to closed.
- **Directory:** `directory.cells` is written by Fleet through `directory_writer`; its
  residency check is extended by migration, as `platform.cells` is.
- **Deployment, not migrations:** scheduling `npm run db:partitions` daily in each cell
  with an alert on a failed run (no deployment config exists yet), `pgaudit` (alert on
  the session user), and a single active outbox relay per cell. The relay passes `created_at` back as text,
  because JavaScript dates drop microseconds.
