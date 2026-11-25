import { buildSchema, getIntrospectionQuery, graphqlSync } from 'graphql';
import { fieldsBlock, identifierOf, singular, slug, type Compiled, type CompiledField, type FieldType } from './shared.compile';

/**
 * A GraphQL schema, from its introspection result, as a version 2 draft.
 *
 * Every `Query` field that returns a list of objects — plainly, or as a Relay
 * connection with `edges`/`nodes` and `pageInfo` — becomes an object whose
 * selection is its item type's scalar fields. A connection pages by
 * `endCursor`. An argument that is a nullable scalar named like a field is a
 * filter, passed as a VARIABLE: the query document stays literal, so a value
 * can never change the query's shape.
 *
 * INTROSPECTION SAYS NOTHING ABOUT AUTHENTICATION. The draft offers a bearer
 * token and a header key, and says so.
 */

interface TypeRef {
  kind: string;
  name: string | null;
  ofType: TypeRef | null;
}
interface InputValue {
  name: string;
  type: TypeRef;
  defaultValue: string | null;
}
interface FieldDef {
  name: string;
  description?: string | null;
  args: InputValue[];
  type: TypeRef;
  isDeprecated?: boolean;
}
interface FullType {
  kind: string;
  name: string;
  fields: FieldDef[] | null;
  enumValues?: unknown[] | null;
}

const unwrap = (ref: TypeRef): { named: TypeRef; list: boolean; nonNull: boolean } => {
  let current = ref;
  let list = false;
  const nonNull = ref.kind === 'NON_NULL';
  for (let i = 0; i < 8 && current.ofType && (current.kind === 'NON_NULL' || current.kind === 'LIST'); i++) {
    if (current.kind === 'LIST') list = true;
    current = current.ofType;
  }
  return { named: current, list, nonNull };
};

const printType = (ref: TypeRef): string =>
  ref.kind === 'NON_NULL' ? `${printType(ref.ofType!)}!` : ref.kind === 'LIST' ? `[${printType(ref.ofType!)}]` : String(ref.name);

function scalarType(name: string): FieldType {
  if (name === 'Int' || name === 'Float' || /^(BigInt|Long|Decimal|BigDecimal|Money|Currency|Float\d*|Int\d*)$/i.test(name)) return 'number';
  if (name === 'Boolean') return 'boolean';
  if (/^(DateTime|Timestamp|ISO8601DateTime|Instant|ZonedDateTime|timestamptz|timestamp)$/i.test(name)) return 'datetime';
  if (/^(Date|LocalDate|date)$/i.test(name)) return 'date';
  if (/^(JSON|JSONObject|JSONString|Json|jsonb|Map|Object)$/i.test(name)) return 'json';
  return 'string';
}

/**
 * An introspection result from what somebody gave: the JSON a server answers
 * `__schema` with, or the SDL the schema was written in — built and
 * introspected here with the reference implementation.
 */
export function introspectionOf(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const result = graphqlSync({ schema: buildSchema(trimmed), source: getIntrospectionQuery() });
  if (result.errors?.length) throw new Error(result.errors[0]!.message);
  return result;
}

const PAGING_ARGS = new Set(['first', 'after', 'last', 'before', 'limit', 'offset', 'skip', 'take', 'page', 'perPage', 'per_page']);

