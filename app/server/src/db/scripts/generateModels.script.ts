// Generates one model file and one Zod schema file per table,
// src/models/<schema>/<name>.model.ts and src/schemas/<schema>/<name>.schema.ts, from the
// migrated cell and directory databases, and scaffolds one repo file per table,
// src/repos/<schema>/<name>.repo.ts, where none exists yet.
//
// Models and schemas are regenerated whole on every run: change the migration, then run
// this, never edit one. tests/db/models.test.ts fails when either no longer matches the
// database. Repos are written once and then belong to their authors: a run never
// overwrites one. Each schema folder also gets an index (index.model.ts,
// index.schema.ts, index.repo.ts), regenerated every run, so services import a schema in
// one line.
//
// What the catalog decides:
// - property types from column types; a text column whose check lists its values
//   becomes a union of those values;
// - New<Model>: the columns a service role may insert (column grants), optional where
//   the column has a default or allows null;
// - <Model>Changes: the columns a service role may update, less the key, the
//   organisation, created_at, updated_at and any column a freeze trigger never lets change;
// - the repo's methods: insert, update and remove only where some service role holds
//   that privilege, and one finder per primary or unique key, so every generated query
//   has an index behind it.
//
// Usage: npm run db:models   (uses CELL_MIGRATE_URL and DIRECTORY_MIGRATE_URL)

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { schemaFile } from './generateSchemas.script.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, '../../..');

// The roles services log in as (members of), per database.
const SERVICE_ROLES = {
  cell: ['silo_app', 'silo_auth', 'silo_audit_writer', 'silo_report', 'silo_credential', 'silo_outbox_relay'],
  directory: ['directory_writer', 'directory_reader', 'status_writer', 'fleet_writer'],
} as const;

// Plurals the suffix rules get wrong.
const SINGULAR: Record<string, string> = { siloes: 'silo', lenses: 'lens', field_aliases: 'field_alias', process_analyses: 'process_analysis' };
// Type names that would shadow a JavaScript global.
const TYPE_NAME: Record<string, string> = { 'ontology.functions': 'OntologyFunction' };

export interface GeneratedFile {
  /** Relative to app/server. */
  path: string;
  content: string;
}

interface Column {
  name: string;
  property: string;
  type: string;
  pgType: string;
  pgElement: string | null;
  typmod: number;
  /** Single-column check definitions, for the Zod schema. */
  checks: string[];
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
  comment: string | null;
  insertable: boolean;
  updatable: boolean;
}

interface UniqueKey {
  primary: boolean;
  columns: string[];
}

interface Table {
  schema: string;
  name: string;
  comment: string | null;
  rls: boolean;
  columns: Column[];
  keys: UniqueKey[];
  readers: string[];
  partialReaders: string[];
  writers: string[];
  deletable: boolean;
}

const camel = (snake: string): string => snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const pascal = (snake: string): string => camel(snake).replace(/^./, (c) => c.toUpperCase());

export function singular(table: string): string {
  if (SINGULAR[table]) return SINGULAR[table];
  if (table.endsWith('ies')) return `${table.slice(0, -3)}y`;
  if (/(ches|shes|xes|sses)$/.test(table)) return table.slice(0, -2);
  if (table.endsWith('s') && !table.endsWith('ss')) return table.slice(0, -1);
  return table;
}

const TS_TYPES: Record<string, string> = {
  bool: 'boolean', int2: 'number', int4: 'number', float4: 'number', float8: 'number',
  int8: 'string', numeric: 'string', text: 'string', varchar: 'string', bpchar: 'string', uuid: 'string',
  citext: 'string', ltree: 'string', name: 'string', date: 'string', interval: 'string', vector: 'string', cidr: 'string',
  timestamptz: 'string', bytea: 'Buffer', jsonb: 'JsonValue', json: 'JsonValue',
};

function tsType(typname: string, element: string | null): string {
  if (element !== null) {
    const inner = TS_TYPES[element];
    if (!inner) throw new Error(`no TypeScript type for array of ${element}`);
    return `${inner}[]`;
  }
  const mapped = TS_TYPES[typname];
  if (!mapped) throw new Error(`no TypeScript type for ${typname}`);
  return mapped;
}

