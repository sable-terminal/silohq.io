// Where SQL may be written (decisions 2026-11-01).
//
// Silo's own databases: SQL lives only in repos (and models, which carry the table specs
// repos build from) and in src/db (migrations, bootstrap, scripts). No service,
// controller, route or worker holds a statement, imports the Postgres driver or calls
// .query(). infra/postgres.infra.ts runs the transaction itself (begin, set_config,
// commit, rollback, the health ping) and holds no statement on a table.
//
// Customer systems: SQL is generated at run time from a plan and a manifest, only by the
// SQL and BigQuery protocol engines and the warehouse generator (SQL_MODULES), and only
// through utils/sqlBuilder.util.ts: constant text in sql`...` templates, every value a
// bound parameter, every identifier from the manifest quoted by the dialect. Those
// modules never reach Silo's own database: no Postgres driver, no repo, no Silo
// connection. They reach customer systems through connect-runtime connections only.
//
// Silo's own BigQuery (the warehouse and Object Index of spec 69, a platform adapter like
// KMS and object storage): infra/bigquery.infra.ts alone holds the BigQuery client and
// runs what it is given. It writes no SQL: statements reach it as rendered fragments from
// the warehouse generator (SQL_MODULES), with every value bound (decision 2026-11-02).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { all, imports, resolveImport, scan, SQL_BUILDER, SQL_MODULES } from './source.helper.ts';

const SQL_HOMES = ['repos/', 'models/', 'db/'];
const TRANSACTION_MECHANISM = 'infra/postgres.infra.ts';
const WAREHOUSE_ADAPTER = 'infra/bigquery.infra.ts';
// Database drivers. A protocol engine talks to a customer system through a connect-runtime
// connection, never a driver of its own, and never Silo's own database.
const DRIVERS = ['pg', 'pg-pool', 'postgres', 'mysql', 'mysql2', 'mssql', 'tedious', 'oracledb', 'snowflake-sdk',
  '@google-cloud/bigquery', '@databricks/sql', 'sqlite3', 'better-sqlite3'];
const SILO_DATABASE = ['repos/', 'models/', 'infra/postgres.infra.ts', 'config/postgres.config.ts'];

// Every Silo table is schema-qualified (iam.users), which tells a statement from prose
// such as 'select a period from the list'.
const TABLE = String.raw`(?:only\s+)?"?[a-z_][a-z0-9_]*"?\."?[a-z_]`;
const TABLE_STATEMENT = new RegExp([
  String.raw`\bselect\b[\s\S]{0,400}?\bfrom\s+${TABLE}`,
  String.raw`\binsert\s+into\s+${TABLE}`,
  String.raw`\bupdate\s+${TABLE}[\w"]*\s+(?:as\s+\w+\s+)?set\b`,
  String.raw`\bdelete\s+from\s+${TABLE}`,
  String.raw`\bmerge\s+into\s+${TABLE}`,
  String.raw`\btruncate\s+(?:table\s+)?${TABLE}`,
  String.raw`\b(?:create|alter|drop)\s+(?:table|index|view|function|policy|trigger|schema)\b`,
  String.raw`\bwith\s+(?:recursive\s+)?["a-z_]\w*\s+as\s*\(`,
].join('|'), 'i');
// SQL assembled at run time: a template with interpolations shaped like a statement.
const DYNAMIC_STATEMENT = /\bselect\b[\s\S]*\bfrom\b|\binsert\s+into\b|\bupdate\b[\s\S]*\bset\b|\bdelete\s+from\b|\bmerge\s+into\b/i;
// In SQL_MODULES, text that starts like a statement, or interpolated text with a clause.
const STATEMENT_START = /^\s*(?:select|insert|update|delete|merge|with|create|alter|drop|truncate|grant|call|exec)\b/i;
const CLAUSE = /\b(?:select|from|where|join|group\s+by|order\s+by|having|values|returning|limit|offset|set|into)\b/i;

const inAny = (file: string, prefixes: readonly string[]): boolean => prefixes.some((p) => file.startsWith(p) || file === p);

