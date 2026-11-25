// Builds one Zod schema file per table, src/schemas/<schema>/<name>.schema.ts, for
// generateModels.script.ts (npm run db:models). The schema states, as Zod, what Postgres
// states about each column: its type, whether it may be null, and the single-column
// checks that translate (src/schemas/column.schema.ts). A check that does not translate
// is listed in the file and left to the database, as are keys, foreign keys, row-level
// security and checks across columns.
//
// Each file has three schemas, typed against the model so they cannot drift apart:
// the row, the insert (New<Model>) and the changes (<Model>Changes). Insert and changes
// refuse unknown properties.

export interface SchemaColumn {
  name: string;
  property: string;
  pgType: string;
  pgElement: string | null;
  typmod: number;
  notNull: boolean;
  hasDefault: boolean;
  insertable: boolean;
  updatable: boolean;
  checks: string[];
}

export interface SchemaTable {
  schema: string;
  name: string;
  columns: SchemaColumn[];
}

export interface SchemaNames {
  file: string;
  type: string;
}

interface Translated {
  enumValues?: string[];
  literal?: boolean;
  text: Record<string, string>;
  range: Record<string, number>;
  bytes: Record<string, number>;
  json: Record<string, string | number>;
  items: Record<string, number>;
  untranslated: string[];
}

const TEXT_TYPES = new Set(['text', 'citext', 'varchar', 'bpchar', 'name']);
const NUMBER_TYPES = new Set(['int2', 'int4', 'int8', 'numeric', 'float4', 'float8']);

// The index of the parenthesis closing the one at start, ignoring quoted text.
function closing(expr: string, start: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = start; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "'") quoted = !quoted;
    else if (!quoted && ch === '(') depth++;
    else if (!quoted && ch === ')' && --depth === 0) return i;
  }
  return -1;
}

function unwrap(expr: string): string {
  let e = expr.trim();
  while (e.startsWith('(') && closing(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
  return e;
}

// Splits on an operator outside parentheses and quotes.
function splitTop(expr: string, op: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "'") quoted = !quoted;
    else if (!quoted && ch === '(') depth++;
    else if (!quoted && ch === ')') depth--;
    else if (!quoted && depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(start, i));
      start = i + op.length;
      i += op.length - 1;
    }
  }
  parts.push(expr.slice(start));
  return parts.map(unwrap);
}

const literals = (list: string): string[] =>
  [...list.matchAll(/'((?:[^']|'')*)'::[a-z ]+/g)].map((m) => m[1]!.replaceAll("''", "'"));