// The values a single-column check allows: col = ANY (ARRAY[...]), col = '<value>', or
// for an array column col <@ ARRAY[...]. Anything else stays a plain type.
function checkedValues(column: string, definition: string): string[] | null {
  const withoutNullBranch = definition.replaceAll(`(${column} IS NULL) OR `, '');
  if (withoutNullBranch.includes(' OR ')) return null;
  const literals = (list: string): string[] =>
    [...list.matchAll(/'((?:[^']|'')*)'::[a-z ]+/g)].map((m) => m[1]!.replaceAll("''", "'"));
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const any = new RegExp(`\\(${escaped} = ANY \\(ARRAY\\[(.*?)\\]\\)\\)`).exec(withoutNullBranch);
  if (any) return literals(any[1]!);
  const contained = new RegExp(`\\(${escaped} <@ ARRAY\\[(.*?)\\]\\)`).exec(withoutNullBranch);
  if (contained) return literals(contained[1]!);
  const equal = new RegExp(`^CHECK \\(\\(${escaped} = ('(?:[^']|'')*'::[a-z ]+)\\)\\)$`).exec(withoutNullBranch);
  if (equal) return literals(equal[1]!);
  return null;
}

const union = (values: string[]): string => values.map((v) => `'${v.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`)
  .join(' | ');

async function readTables(client: pg.Client, roles: readonly string[]): Promise<{ tables: Table[]; skipped: string[] }> {
  const { rows: rels } = await client.query<{
    oid: number; schema: string; name: string; comment: string | null; rls: boolean;
    readers: string[]; partial_readers: string[]; writers: string[]; deleters: string[];
  }>(`
    select c.oid, n.nspname as schema, c.relname as name, obj_description(c.oid, 'pg_class') as comment,
           c.relrowsecurity as rls,
           array(select r from unnest($1::text[]) r where has_any_column_privilege(r, c.oid, 'SELECT')) as readers,
           array(select r from unnest($1::text[]) r
                 where has_any_column_privilege(r, c.oid, 'SELECT')
                   and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attnum > 0
                               and not a.attisdropped and not has_column_privilege(r, c.oid, a.attnum, 'SELECT')))
             as partial_readers,
           array(select r from unnest($1::text[]) r
                 where has_any_column_privilege(r, c.oid, 'INSERT') or has_any_column_privilege(r, c.oid, 'UPDATE')
                    or has_table_privilege(r, c.oid, 'DELETE')) as writers,
           array(select r from unnest($1::text[]) r where has_table_privilege(r, c.oid, 'DELETE')) as deleters
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and not c.relispartition
      and n.nspname not in ('pg_catalog', 'information_schema', 'public') and n.nspname !~ '^pg_'
    order by n.nspname, c.relname`, [roles]);
  const visible = rels.filter((r) => r.readers.length > 0);
  const skipped = rels.filter((r) => r.readers.length === 0).map((r) => `${r.schema}.${r.name}`);
  const oids = visible.map((r) => r.oid);

  const { rows: cols } = await client.query<{
    relid: number; name: string; typname: string; element: string | null; typmod: number; not_null: boolean;
    has_default: boolean; generated: boolean; comment: string | null; insertable: boolean; updatable: boolean;
  }>(`
    select a.attrelid as relid, a.attname as name, t.typname, et.typname as element, a.atttypmod as typmod,
           a.attnotnull as not_null,
           (a.atthasdef or a.attidentity <> '') as has_default,
           (a.attidentity = 'a' or a.attgenerated <> '') as generated,
           col_description(a.attrelid, a.attnum) as comment,
           exists (select 1 from unnest($2::text[]) r where has_column_privilege(r, a.attrelid, a.attnum, 'INSERT'))
             as insertable,
           exists (select 1 from unnest($2::text[]) r where has_column_privilege(r, a.attrelid, a.attnum, 'UPDATE'))
             as updatable
    from pg_attribute a
    join pg_type t on t.oid = a.atttypid
    left join pg_type et on et.oid = t.typelem and t.typcategory = 'A'
    where a.attrelid = any($1::oid[]) and a.attnum > 0 and not a.attisdropped
    order by a.attrelid, a.attnum`, [oids, roles]);

  const { rows: checks } = await client.query<{ relid: number; column: string; definition: string }>(`
    select con.conrelid as relid, a.attname as column, pg_get_constraintdef(con.oid) as definition
    from pg_constraint con
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
    where con.contype = 'c' and cardinality(con.conkey) = 1 and con.conrelid = any($1::oid[])
    order by con.conname`, [oids]);

  const { rows: keys } = await client.query<{ relid: number; primary: boolean; columns: string[] }>(`
    select i.indrelid as relid, i.indisprimary as primary,
           array(select a.attname from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
                 join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum order by k.ord)::text[] as columns
    from pg_index i join pg_class ic on ic.oid = i.indexrelid
    where i.indrelid = any($1::oid[]) and i.indisunique and i.indpred is null and i.indexprs is null
    order by i.indisprimary desc, ic.relname`, [oids]);

  const { rows: frozen } = await client.query<{ relid: number; definition: string }>(`
    select t.tgrelid as relid, pg_get_triggerdef(t.oid) as definition
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
    where pn.nspname = 'platform' and p.proname = 'freeze_columns' and t.tgqual is null
      and t.tgrelid = any($1::oid[])`, [oids]);

  const tables = visible.map((rel): Table => {
    const frozenColumns = new Set(frozen.filter((f) => f.relid === rel.oid).flatMap((f) =>
      [...(/freeze_columns\((.*)\)$/.exec(f.definition)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]!)));
    const tableKeys = keys.filter((k) => k.relid === rel.oid).map((k) => ({ primary: k.primary, columns: k.columns }));
    const primary = tableKeys.find((k) => k.primary)?.columns ?? [];
    const columns = cols.filter((c) => c.relid === rel.oid).map((c): Column => {
      let type = tsType(c.typname, c.element);
      const columnChecks = checks.filter((k) => k.relid === rel.oid && k.column === c.name);
      for (const check of columnChecks) {
        const values = checkedValues(c.name, check.definition);
        if (values && values.length > 0) type = c.element ? `(${union(values)})[]` : union(values);
      }
      return {
        name: c.name,
        property: camel(c.name),
        type,
        pgType: c.typname,
        pgElement: c.element,
        typmod: c.typmod,
        checks: columnChecks.map((k) => k.definition),
        notNull: c.not_null,
        hasDefault: c.has_default,
        generated: c.generated,
        comment: c.comment,
        insertable: c.insertable && !c.generated,
        updatable: c.updatable && !c.generated && !primary.includes(c.name) && !frozenColumns.has(c.name)
          && !['organisation_id', 'created_at', 'updated_at'].includes(c.name),
      };
    });
    return {
      schema: rel.schema, name: rel.name, comment: rel.comment, rls: rel.rls, columns, keys: tableKeys,
      readers: rel.readers.filter((r) => !rel.partial_readers.includes(r)), partialReaders: rel.partial_readers,
      writers: rel.writers, deletable: rel.deleters.length > 0,
    };
  });
  return { tables, skipped };
}

