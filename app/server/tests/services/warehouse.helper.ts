// A BigQuery stand-in for the Warehouse, Import and Object Index tests: no emulator runs on
// every machine, so this fake implements the adapter interface in memory and answers exactly
// the statement shapes the generators render (create, alter, merge, insert, delete, update,
// the reads and the index search). It records every call and statement, can fail one named
// operation once, and holds job statistics and storage sizes a test sets for metering.

import type { BigQueryAdapter, DatasetRef, JobStatistic, QueryOutcome, TableInfo, WarehouseStatement } from '../../src/infra/bigquery.infra.ts';
import { AppError } from '../../src/utils/errors.util.ts';

interface FakeTable {
  columns: { name: string; type: string; mode: 'NULLABLE' | 'REQUIRED' | 'REPEATED' }[];
  /** Keyed rows: current tables and index entries, by their key column. */
  rows: Map<string, Record<string, unknown>>;
  /** Appended rows: history rows and loaded Import rows. */
  appended: Record<string, unknown>[];
}

export interface FakeBigQuery extends BigQueryAdapter {
  calls: { method: string; args: unknown[] }[];
  statements: WarehouseStatement[];
  projects: Set<string>;
  moved: Map<string, string>;
  datasets: Map<string, { kmsKeyRef: string | null; maxTimeTravelHours: number | null }>;
  access: { dataset: string; member: string; role: string }[];
  jobUsers: { projectId: string; member: string }[];
  tables: Map<string, FakeTable>;
  /** Job statistics jobStatistics answers with, by project. */
  jobs: JobStatistic[];
  /** Logical bytes storage() answers with, by dataset name. */
  storageBytes: Map<string, number>;
  failNext(method: string): void;
  table(name: string): FakeTable | undefined;
}

const API_TYPE: Record<string, string> = { INT64: 'INTEGER', BOOL: 'BOOLEAN' };
const TABLE = /`([^`]+)`\.`([^`]+)`\.`([^`]+)`/;

function parseColumns(list: string): FakeTable['columns'] {
  return [...list.matchAll(/`([^`]+)` (ARRAY<STRING>|[A-Z0-9]+)( NOT NULL)?/g)].map((m) => m[2] === 'ARRAY<STRING>'
    ? { name: m[1]!, type: 'STRING', mode: 'REPEATED' as const }
    : { name: m[1]!, type: API_TYPE[m[2]!] ?? m[2]!, mode: m[3] ? 'REQUIRED' as const : 'NULLABLE' as const });
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
const param = (s: WarehouseStatement, n: string): unknown => s.values[Number(n) - 1];
const time = (v: unknown): number => Date.parse(String(v));