// Postgres regular expressions that mean the same in JavaScript with the s and u flags.
// Anything using a feature JavaScript lacks or reads differently is left to the database.
function jsPattern(source: string): string | null {
  if (/\[\[:|\\[mMyYAZ]|\(\?|\\\d/.test(source)) return null;
  try {
    new RegExp(source, 'su');
  } catch {
    return null;
  }
  return source;
}

function bounds(op: string, n: number, min: string, max: string, integer: boolean): Record<string, number> {
  const step = integer ? 1 : 0;
  switch (op) {
    case '>': return { [min]: n + step };
    case '>=': return { [min]: n };
    case '<': return { [max]: n - step };
    case '<=': return { [max]: n };
    default: return { [min]: n, [max]: n };
  }
}

const RANGE: Record<string, string[]> = { '>': ['gt'], '>=': ['gte'], '<': ['lt'], '<=': ['lte'], '=': ['gte', 'lte'] };

export function translateChecks(column: SchemaColumn): Translated {
  const out: Translated = { text: {}, range: {}, bytes: {}, json: {}, items: {}, untranslated: [] };
  const esc = column.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ident = `(?:${esc}|"${esc}")`;
  const ref = `(?:${ident}|\\(${ident}\\)::[a-z ]+)`;
  const num = `\\(?'?(-?\\d+(?:\\.\\d+)?)'?(?:::[a-z ]+)?\\)?(?:::[a-z ]+)?`;
  const op = '(>=|<=|>|<|=)';
  const match = (term: string, pattern: string): RegExpExecArray | null => new RegExp(`^${pattern}$`).exec(term);

  for (const definition of column.checks) {
    const body = unwrap(definition.replace(/^CHECK /, '').replace(/ NOT VALID$/, ''));
    const branches = splitTop(body, ' OR ');
    const rest = branches.filter((b) => !match(b, `${ref} IS NULL`));
    if (rest.length !== 1) {
      out.untranslated.push(definition);
      continue;
    }
    const pending: (() => void)[] = [];
    let all = true;
    for (const term of splitTop(rest[0]!, ' AND ')) {
      let m: RegExpExecArray | null;
      if ((m = match(term, `${ref} = ANY \\(ARRAY\\[(.*)\\]\\)`)) ?? (m = match(term, `${ref} <@ ARRAY\\[(.*)\\]`))
        ?? (m = match(term, `${ref} = ('(?:[^']|'')*'::[a-z ]+)`))) {
        // Text values only; a list of numbers is left to the database.
        const values = literals(m[1]!);
        if (values.length === 0) all = false;
        else pending.push(() => { out.enumValues = values; });
      } else if (column.pgType === 'bool' && (m = match(term, `(NOT )?${ref}(?: = (true|false)| IS NOT (FALSE))?`))) {
        // x IS NOT FALSE allows null too; nullability comes from the column.
        const value = m[3] !== undefined || (m[2] === undefined ? m[1] === undefined : (m[2] === 'true') !== (m[1] !== undefined));
        pending.push(() => { out.literal = value; });
      } else if (TEXT_TYPES.has(column.pgType)
        && (m = match(term, `length\\((?:btrim\\(${ref}\\)|TRIM\\(BOTH FROM ${ref}\\))\\) (>=|>) ${num}`))) {
        const min = Number(m[2]) + (m[1] === '>' ? 1 : 0);
        pending.push(() => {
          if (min === 1) out.text['nonBlank'] = 'true';
          else out.text['trimmedMinChars'] = String(min);
        });
      } else if ((m = match(term, `(length|char_length|character_length|octet_length)\\(${ref}\\) ${op} ${num}`))) {
        const fn = m[1]!;
        const found = bounds(m[2]!, Number(m[3]), 'min', 'max', true);
        const isJsonText = column.pgType === 'jsonb' && fn === 'octet_length';
        if (column.pgType === 'bytea') {
          pending.push(() => { for (const [k, v] of Object.entries(found)) out.bytes[`${k}Bytes`] = v; });
        } else if (isJsonText && found['max'] !== undefined && found['min'] === undefined) {
          pending.push(() => { out.json['maxBytes'] = found['max']!; });
        } else if (TEXT_TYPES.has(column.pgType)) {
          const unit = fn === 'octet_length' ? 'Bytes' : 'Chars';
          pending.push(() => { for (const [k, v] of Object.entries(found)) out.text[`${k}${unit}`] = String(v); });
        } else {
          all = false;
        }
      } else if (column.pgType === 'jsonb' && (m = match(term, `jsonb_typeof\\(${ref}\\) = '(\\w+)'::text`))) {
        const type = m[1]!;
        pending.push(() => { out.json['type'] = `'${type}'`; });
      } else if (TEXT_TYPES.has(column.pgType) && (m = match(term, `${ref} (~\\*?) '((?:[^']|'')*)'::text`))) {
        const source = jsPattern(m[2]!.replaceAll("''", "'"));
        if (source === null) {
          all = false;
        } else {
          const flags = m[1] === '~*' ? 'sui' : 'su';
          pending.push(() => { out.text['pattern'] = `/${source.replaceAll('/', '\\/')}/${flags}`; });
        }
      } else if (column.pgElement !== null && (m = match(term, `cardinality\\(${ref}\\) ${op} ${num}`))) {
        const found = bounds(m[1]!, Number(m[2]), 'minItems', 'maxItems', true);
        pending.push(() => Object.assign(out.items, found));
      } else if (column.pgElement !== null
        && (match(term, `array_ndims\\(${ref}\\) = 1`) || match(term, `array_position\\(${ref}, NULL::[a-z ]+\\) IS NULL`))) {
        // A Zod array of non-null scalars is one-dimensional and holds no null.
      } else if (NUMBER_TYPES.has(column.pgType) && (m = match(term, `${ref} ${op} ${num}`))) {
        const n = Number(m[2]);
        const keys = RANGE[m[1]!]!;
        pending.push(() => { for (const k of keys) out.range[k] = n; });
      } else {
        all = false;
      }
    }
    // Every term of a check must hold, so each translated term is safe to apply alone;
    // the whole check is still listed when part of it is not translated.
    for (const apply of pending) apply();
    if (!all) out.untranslated.push(definition);
  }
  return out;
}

const quoteString = (v: string): string => `'${v.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

const options = (record: Record<string, string | number>): string => {
  const entries = Object.entries(record);
  return entries.length === 0 ? '' : `{ ${entries.map(([k, v]) => `${k}: ${v}`).join(', ')} }`;
};

function scalar(type: string, typmod: number, t: Translated): string {
  switch (type) {
    case 'uuid': return 'column.uuid()';
    case 'text': case 'citext': case 'name': return `column.text(${options(t.text)})`;
    case 'varchar': case 'bpchar': {
      const rules: Record<string, string> = { ...t.text };
      if (typmod > 4 && rules['maxChars'] === undefined) rules['maxChars'] = String(typmod - 4);
      return `column.text(${options(rules)})`;
    }
    case 'int2': case 'int4': return `column.${type}(${options(t.range)})`;
    case 'int8': return `column.int8(${options(t.range)})`;
    case 'numeric': {
      const rules: Record<string, number> = {};
      if (typmod > 4) {
        rules['precision'] = ((typmod - 4) >> 16) & 0xffff;
        rules['scale'] = (typmod - 4) & 0xffff;
      }
      return `column.numeric(${options({ ...rules, ...t.range })})`;
    }
    case 'float4': case 'float8': return `column.float(${options(t.range)})`;
    case 'bool': return t.literal === undefined ? 'column.bool()' : `z.literal(${t.literal})`;
    case 'date': return 'column.date()';
    case 'timestamptz': return 'column.timestamptz()';
    case 'interval': return 'column.interval()';
    case 'ltree': return 'column.ltree()';
    case 'cidr': return 'column.cidr()';
    case 'bytea': return `column.bytes(${options(t.bytes)})`;
    case 'jsonb': case 'json': return `column.json(${options(t.json)})`;
    case 'vector': return `column.vector(${typmod > 0 ? typmod : ''})`;
    default: throw new Error(`no Zod schema for ${type}`);
  }
}

function expression(c: SchemaColumn, t: Translated): string {
  const enumOf = t.enumValues && t.enumValues.length > 0 ? `z.enum([${t.enumValues.map(quoteString).join(', ')}])` : null;
  let expr: string;
  if (c.pgElement !== null) {
    expr = `column.array(${enumOf ?? scalar(c.pgElement, -1, { ...t, text: {}, range: {}, bytes: {}, json: {} })}`
      + `${Object.keys(t.items).length > 0 ? `, ${options(t.items)}` : ''})`;
  } else {
    expr = enumOf ?? scalar(c.pgType, c.typmod, t);
  }
  return c.notNull ? expr : `${expr}.nullable()`;
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

export function schemaFile(table: SchemaTable, names: SchemaNames): { path: string; content: string } {
  const translated = new Map(table.columns.map((c) => [c.name, translateChecks(c)]));
  const base = lowerFirst(names.type);
  const insertable = table.columns.filter((c) => c.insertable);
  const updatable = table.columns.filter((c) => c.updatable);
  const types = [names.type, ...(insertable.length > 0 ? [`New${names.type}`] : []),
    ...(updatable.length > 0 ? [`${names.type}Changes`] : [])].sort();

  const lines = [
    `// ${table.schema}.${table.name}. Generated by npm run db:models from the migrated database; do not edit.`,
    "// The column rules Postgres states for this table, as Zod. Keys, foreign keys, row-level",
    '// security and rules across columns stay with the database.',
    '',
    "import { z } from 'zod';",
  ];
  const typeImport = `import type { ${types.join(', ')} } from '../../models/${table.schema}/${names.file}.model.ts';`;
  if (typeImport.length <= 110) lines.push(typeImport);
  else lines.push('import type {', ...types.map((t) => `  ${t},`), `} from '../../models/${table.schema}/${names.file}.model.ts';`);
  lines.push("import { column } from '../column.schema.ts';", '');

  lines.push('const columns = {');
  for (const c of table.columns) lines.push(`  ${c.property}: ${expression(c, translated.get(c.name)!)},`);
  lines.push('};', '');

  lines.push('/** A row as the database returns it. */',
    `export const ${base}Schema = z.object(columns) satisfies z.ZodType<${names.type}>;`, '');

  if (insertable.length > 0) {
    lines.push('/** What a service sets on insert. Unknown properties are refused. */',
      `export const new${names.type}Schema = z.strictObject({`);
    for (const c of insertable) {
      const optional = c.hasDefault || !c.notNull;
      lines.push(`  ${c.property}: columns.${c.property}${optional ? '.exactOptional()' : ''},`);
    }
    lines.push(`}) satisfies z.ZodType<New${names.type}>;`, '');
  }

  if (updatable.length > 0) {
    lines.push('/** What a service may change. Unknown properties are refused. */',
      `export const ${base}ChangesSchema = z.strictObject({`);
    for (const c of updatable) lines.push(`  ${c.property}: columns.${c.property}.exactOptional(),`);
    lines.push(`}) satisfies z.ZodType<${names.type}Changes>;`, '');
  }

  const left = table.columns.flatMap((c) =>
    translated.get(c.name)!.untranslated.map((d) => `${c.name}: ${d.replace(/\s+/g, ' ')}`));
  if (left.length > 0) {
    lines.push('// Checked by the database only (no Zod translation):');
    for (const item of left) lines.push(`// - ${item}`);
    lines.push('');
  }
  return { path: `src/schemas/${table.schema}/${names.file}.schema.ts`, content: lines.join('\n') };
}