const doc = (text: string | null, indent: string): string[] => {
  if (!text) return [];
  const clean = text.replaceAll('*/', '* /').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && `${indent} * ${line} ${word}`.length > 100) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length === 1) return [`${indent}/** ${lines[0]} */`];
  return [`${indent}/**`, ...lines.map((l) => `${indent} * ${l}`), `${indent} */`];
};

function property(name: string, type: string, optional: boolean, indent: string): string[] {
  const line = `${indent}${name}${optional ? '?' : ''}: ${type};`;
  if (line.length <= 110 || !type.includes(' | ')) return [line];
  return [`${indent}${name}${optional ? '?' : ''}:`, ...type.split(' | ').map((v, i, all) =>
    `${indent}  | ${v}${i === all.length - 1 ? ';' : ''}`)];
}

interface Names {
  file: string;
  type: string;
  spec: string;
  repo: string;
}

function namesOf(table: Table): Names {
  const one = singular(table.name);
  const type = TYPE_NAME[`${table.schema}.${table.name}`] ?? pascal(one);
  return { file: camel(one), type, spec: `${camel(one)}Table`, repo: `${camel(one)}Repo` };
}

const primaryKey = (table: Table): string[] => table.keys.find((k) => k.primary)?.columns ?? [];
const canInsert = (table: Table): boolean => table.columns.some((c) => c.insertable);
const canUpdate = (table: Table): boolean => table.columns.some((c) => c.updatable);