export function sqlViolations(file: string, source: string): string[] {
  if (inAny(file, SQL_HOMES)) return [];
  const scanned = scan(source);
  const targets = imports(source).map((s) => resolveImport(file, s));
  const out: string[] = [];

  if (inAny(file, SQL_MODULES)) {
    for (const target of targets) {
      if (DRIVERS.includes(target)) out.push(`${file}: imports the driver ${target} (use a connect-runtime connection)`);
      if (inAny(target, SILO_DATABASE)) out.push(`${file}: imports ${target}, which reaches Silo's own database`);
    }
    for (const literal of scanned.literals) {
      if (literal.tag === 'sql') continue;
      if (STATEMENT_START.test(literal.text) || (literal.interpolated && CLAUSE.test(literal.text))) {
        out.push(`${file}: SQL outside the sql tag (build it with sql\`...\`)`);
      }
    }
    if (/(['"`])\s*\+|\+\s*['"`]/.test(scanned.blank)) out.push(`${file}: string concatenation (build SQL with the sql tag)`);
    if (/(?<!\bsql)\.join\s*\(/.test(scanned.blank)) out.push(`${file}: .join() (use sql.join)`);
    return out;
  }

  if (file !== SQL_BUILDER && targets.includes(SQL_BUILDER)) {
    out.push(`${file}: imports the SQL builder, which only the protocol engines and the warehouse generator may use`);
  }
  for (const literal of scanned.literals) {
    if (TABLE_STATEMENT.test(literal.text)) out.push(`${file}: a SQL statement (move it to a repo)`);
    else if (literal.interpolated && literal.kind === 'template' && DYNAMIC_STATEMENT.test(literal.text)) {
      out.push(`${file}: SQL built at run time (only the protocol engines and the warehouse generator build SQL)`);
    }
  }
  if (file === WAREHOUSE_ADAPTER) {
    // The BigQuery client, and nothing else of a database's.
    for (const target of targets) {
      if (DRIVERS.includes(target) && target !== '@google-cloud/bigquery') out.push(`${file}: imports the driver ${target}`);
      if (inAny(target, SILO_DATABASE)) out.push(`${file}: imports ${target}, which reaches Silo's own database`);
    }
  } else if (file !== TRANSACTION_MECHANISM) {
    if (targets.some((t) => DRIVERS.includes(t))) out.push(`${file}: imports a database driver (use a repo)`);
    if (/\.query\s*\(/.test(scanned.code)) out.push(`${file}: calls .query() (use a repo)`);
  }
  return out;
}

describe('where SQL may be written', () => {
  test('SQL lives only in models and repos: no service holds SQL', () => {
    assert.deepEqual(all.flatMap(({ file, source }) => sqlViolations(file, source)), []);
  });

  test('catches a statement, a driver and .query() outside repos, and lets prose through', () => {
    const service = 'services/auth/login.service.ts';
    assert.equal(sqlViolations(service, "import pg from 'pg';\nconst q = db.query(`select id\n  from iam.users where id = $1`);").length, 3);
    assert.equal(sqlViolations(service, "const q = 'insert into audit.auth_events (id) values ($1)';").length, 1);
    assert.equal(sqlViolations(service, "const q = 'update iam.organisations set name = $2';").length, 1);
    assert.equal(sqlViolations(service, 'const q = `with recent as (select 1) select * from recent`;').length, 1);
    assert.equal(sqlViolations('services/executor/run.service.ts', 'const q = `select * from ${table} where id = ${id}`;').length, 1);
    for (const prose of ["const m = 'select a period from the list';", "const k = z.enum(['select', 'delete']);",
      "const m = 'failed to update the cache';", '// select id from iam.users is the shape', 'const m = `found ${n} rows`;']) {
      assert.deepEqual(sqlViolations(service, prose), [], prose);
    }
    assert.equal(sqlViolations(service, "import { sql } from '../../utils/sqlBuilder.util.ts';").length, 1, 'the builder is not for services');
    assert.deepEqual(sqlViolations('repos/iam/user.repo.ts', "db.query('select id from iam.users');"), []);
  });

  test('a protocol engine builds SQL only with the sql tag, and never reaches Silo\'s database', () => {
    const engine = 'services/connect-runtime/protocols/sql/read.protocol.ts';
    const good = [
      "import { ident, keyword, sql } from '../../../../utils/sqlBuilder.util.ts';",
      'const q = sql`select ${ident(column)} from ${ident(schema, table)} where ${ident(key)} = ${value} order by ${ident(sort)} ${keyword(direction)}`;',
      'const where = sql.join(conditions, sql` and `);',
      "const columns = sql`select * from information_schema.columns where table_name = ${table}`;",
      "throw new AppError('bounds', 'the step reads more rows than its limit');",
    ].join('\n');
    assert.deepEqual(sqlViolations(engine, good), []);
    assert.equal(sqlViolations(engine, 'const q = `select * from ${table}`;').length, 1, 'untagged');
    assert.ok(sqlViolations(engine, "const q = 'select ' + column + ' from t';").length >= 1, 'concatenation');
    assert.equal(sqlViolations(engine, "const where = conditions.join(' and ');").length, 1, 'join');
    assert.equal(sqlViolations(engine, "import pg from 'pg';").length, 1, 'driver');
    assert.equal(sqlViolations(engine, "import { userRepo } from '../../../../repos/iam/index.repo.ts';").length, 1, 'Silo database');
    assert.equal(sqlViolations(engine, "import { inTransaction } from '../../../../infra/postgres.infra.ts';").length, 1);
    assert.deepEqual(sqlViolations('services/warehouse-schema/generator/table.generator.ts',
      'const ddl = sql`create table ${ident(dataset, name)} (${columns})`;'), []);
  });

  test('the warehouse adapter runs what it is given: the BigQuery client, no statement, no Silo database', () => {
    const adapter = 'infra/bigquery.infra.ts';
    const good = [
      "import { BigQuery } from '@google-cloud/bigquery';",
      'const [rows] = await client.query({ query: statement.text, params: statement.values });',
    ].join('\n');
    assert.deepEqual(sqlViolations(adapter, good), []);
    assert.equal(sqlViolations(adapter, "const q = 'select id from silo.objects';").length, 1, 'a statement of its own');
    assert.equal(sqlViolations(adapter, "import pg from 'pg';").length, 1, 'another driver');
    assert.equal(sqlViolations(adapter, "import { userRepo } from '../repos/iam/index.repo.ts';").length, 1, 'Silo database');
    assert.equal(sqlViolations('infra/storage.infra.ts', "import { BigQuery } from '@google-cloud/bigquery';").length, 1, 'anywhere else');
  });
});