export function compileGraphql(input: unknown, options: { endpoint: string; name?: string }): Compiled {
  const introspection = (input as { data?: { __schema?: unknown }; __schema?: unknown }) ?? {};
  const schema = (introspection.data?.__schema ?? introspection.__schema) as { queryType?: { name: string }; types?: FullType[] } | undefined;
  if (!schema?.types || !schema.queryType) throw new Error('This is not a GraphQL introspection result.');
  const types = new Map(schema.types.map((t) => [t.name, t]));
  const query = types.get(schema.queryType.name);
  const notes: string[] = ['Introspection does not say how this API authenticates; a bearer token and a header key are offered. Keep the one it uses.'];
  const objects: Array<Record<string, unknown>> = [];
  const names = new Set<string>();

  for (const field of query?.fields ?? []) {
    if (field.isDeprecated || field.name.startsWith('_')) continue;
    const { named, list } = unwrap(field.type);
    const returned = named.name ? types.get(named.name) : undefined;
    if (!returned || returned.kind !== 'OBJECT') continue;

    /* A plain list, or a connection whose edges or nodes carry the item. */
    let item: FullType | undefined;
    let recordsPath: string;
    let connection = false;
    let selectionWrap: (inner: string) => string;
    if (list) {
      item = returned;
      recordsPath = `data.${field.name}`;
      selectionWrap = (inner) => inner;
    } else {
      const fieldsOf = new Map((returned.fields ?? []).map((f) => [f.name, f]));
      const edges = fieldsOf.get('edges');
      const nodes = fieldsOf.get('nodes');
      const pageInfo = fieldsOf.has('pageInfo');
      if (nodes && unwrap(nodes.type).list) {
        item = types.get(String(unwrap(nodes.type).named.name));
        recordsPath = `data.${field.name}.nodes`;
        selectionWrap = (inner) => `nodes { ${inner} }${pageInfo ? ' pageInfo { hasNextPage endCursor }' : ''}`;
        connection = pageInfo;
      } else if (edges && unwrap(edges.type).list) {
        const edge = types.get(String(unwrap(edges.type).named.name));
        const node = edge?.fields?.find((f) => f.name === 'node');
        item = node ? types.get(String(unwrap(node.type).named.name)) : undefined;
        recordsPath = `data.${field.name}.edges.node`;
        selectionWrap = (inner) => `edges { node { ${inner} } }${pageInfo ? ' pageInfo { hasNextPage endCursor }' : ''}`;
        connection = pageInfo;
      } else {
        continue;
      }
    }
    if (!item || item.kind !== 'OBJECT') continue;

    const required = field.args.filter((a) => a.type.kind === 'NON_NULL' && a.defaultValue === null && !PAGING_ARGS.has(a.name));
    if (required.length > 0) {
      notes.push(`${field.name} needs ${required.map((a) => a.name).join(', ')} before it lists anything; build it as a pipeline.`);
      continue;
    }

    const scalars: CompiledField[] = [];
    for (const f of item.fields ?? []) {
      if (f.isDeprecated || f.args.some((a) => a.type.kind === 'NON_NULL')) continue;
      const t = unwrap(f.type);
      const named = t.named.name ? types.get(t.named.name) : undefined;
      if (!named || (named.kind !== 'SCALAR' && named.kind !== 'ENUM')) continue;
      scalars.push({ name: f.name, type: t.list ? 'json' : named.kind === 'ENUM' ? 'string' : scalarType(named.name) });
      if (scalars.length >= 60) break;
    }
    if (scalars.length === 0) continue;

    let objectName = singular(field.name);
    if (names.has(objectName)) objectName = field.name;
    if (names.has(objectName)) continue;
    names.add(objectName);
    const block = fieldsBlock(scalars);
    const selection = block.fields.map((f) => f.name).join(' ');

    /* Variables: paging, then any nullable scalar argument that names a field. */
    const declared: string[] = [];
    const passed: string[] = [];
    const variables: Record<string, unknown> = {};
    const has = (name: string) => field.args.some((a) => a.name === name);
    if (connection && has('first')) {
      declared.push('$first: Int');
      passed.push('first: $first');
      variables.first = 100;
    }
    if (connection && has('after')) {
      declared.push('$after: String');
      passed.push('after: $after');
      variables.after = null;
    }
    const filters: Record<string, unknown> = {};
    const fieldNames = new Set(block.fields.map((f) => f.name));
    for (const arg of field.args) {
      if (PAGING_ARGS.has(arg.name) || arg.type.kind === 'NON_NULL') continue;
      const argType = unwrap(arg.type);
      const named = argType.named.name ? types.get(argType.named.name) : undefined;
      if (!named || (named.kind !== 'SCALAR' && named.kind !== 'ENUM') || argType.list || !fieldNames.has(arg.name)) continue;
      declared.push(`$${arg.name}: ${printType(arg.type)}`);
      passed.push(`${arg.name}: $${arg.name}`);
      variables[arg.name] = null;
      filters[arg.name] = { eq: { body: { variables: { [arg.name]: '{{ value }}' } } } };
    }

    const document = `query${declared.length ? `(${declared.join(', ')})` : ''} { ${field.name}${passed.length ? `(${passed.join(', ')})` : ''} { ${selectionWrap(selection)} } }`;
    const read: Record<string, unknown> = {
      request: { method: 'POST', body: { query: document, variables } },
      records: `{{ response.${recordsPath} }}`,
    };
    if (connection && has('after')) {
      read.page = {
        next: { body: { variables: { after: `{{ response.data.${field.name}.pageInfo.endCursor }}` } } },
        until: `{{ $not(response.data.${field.name}.pageInfo.hasNextPage) }}`,
      };
    } else if (!list) {
      notes.push(`${objectName}: the connection takes no after cursor, so one page is read.`);
    }
    if (Object.keys(filters).length > 0) read.pushdown = { filters };

    objects.push({
      name: objectName,
      ...(field.description ? { description: field.description.split('\n')[0]!.slice(0, 500) } : {}),
      identifier: identifierOf(block.fields.map((f) => f.name), objectName),
      fields: block.fields,
      read,
    });
  }

  if (objects.length === 0) notes.push('No query returns a list of records. Add objects by hand.');
  const title = options.name ?? new URL(options.endpoint).hostname.replace(/^(api|graphql|www)\./, '');
  return {
    document: {
      schemaVersion: 2,
      identity: { name: title.slice(0, 128), provider: slug(title), version: 1 },
      transport: { kind: 'graphql', endpoint: options.endpoint },
      auth: [{ strategy: 'bearer' }, { strategy: 'api_key_header', name: 'x-api-key' }],
      objects,
    },
    notes,
  };
}