function modelFile(table: Table): GeneratedFile {
  const n = namesOf(table);
  const pk = primaryKey(table);
  const lines: string[] = [
    `// ${table.schema}.${table.name}. Generated by npm run db:models from the migrated database; do not edit.`,
    '// Change the migration and regenerate.',
    '',
  ];
  const usesJson = table.columns.some((c) => c.type.includes('JsonValue'));
  lines.push(`import type { ${usesJson ? 'JsonValue, ' : ''}TableSpec } from '../table.model.ts';`, '');

  lines.push(...doc(table.comment, ''), `export interface ${n.type} {`);
  for (const c of table.columns) {
    lines.push(...doc(c.comment, '  '), ...property(c.property, c.notNull ? c.type : `${c.type} | null`, false, '  '));
  }
  lines.push('}', '');

  if (canInsert(table)) {
    lines.push('/** What a service sets on insert. Optional columns have a default or allow null. */',
      `export interface New${n.type} {`);
    for (const c of table.columns.filter((col) => col.insertable)) {
      const optional = c.hasDefault || !c.notNull;
      lines.push(...property(c.property, c.notNull ? c.type : `${c.type} | null`, optional, '  '));
    }
    lines.push('}', '');
  }

  if (canUpdate(table)) {
    const props = table.columns.filter((c) => c.updatable).map((c) => `'${c.property}'`);
    lines.push('/** What a service may change. Keys, frozen columns and timestamps never change. */');
    const single = `export type ${n.type}Changes = Partial<Pick<${n.type}, ${props.join(' | ')}>>;`;
    if (single.length <= 110) {
      lines.push(single);
    } else {
      lines.push(`export type ${n.type}Changes = Partial<Pick<${n.type},`,
        ...props.map((p, i) => `  ${i === 0 ? '' : '| '}${p}${i === props.length - 1 ? '>>;' : ''}`));
    }
    lines.push('');
  }

  lines.push(`export type ${n.type}PrimaryKey = Pick<${n.type}, ${pk.map((c) => `'${camel(c)}'`).join(' | ')}>;`, '');

  const quote = (identifier: string): string => `"${identifier}"`;
  lines.push(`export const ${n.spec}: TableSpec<${n.type}> = {`,
    `  table: '${table.schema}.${table.name}',`,
    `  sql: '${quote(table.schema)}.${quote(table.name)}',`,
    '  columns: {',
    ...table.columns.map((c) => `    ${c.property}: '${quote(c.name)}',`),
    '  },',
    `  json: [${table.columns.filter((c) => c.type.includes('JsonValue')).map((c) => `'${c.property}'`).join(', ')}],`,
    '  select: [',
    ...table.columns.map((c) => `    '${c.property === c.name ? quote(c.name) : `${quote(c.name)} as ${quote(c.property)}`}',`),
    "  ].join(', '),",
    '};', '');
  return { path: `src/models/${table.schema}/${n.file}.model.ts`, content: lines.join('\n') };
}

function signature(name: string, params: string[], returns: string): string[] {
  const line = `  ${name}(${params.join(', ')}): ${returns} {`;
  if (line.length <= 110) return [line];
  return [`  ${name}(`, ...params.map((p) => `    ${p},`), `  ): ${returns} {`];
}