const order = (a: unknown, b: unknown): number => (typeof a === 'number' && typeof b === 'number' ? a - b
  : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/** One filter test of a generated statement (`_f<i>`), evaluated on a row as BigQuery would, null failing. */
function predicateOf(s: WarehouseStatement, pred: string): (row: Record<string, unknown>) => boolean {
  let x: RegExpExecArray | null;
  if ((x = /^`([^`]+)` is null and not /.exec(pred))) {
    const column = x[1]!;
    const disputed = pred.includes('__state` = \'disputed\'') ? (row: Record<string, unknown>) => row[`${column}__state`] === 'disputed'
      : (row: Record<string, unknown>) => row[`${column}__disputed`] === true;
    return (row) => (row[column] ?? null) === null && !disputed(row);
  }
  if ((x = /^`([^`]+)` is null$/.exec(pred))) { const column = x[1]!; return (row) => (row[column] ?? null) === null; }
  if ((x = /^`([^`]+)` is not null$/.exec(pred))) { const column = x[1]!; return (row) => (row[column] ?? null) !== null; }
  if ((x = /^`([^`]+)` in unnest\(@p(\d+)\)$/.exec(pred))) {
    const column = x[1]!;
    const list = (param(s, x[2]!) as unknown[]).map(String);
    return (row) => row[column] !== null && row[column] !== undefined && list.includes(String(row[column]));
  }
  x = /^`([^`]+)` (=|!=|<=|>=|<|>) @p(\d+)$/.exec(pred)!;
  const [column, op, target] = [x[1]!, x[2]!, param(s, x[3]!)];
  return (row) => {
    const v = row[column];
    if (v === null || v === undefined) return false;
    const c = order(v, target);
    return { '=': c === 0, '!=': c !== 0, '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0 }[op]!;
  };
}

/**
 * A generated statement's filters: each test, and whether a row's value is disputed (the
 * Warehouse's dispute flag, the Index's state, or never where neither is recorded).
 */
const filtersOf = (s: WarehouseStatement, text: string) =>
  [...text.matchAll(/, coalesce\(\((.*?)\), false\) as `_f\d+`, (?:coalesce\(`([^`]+)__disputed`, false\)|coalesce\(`([^`]+)__state` = 'disputed', false\)|false) as `_d\d+`/g)]
    .map((m) => ({
      met: predicateOf(s, m[1]!),
      disputed: (row: Record<string, unknown>) => (m[2] !== undefined ? row[`${m[2]}__disputed`] === true : m[3] !== undefined ? row[`${m[3]}__state`] === 'disputed' : false),
    }));

/** The where clause of the shapes the generators render: conditions joined by and, one bracketed or. */
function matcher(where: string, s: WarehouseStatement): (row: Record<string, unknown>) => boolean {
  const conditions = where.split(/ and (?![^(]*\))/).map((c) => c.trim());
  const one = (c: string): ((row: Record<string, unknown>) => boolean) => {
    if (c.startsWith('(') && c.endsWith(')')) {
      const parts = c.slice(1, -1).split(' or ').map(one);
      return (row) => parts.some((p) => p(row));
    }
    let m = /^`([^`]+)` in unnest\(@p(\d+)\)$/.exec(c);
    if (m) { const col = m[1]!; const set = new Set((param(s, m[2]!) as unknown[]).map(String)); return (row) => set.has(String(row[col])); }
    // The SQL builder's list, one parameter a value (a Silo store read by key).
    m = /^`([^`]+)` in \((@p\d+(?:, @p\d+)*)\)$/.exec(c);
    if (m) {
      const col = m[1]!;
      const set = new Set(m[2]!.split(', ').map((ref) => String(param(s, ref.slice(2)))));
      return (row) => row[col] !== null && row[col] !== undefined && set.has(String(row[col]));
    }
    m = /^`([^`]+)` is not null$/.exec(c);
    if (m) { const col = m[1]!; return (row) => row[col] !== null && row[col] !== undefined; }
    m = /^`([^`]+)` (=|<>|<|>=) @p(\d+)$/.exec(c);
    if (m) {
      const [, col, op, n] = m;
      const value = param(s, n!);
      if (op === '<') return (row) => time(row[col!]) < time(value);
      if (op === '>=') return (row) => time(row[col!]) >= time(value);
      const equal = (row: Record<string, unknown>) => (col!.endsWith('_at') ? time(row[col!]) === time(value) : String(row[col!]) === String(value));
      return op === '=' ? equal : (row) => !equal(row);
    }
    throw new Error(`fake BigQuery: unknown condition ${c}`);
  };
  const all = conditions.map(one);
  return (row) => all.every((p) => p(row));
}

export function createFakeBigQuery(location = 'europe-west2'): FakeBigQuery {
  const failing = new Set<string>();
  const tables = new Map<string, FakeTable>();
  const loadJobs = new Map<string, number>();
  const key = (ref: DatasetRef, table: string) => `${ref.dataset}.${table}`;
  const fake: FakeBigQuery = {
    location, calls: [], statements: [], projects: new Set(), moved: new Map(), datasets: new Map(), access: [], jobUsers: [], tables, jobs: [],
    storageBytes: new Map(),
    failNext(method) { failing.add(method); },
    table(name) { return [...tables.entries()].find(([k]) => k.endsWith(`.${name}`))?.[1]; },

    async ensureProject(input) { record('ensureProject', input); const created = !fake.projects.has(input.projectId); fake.projects.add(input.projectId); return { created }; },
    async deleteProject(projectId) { record('deleteProject', projectId); return { deleted: fake.projects.delete(projectId) }; },
    async moveProject(projectId, parent) { record('moveProject', projectId, parent); fake.moved.set(projectId, parent); },
    async grantJobUser(projectId, member) { record('grantJobUser', projectId, member); fake.jobUsers.push({ projectId, member }); },
    async revokeJobUser(projectId, member) {
      record('revokeJobUser', projectId, member);
      fake.jobUsers = fake.jobUsers.filter((j) => !(j.projectId === projectId && j.member === member));
    },
    async ensureKey(input) { record('ensureKey', input); return { keyRef: `projects/silo-test-proj/locations/${location}/keyRings/${input.keyRing}/cryptoKeys/${input.key}`, created: true }; },
    async destroyKey(keyRef) { record('destroyKey', keyRef); },
    async ensureDataset(ref, input) {
      record('ensureDataset', ref, input);
      const k = `${ref.projectId}.${ref.dataset}`;
      const created = !fake.datasets.has(k);
      if (created) fake.datasets.set(k, { kmsKeyRef: input.kmsKeyRef ?? null, maxTimeTravelHours: input.maxTimeTravelHours ?? null });
      return { created };
    },
    async getDataset(ref) {
      const d = fake.datasets.get(`${ref.projectId}.${ref.dataset}`);
      return d && { location, kmsKeyRef: d.kmsKeyRef, maxTimeTravelHours: d.maxTimeTravelHours };
    },
    async setDatasetKey(ref, kmsKeyRef) { record('setDatasetKey', ref, kmsKeyRef); fake.datasets.get(`${ref.projectId}.${ref.dataset}`)!.kmsKeyRef = kmsKeyRef; },
    async deleteDataset(ref) {
      record('deleteDataset', ref);
      for (const k of [...tables.keys()]) if (k.startsWith(`${ref.dataset}.`)) tables.delete(k);
      return { deleted: fake.datasets.delete(`${ref.projectId}.${ref.dataset}`) };
    },
    async grantDatasetAccess(ref, member, role) {
      record('grantDatasetAccess', ref, member, role);
      fake.access = fake.access.filter((a) => !(a.dataset === ref.dataset && a.member === member));
      fake.access.push({ dataset: ref.dataset, member, role });
    },
    async revokeDatasetAccess(ref, member) {
      record('revokeDatasetAccess', ref, member);
      fake.access = fake.access.filter((a) => !(a.dataset === ref.dataset && a.member === member));
    },
    async listDatasetAccess() { return fake.access.map((a) => ({ member: a.member, role: a.role as 'reader' | 'writer' })); },
    async getTable(ref): Promise<TableInfo | undefined> {
      const t = tables.get(key(ref, ref.table));
      return t && { columns: t.columns.map((c) => ({ ...c })), rows: t.rows.size + t.appended.length, bytes: 0 };
    },
    async listTables(ref) { return [...tables.keys()].filter((k) => k.startsWith(`${ref.dataset}.`)).map((k) => k.slice(ref.dataset.length + 1)); },
    async dryRun() { return { bytesProcessed: 0 }; },
    async run(ref, statement) {
      record('run', statement.text.slice(0, 40));
      fake.statements.push(statement);
      return execute(ref, statement);
    },
    async loadRows(ref, input) {
      record('loadRows', ref, input.jobId);
      const done = loadJobs.get(input.jobId);
      if (done !== undefined) return { jobId: input.jobId, rowsLoaded: done, replayed: true };
      const t = tables.get(key(ref, ref.table));
      if (t === undefined) throw new AppError('not_found', 'fake BigQuery: no table to load', { code: 'bigquery.not_found' });
      t.appended.push(...input.rows.map((r) => ({ ...r })));
      loadJobs.set(input.jobId, input.rows.length);
      return { jobId: input.jobId, rowsLoaded: input.rows.length, replayed: false };
    },
    async loadFromStorage() { return { jobId: 'job-load' }; },
    async exportTable(ref, input) { record('exportTable', ref, input); return { jobId: `job-export-${ref.table}` }; },
    async jobStatus() { return { state: 'done', failed: false }; },
    async jobStatistics(input) {
      record('jobStatistics', input);
      return fake.jobs.filter((j) => j.projectId === input.projectId && time(j.createdAt) >= time(input.since) && time(j.createdAt) <= time(input.until));
    },
    async storage(ref) { return { logicalBytes: fake.storageBytes.get(ref.dataset) ?? 0, physicalBytes: 0, tables: tables.size }; },
    async close() { /* nothing held */ },
  };

  function record(method: string, ...args: unknown[]): void {
    fake.calls.push({ method, args });
    if (failing.delete(method)) throw new AppError('upstream', `${method} failed (test)`, { code: 'bigquery.test_failure' });
  }

  function execute(ref: DatasetRef, s: WarehouseStatement): QueryOutcome {
    const outcome = (rows: Record<string, unknown>[], affected: number | null = null): QueryOutcome =>
      ({ jobId: `job-${fake.statements.length}`, rows, affectedRows: affected, bytesProcessed: 10, bytesBilled: 10, cacheHit: false });
    const text = flat(s.text);
    // The SQL engine names a Silo table by dataset and table, in the job's project (66.5).
    const name = TABLE.exec(text)?.[3] ?? / from `[^`]+`\.`([^`]+)`/.exec(text)?.[1];
    if (name === undefined) throw new Error(`fake BigQuery: no table in ${text}`);
    const k = key(ref, name);
    if (text.startsWith('create table if not exists')) {
      if (!tables.has(k)) tables.set(k, { columns: parseColumns(text.slice(text.indexOf('(') + 1)), rows: new Map(), appended: [] });
      return outcome([]);
    }
    if (text.startsWith('drop table if exists')) {
      tables.delete(k);
      return outcome([]);
    }
    const t = tables.get(k);
    if (t === undefined) throw new AppError('not_found', `fake BigQuery: no table ${name}`, { code: 'bigquery.not_found' });
    if (text.startsWith('alter table')) {
      for (const m of text.matchAll(/drop column if exists `([^`]+)`/g)) {
        t.columns = t.columns.filter((c) => c.name !== m[1]);
        for (const row of [...t.rows.values(), ...t.appended]) delete row[m[1]!];
      }
      for (const c of parseColumns(text.replace(/drop column if exists `[^`]+`/g, ''))) if (!t.columns.some((x) => x.name === c.name)) t.columns.push(c);
      return outcome([]);
    }
    if (text.startsWith('merge')) {
      const on = /on t\.`([^`]+)` = s\.`([^`]+)`/.exec(text)!;
      // An index entry's value from a change stream: one column set on entries that exist, the row hash cleared.
      const valueOnly = /when matched then update set `([^`]+)` = s\.`value`, `_row_hash` = null$/.exec(text);
      let n = 0;
      for (const row of s.values[0] as Record<string, unknown>[]) {
        const key = String(row[on[2]!]);
        const before = t.rows.get(key);
        if (valueOnly) {
          if (before !== undefined) { t.rows.set(key, { ...before, [valueOnly[1]!]: row['value'], _row_hash: null }); n += 1; }
          continue;
        }
        // As BigQuery's MERGE: a matched row takes only the columns its update sets, and keeps the rest.
        if (before !== undefined) {
          const set = /when matched then update set ([\s\S]*?) when not matched/.exec(text);
          const names = set === null ? Object.keys(row) : [...set[1]!.matchAll(/`([^`]+)` = s\./g)].map((m) => m[1]!);
          t.rows.set(key, { ...before, ...Object.fromEntries(names.filter((name) => name in row).map((name) => [name, row[name]])) });
        } else {
          t.rows.set(key, { ...row });
        }
        n += 1;
      }
      return outcome([], n);
    }
    if (text.startsWith('truncate table')) {
      t.rows.clear();
      t.appended = [];
      return outcome([]);
    }
    if (text.startsWith('insert into')) {
      t.appended.push(...(s.values[0] as Record<string, unknown>[]));
      return outcome([], (s.values[0] as unknown[]).length);
    }
    if (text.startsWith('delete from')) {
      const keep = matcher(text.slice(text.indexOf(' where ') + 7), s);
      let deleted = 0;
      for (const [rowKey, row] of t.rows) if (keep(row)) { t.rows.delete(rowKey); deleted += 1; }
      const before = t.appended.length;
      t.appended = t.appended.filter((row) => !keep(row));
      return outcome([], deleted + before - t.appended.length);
    }
    if (text.startsWith('update')) {
      const set = /set `([^`]+)` = (@p(\d+)|null) where (.*)$/.exec(text)!;
      const match = matcher(set[4]!, s);
      let updated = 0;
      for (const row of [...t.rows.values(), ...t.appended]) if (match(row)) { row[set[1]!] = set[2] === 'null' ? null : param(s, set[3]!); updated += 1; }
      return outcome([], updated);
    }
    if (text.startsWith('select count(*)')) return outcome([{ n: t.rows.size + t.appended.length }]);
    if (text.startsWith('select to_json_string(t) as `row`')) {
      const after = String(s.values[0]);
      const found = [...t.rows.values()].filter((row) => String(row['_object_ref']) > after)
        .sort((a, b) => String(a['_object_ref']).localeCompare(String(b['_object_ref']))).slice(0, Number(s.values[1]));
      return outcome(found.map((row) => ({ row: JSON.stringify(row), key: row['_object_ref'] })));
    }
    if (text.includes('contains_substr(')) {
      const column = /contains_substr\(`([^`]+)`, @p1\)/.exec(text)![1]!;
      const needle = String(s.values[0]).toLowerCase();
      const satisfied = new Set((s.values[1] as string[]).map(String));
      const limit = Number(s.values[2]);
      const found = [...t.rows.values()].filter((row) => row[column] !== null && row[column] !== undefined
        && String(row[column]).toLowerCase().includes(needle)
        && [...(row['_marking_ids'] as string[] ?? []), ...(row[`${column}__marking_ids`] as string[] ?? [])].every((m) => satisfied.has(m)));
      found.sort((a, b) => String(a['_object_ref']).localeCompare(String(b['_object_ref'])));
      return outcome(found.slice(0, limit).map((row) => ({ _object_ref: row['_object_ref'], value: JSON.stringify(row[column]), refreshed_at: row['_refreshed_at'] })));
    }
    // A large aggregate over the Warehouse's current table (69.6), with the engine's rules for disputes.
    if (text.startsWith('with f as (select *') && text.includes('as `_state`')) {
      // Across one link (D116): the far side's measures over each group's distinct linked objects.
      const joined = / a as \(select /.test(text);
      const linkName = /join (?:`[^`]+`\.)+`([^`]+)` l on/.exec(text)?.[1];
      const targetName = /join (?:`[^`]+`\.)+`([^`]+)` t on/.exec(text)?.[1];
      const reverse = text.includes('l.`to_object_id` = r.`silo_object_id`');
      const linkTable = joined ? tables.get(key(ref, linkName!)) : undefined;
      const targetTable = joined ? tables.get(key(ref, targetName!)) : undefined;
      const farColumn = new Map([...text.matchAll(/t\.`([^`]+)` as `_c(\d+)`/g)].map((m) => [m[2]!, m[1]!]));
      const farIndexes = [...new Set([...text.matchAll(/as `_l(\d+)(?:_all|_n)?`/g)].map((m) => m[1]!))];
      const disputed = (row: Record<string, unknown>, c: string) => row[`${c}__disputed`] === true;
      const filters = filtersOf(s, text);
      const keys = [...text.matchAll(/if\(`_state` = 'ok', `([^`]+)`, null\)\) as `_k\d+`/g)].map((m) => m[1]!);
      const measures = [...text.matchAll(/countif\(`([^`]+)` is not null\) as `_m(\d+)_n`(?:, (count\(distinct|to_json_string\(sum|to_json_string\(min|to_json_string\(max)\(?`[^`]+`\)\)? as `_m\d+`)?/g)]
        .map((m) => ({ column: m[1]!, index: m[2]!, fn: m[3] === undefined ? 'count' : m[3].replace('to_json_string(', '').replace('count(distinct', 'count_distinct') }));
      const counted = [...text.matchAll(/countif\(`([^`]+)` is not null\) as `_v(\d+)`/g)].map((m) => m[1]!);
      const groups = new Map<string, { state: string; key: unknown[]; rows: Record<string, unknown>[] }>();
      for (const row of t.rows.values()) {
        const met = filters.map((f) => f.met(row));
        const passes = met.every(Boolean);
        const filterDisputed = filters.some((f, i) => f.disputed(row) && met.slice(0, i).every(Boolean));
        if (!passes && !filterDisputed) continue;
        const state = filterDisputed ? 'filter' : keys.some((k) => disputed(row, k)) ? 'key' : 'ok';
        const key = keys.map((k) => (state === 'ok' ? row[k] ?? null : null));
        const id = JSON.stringify([state, key]);
        const group = groups.get(id) ?? { state, key, rows: [] };
        group.rows.push(row);
        groups.set(id, group);
      }
      const json = (v: unknown) => (v === null || v === undefined ? 'null' : JSON.stringify(v));
      const out = [...groups.values()].sort((a, b) => a.state.localeCompare(b.state) || JSON.stringify(a.key).localeCompare(JSON.stringify(b.key))).map((g) => {
        const row: Record<string, unknown> = { _state: g.state, _rows: g.rows.length };
        g.key.forEach((v, i) => { row[`_k${i}`] = json(v); });
        for (const m of measures) {
          const values = g.rows.map((r) => r[m.column]).filter((v) => v !== null && v !== undefined);
          row[`_m${m.index}_n`] = values.length;
          if (m.fn === 'count_distinct') row[`_m${m.index}`] = new Set(values.map((v) => JSON.stringify(v))).size;
          if (m.fn === 'sum') row[`_m${m.index}`] = values.length === 0 ? 'null' : json((values as number[]).reduce((a, b) => a + b, 0));
          if (m.fn === 'min' || m.fn === 'max') {
            const sorted = [...values].sort(order);
            row[`_m${m.index}`] = json(m.fn === 'min' ? sorted[0] : sorted.at(-1));
          }
        }
        counted.forEach((c, i) => {
          row[`_v${i}`] = g.rows.filter((r) => r[c] !== null && r[c] !== undefined).length;
          row[`_w${i}`] = g.rows.filter((r) => disputed(r, c)).length;
        });
        if (joined) {
          const links = [...linkTable!.rows.values(), ...linkTable!.appended];
          const near = reverse ? 'to_object_id' : 'from_object_id';
          const far = reverse ? 'from_object_id' : 'to_object_id';
          const ids = new Set(g.rows.map((r) => String(r['silo_object_id'])));
          const linkedIds = [...new Set(links.filter((l) => ids.has(String(l[near]))).map((l) => String(l[far])))];
          const linked = linkedIds.map((id) => targetTable!.rows.get(id)).filter((r): r is Record<string, unknown> => r !== undefined);
          for (const i of farIndexes) {
            const column = farColumn.get(i);
            if (column === undefined) { row[`_l${i}`] = linked.length; continue; }
            const values = linked.map((r) => r[column]).filter((v) => v !== null && v !== undefined);
            row[`_l${i}_all`] = linked.length;
            row[`_l${i}_n`] = values.length;
            if (text.includes(`count(distinct \`_c${i}\`)`)) row[`_l${i}`] = new Set(values.map((v) => JSON.stringify(v))).size;
            else if (text.includes(`sum(\`_c${i}\`)`)) row[`_l${i}`] = values.length === 0 ? 'null' : json((values as number[]).reduce((a, b) => a + b, 0));
            else if (text.includes(`min(\`_c${i}\`)`) || text.includes(`max(\`_c${i}\`)`)) {
              const sorted = [...values].sort(order);
              row[`_l${i}`] = json(text.includes(`min(\`_c${i}\`)`) ? sorted[0] : sorted.at(-1));
            }
          }
        }
        return row;
      });
      return outcome(out.slice(0, Number(s.values.at(-1))));
    }
    // The Warehouse as of an instant (69.6): the objects first observed by then, each value as JSON text with its dispute flag.
    if (text.startsWith('select `silo_object_id`, to_json_string(') && text.includes('`_first_observed_at` is null or')) {
      const columns = [...text.matchAll(/to_json_string\(`([^`]+)`\) as `([^`]+)`/g)].map((m) => m[1]!);
      const json = new Set(t.columns.filter((c) => c.type === 'JSON').map((c) => c.name));
      const at = time(s.values[0]);
      const limit = Number(s.values[1]);
      return outcome([...t.rows.entries()]
        .filter(([, row]) => row['_first_observed_at'] === null || row['_first_observed_at'] === undefined || time(row['_first_observed_at']) <= at)
        .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)
        .map(([id, row]) => Object.fromEntries([['silo_object_id', id], ...columns.flatMap((c) => [
          [c, row[c] === null || row[c] === undefined ? null : json.has(c) ? row[c] : JSON.stringify(row[c])], [`${c}__disputed`, row[`${c}__disputed`] ?? null]])])));
    }
    // Every change in a half-open period to the properties of the objects asked about, oldest first (69.16).
    if (text.startsWith('select `silo_object_id`, `property`, `observed_at`, to_json_string(`previous_value`)')) {
      const [from, to] = [time(s.values[0]), time(s.values[1])];
      const properties = new Set(s.values[2] as string[]);
      const ids = new Set(s.values[3] as string[]);
      const limit = Number(s.values[4]);
      const rows = t.appended.filter((row) => time(row['observed_at']) >= from && time(row['observed_at']) < to
        && properties.has(String(row['property'])) && ids.has(String(row['silo_object_id'])))
        .sort((a, b) => String(a['silo_object_id']).localeCompare(String(b['silo_object_id'])) || String(a['property']).localeCompare(String(b['property']))
          || time(a['observed_at']) - time(b['observed_at']))
        .slice(0, limit);
      return outcome(rows.map((row) => ({
        silo_object_id: row['silo_object_id'], property: row['property'], observed_at: row['observed_at'],
        previous_value: row['previous_value'] ?? null, new_value: row['new_value'] ?? null,
      })));
    }
    // The first change after an instant to each property of each object asked about (69.6).
    if (text.startsWith('select `silo_object_id`, `property`, to_json_string(`previous_value`)')) {
      const at = time(s.values[0]);
      const properties = new Set(s.values[1] as string[]);
      const ids = new Set(s.values[2] as string[]);
      const first = new Map<string, Record<string, unknown>>();
      for (const row of [...t.appended].sort((a, b) => time(a['observed_at']) - time(b['observed_at']))) {
        const k = `${String(row['silo_object_id'])}\u0000${String(row['property'])}`;
        if (time(row['observed_at']) > at && properties.has(String(row['property'])) && ids.has(String(row['silo_object_id'])) && !first.has(k)) first.set(k, row);
      }
      return outcome([...first.values()].map((row) => ({ silo_object_id: row['silo_object_id'], property: row['property'], previous_value: row['previous_value'] ?? null })));
    }
    if (text.startsWith('select `silo_object_id`, to_json_string(')) {
      const columns = [...text.matchAll(/to_json_string\(`([^`]+)`\)/g)].map((m) => m[1]!);
      const json = new Set(t.columns.filter((c) => c.type === 'JSON').map((c) => c.name));
      return outcome((s.values[0] as string[]).flatMap((id) => {
        const row = t.rows.get(id);
        if (row === undefined) return [];
        return [Object.fromEntries([['silo_object_id', id], ...columns.map((c) => [c,
          row[c] === null || row[c] === undefined ? null : json.has(c) ? row[c] : JSON.stringify(row[c])])])];
      }));
    }
    // The planner's read of an Object Index (69.6): filters with the engine's dispute rules, a split plan's keys, every marking satisfied.
    if (text.startsWith('with f as (select *') && text.includes('as `_excluded`')) {
      const select = [...text.matchAll(/to_json_string\(`([^`]+)`\) as `([^`]+)`/g)].map((m) => m[1]!);
      const stated = [...text.matchAll(/, `([^`]+)__state` as `[^`]+__state`/g)].map((m) => m[1]!);
      const filters = filtersOf(s, text);
      const keyed = /`_object_ref` in unnest\(@p(\d+)\)/.exec(text);
      const keys = keyed === null ? undefined : new Set((param(s, keyed[1]!) as unknown[]).map(String));
      const marked = [.../array_concat\(([\s\S]*?)\)\) m where/.exec(text)![1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
      const satisfied = new Set((param(s, /m not in unnest\(@p(\d+)\)/.exec(text)![1]!) as unknown[]).map(String));
      const limit = Number(param(s, /limit @p(\d+)$/.exec(text.trim())![1]!));
      const found: Record<string, unknown>[] = [];
      for (const row of [...t.rows.values()].sort((a, b) => String(a['_object_ref']).localeCompare(String(b['_object_ref'])))) {
        if (keys !== undefined && !keys.has(String(row['_object_ref']))) continue;
        if (!marked.flatMap((c) => (row[c] as string[] | undefined) ?? []).every((id) => satisfied.has(id))) continue;
        const met = filters.map((f) => f.met(row));
        const excluded = filters.some((f, i) => f.disputed(row) && met.slice(0, i).every(Boolean));
        if (!met.every(Boolean) && !excluded) continue;
        found.push(Object.fromEntries([['_object_ref', row['_object_ref']],
          ...select.map((c) => [c, row[c] === null || row[c] === undefined ? null : JSON.stringify(row[c])]),
          ...stated.map((c) => [`${c}__state`, row[`${c}__state`] ?? null]), ['_excluded', excluded], ['refreshed_at', row['_refreshed_at']]]));
      }
      return outcome(found.slice(0, limit));
    }
    // The SQL engine's read of a Silo table: aliased columns, its conditions, a limit.
    const engine = /^select ((?:`[^`]+` as `[^`]+`(?:, )?)+) from `[^`]+`\.`[^`]+`(?: where (.*?))?(?: limit @p(\d+))?$/.exec(text);
    if (engine) {
      const pairs = [...engine[1]!.matchAll(/`([^`]+)` as `([^`]+)`/g)].map((m) => [m[1]!, m[2]!] as const);
      const keep = engine[2] === undefined ? () => true : matcher(engine[2], s);
      const limit = engine[3] === undefined ? Infinity : Number(param(s, engine[3]));
      return outcome([...t.rows.values(), ...t.appended].filter(keep).slice(0, limit)
        .map((row) => Object.fromEntries(pairs.map(([column, alias]) => [alias, row[column] ?? null]))));
    }
    const listed = /^select ((?:`[^`]+`(?:, )?)+) from .* where `([^`]+)` in unnest\(@p1\)$/.exec(text);
    if (listed) {
      const columns = [...listed[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
      const wanted = new Set((s.values[0] as string[]).map(String));
      return outcome([...t.rows.values()].filter((row) => wanted.has(String(row[listed[2]!])))
        .map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null]))));
    }
    throw new Error(`fake BigQuery: unknown statement ${text.slice(0, 80)}`);
  }

  return fake;
}