function repoFile(table: Table): GeneratedFile {
  const n = namesOf(table);
  const pk = primaryKey(table);
  const single = pk.length === 1;
  const keyParam = single ? `${camel(pk[0]!)}: ${n.type}['${camel(pk[0]!)}']` : `key: ${n.type}PrimaryKey`;
  const keyArg = single ? `{ ${camel(pk[0]!)} }` : 'key';
  const byKey = single ? `findBy${pascal(pk[0]!)}` : 'findByKey';
  const found = `Promise<${n.type} | undefined>`;

  const helpers = new Set(['findRow']);
  const types = new Set([n.type]);
  if (!single) types.add(`${n.type}PrimaryKey`);
  const methods: string[][] = [];

  if (canInsert(table)) {
    helpers.add('insertRow');
    types.add(`New${n.type}`);
    methods.push([...signature('insert', ['db: Queryable', `row: New${n.type}`], `Promise<${n.type}>`),
      `    return insertRow(db, ${n.spec}, row);`, '  },']);
  }
  methods.push([...signature(byKey, ['db: Queryable', keyParam], found),
    `    return findRow(db, ${n.spec}, ${keyArg});`, '  },']);

  // One finder per other unique key that does not contain the primary key.
  const used = new Set([byKey]);
  for (const key of table.keys.filter((k) => !k.primary && !pk.every((c) => k.columns.includes(c)))) {
    const named = key.columns.filter((c) => c !== 'organisation_id' || key.columns.length === 1);
    let method = `findBy${named.map(pascal).join('And')}`;
    for (let i = 2; used.has(method); i++) method = `findBy${named.map(pascal).join('And')}${i}`;
    used.add(method);
    if (key.columns.length === 1) {
      const p = camel(key.columns[0]!);
      methods.push([...signature(method, ['db: Queryable', `${p}: ${n.type}['${p}']`], found),
        `    return findRow(db, ${n.spec}, { ${p} });`, '  },']);
    } else {
      const pick = `Pick<${n.type}, ${key.columns.map((c) => `'${camel(c)}'`).join(' | ')}>`;
      methods.push([...signature(method, ['db: Queryable', `key: ${pick}`], found),
        `    return findRow(db, ${n.spec}, key);`, '  },']);
    }
  }

  if (canUpdate(table)) {
    helpers.add('updateRow');
    types.add(`${n.type}Changes`);
    methods.push([...signature('update', ['db: Queryable', keyParam, `changes: ${n.type}Changes`], found),
      `    return updateRow(db, ${n.spec}, ${keyArg}, changes);`, '  },']);
  }
  if (table.deletable) {
    helpers.add('deleteRow');
    methods.push([...signature('remove', ['db: Queryable', keyParam], 'Promise<boolean>'),
      `    return deleteRow(db, ${n.spec}, ${keyArg});`, '  },']);
  }

  const scope = !table.rls
    ? 'No row-level security: every caller sees every row.'
    : 'Row-level security applies: call it inside inTransaction with the request context.';
  const writers = table.writers.length > 0 ? `written by ${table.writers.join(', ')}` : 'written by no service';
  const readers = table.readers.length > 0 ? `Read by ${table.readers.join(', ')}` : 'Read in full by no service';
  const partial = table.partialReaders.length === 0 ? [] : [
    `// ${table.partialReaders.join(', ')} may read only some columns, so cannot use these finders, which`,
    '// select every column; give them their own query.',
  ];
  const lines = [
    `// Data access for ${table.schema}.${table.name}, in plain SQL through base.repo.ts; no ORM.`,
    `// ${readers}; ${writers}.`,
    ...partial,
    `// ${scope}`,
    "// Scaffolded once by npm run db:models; this table's own queries belong here.",
    '',
    `import { ${[...helpers].sort().join(', ')}, type Queryable } from '../base.repo.ts';`,
  ];
  const typeImports = [...types].sort().map((t) => `type ${t}`);
  const importLine = `import { ${n.spec}, ${typeImports.join(', ')} } from '../../models/${table.schema}/${n.file}.model.ts';`;
  if (importLine.length <= 110) {
    lines.push(importLine);
  } else {
    lines.push('import {', `  ${n.spec},`, ...typeImports.map((t) => `  ${t},`),
      `} from '../../models/${table.schema}/${n.file}.model.ts';`);
  }
  lines.push('', `export const ${n.repo} = {`);
  methods.forEach((m, i) => lines.push(...(i > 0 ? [''] : []), ...m));
  lines.push('};', '');
  return { path: `src/repos/${table.schema}/${n.file}.repo.ts`, content: lines.join('\n') };
}

export interface Generated {
  models: GeneratedFile[];
  schemas: GeneratedFile[];
  repos: GeneratedFile[];
  /** index.model.ts, index.schema.ts and index.repo.ts per schema folder. Always regenerated. */
  indexes: GeneratedFile[];
  skipped: string[];
}

// One index per schema and layer, so a service imports a schema's models or repos in one
// line. Per schema, not one for everything: platform and directory both have a Cell, and
// Node loads every module an index re-exports.
function indexFile(schema: string, layer: 'model' | 'schema' | 'repo', files: string[]): GeneratedFile {
  const what = `${layer}s`;
  const source = layer === 'repo' ? `the ${what} in this folder` : 'the migrated database';
  return {
    path: `src/${what}/${schema}/index.${layer}.ts`,
    content: [
      `// The ${schema} ${what}. Generated by npm run db:models from ${source}; do not edit.`,
      `// Import ${what} from here rather than file by file.`,
      '',
      ...[...new Set(files)].sort().map((f) => `export * from './${f}';`),
      '',
    ].join('\n'),
  };
}

// The repo files in a schema folder, so a hand-written repo is exported too.
async function repoFilesOnDisk(schema: string): Promise<string[]> {
  const files = await readdir(path.join(SERVER_ROOT, 'src/repos', schema)).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith('.repo.ts') && f !== 'index.repo.ts');
}

// Builds every model and repo scaffold from the two migrated databases. Writes nothing.
export async function generate(cell: pg.Client, directory: pg.Client): Promise<Generated> {
  const fromCell = await readTables(cell, SERVICE_ROLES.cell);
  const fromDirectory = await readTables(directory, SERVICE_ROLES.directory);
  const tables = [...fromCell.tables, ...fromDirectory.tables];
  const paths = new Map<string, string>();
  for (const t of tables) {
    const file = modelFile(t).path;
    const clash = paths.get(file);
    if (clash) throw new Error(`${t.schema}.${t.name} and ${clash} would share ${file}`);
    paths.set(file, `${t.schema}.${t.name}`);
  }
  const models = tables.map(modelFile);
  const schemas = tables.map((t) => schemaFile(t, namesOf(t)));
  const repos = tables.map(repoFile);
  const indexes: GeneratedFile[] = [];
  for (const schema of [...new Set(tables.map((t) => t.schema))].sort()) {
    const inSchema = (files: GeneratedFile[]): string[] =>
      files.filter((f) => f.path.split('/')[2] === schema).map((f) => path.basename(f.path));
    indexes.push(indexFile(schema, 'model', inSchema(models)));
    indexes.push(indexFile(schema, 'schema', inSchema(schemas)));
    indexes.push(indexFile(schema, 'repo', [...inSchema(repos), ...await repoFilesOnDisk(schema)]));
  }
  return { models, schemas, repos, indexes, skipped: [...fromCell.skipped, ...fromDirectory.skipped] };
}

// The generated files on disk in src/<folder>/<schema>/. Files directly in src/<folder>
// (table.model.ts, column.schema.ts) are hand-written and never listed.
async function generatedFilesOnDisk(folder: 'models' | 'schemas', suffix: string): Promise<string[]> {
  const root = path.join(SERVER_ROOT, 'src', folder);
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of await readdir(path.join(root, entry.name))) {
      if (file.endsWith(suffix)) found.push(`src/${folder}/${entry.name}/${file}`);
    }
  }
  return found.sort();
}

export const modelFilesOnDisk = (): Promise<string[]> => generatedFilesOnDisk('models', '.model.ts');
export const schemaFilesOnDisk = (): Promise<string[]> => generatedFilesOnDisk('schemas', '.schema.ts');

async function exists(file: string): Promise<boolean> {
  return readFile(file).then(() => true, () => false);
}

async function main(): Promise<void> {
  const cellUrl = process.env['CELL_MIGRATE_URL'];
  const directoryUrl = process.env['DIRECTORY_MIGRATE_URL'];
  if (!cellUrl || !directoryUrl) {
    console.error('CELL_MIGRATE_URL and DIRECTORY_MIGRATE_URL must be set');
    process.exit(2);
  }
  const cell = new pg.Client({ connectionString: cellUrl });
  const directory = new pg.Client({ connectionString: directoryUrl });
  await cell.connect();
  await directory.connect();
  try {
    const { models, schemas, repos, indexes, skipped } = await generate(cell, directory);
    const expected = new Set([...models, ...schemas, ...indexes].map((m) => m.path));
    for (const stale of [...await modelFilesOnDisk(), ...await schemaFilesOnDisk()].filter((f) => !expected.has(f))) {
      await rm(path.join(SERVER_ROOT, stale));
      console.log(`removed ${stale}: its table no longer exists`);
    }
    let changed = 0;
    for (const model of [...models, ...schemas]) {
      const target = path.join(SERVER_ROOT, model.path);
      if ((await readFile(target, 'utf8').catch(() => '')) === model.content) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, model.content);
      changed++;
    }
    let scaffolded = 0;
    for (const repo of repos) {
      const target = path.join(SERVER_ROOT, repo.path);
      if (await exists(target)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, repo.content);
      scaffolded++;
    }
    // Indexes last: the repo indexes list the repo files now on disk.
    const { indexes: current } = await generate(cell, directory);
    for (const index of current) {
      const target = path.join(SERVER_ROOT, index.path);
      if ((await readFile(target, 'utf8').catch(() => '')) === index.content) continue;
      await writeFile(target, index.content);
      changed++;
    }
    console.log(`${models.length} models, ${schemas.length} schemas and ${indexes.length} indexes (${changed} written), `
      + `${scaffolded} repos scaffolded`);
    if (skipped.length > 0) console.log(`no service reads, so no model: ${skipped.join(', ')}`);
  } finally {
    await cell.end();
    await directory.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
