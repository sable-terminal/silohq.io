// OpenAPI to a build draft (spec 16.3: the highest-fidelity input), with no model call.
//
// - the base URL from the first absolute server;
// - authentication from the security scheme the document applies (bearer, basic, an API
//   key in a header or the query); anything else is noted, and the person chooses in the
//   visual builder;
// - an object per GET path with no path parameter whose 200 JSON response is an array of
//   objects, or an object holding one (that property's path is where the records sit);
// - fields from the item schema's properties (components resolved, allOf merged), nested
//   objects and arrays as json;
// - paging from the query parameters (a cursor, a page number or an offset, with a page
//   size) and the envelope's properties (where the next cursor or the page count sits);
// - equality filters from query parameters named after a field.
// Examples and defaults in the document are never read: they are values.

import { parseDocument } from 'yaml';
import type { FieldType } from '../../contracts/connect/manifest.contract.ts';
import { AppError } from '../../utils/errors.util.ts';
import type { Draft, DraftObject } from './draft.service.ts';

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_OBJECTS = 50;
const MAX_REF_DEPTH = 8;

export const CURSOR_PARAMS = /^(cursor|after|starting_after|page_token|pagetoken|next_token|continuation_token|next)$/i;
export const PAGE_PARAMS = /^(page|page_number|pagenumber|p)$/i;
export const OFFSET_PARAMS = /^(offset|skip|start)$/i;
export const SIZE_PARAMS = /^(limit|per_page|perpage|page_size|pagesize|size|count|max_results)$/i;
export const CURSOR_PROPS = /^(next|next_cursor|nextcursor|cursor|next_page_token|nextpagetoken|end_cursor|after)$/i;
export const PAGES_PROPS = /^(total_pages|totalpages|page_count|pagecount|last_page|lastpage|pages)$/i;
const ENVELOPE_HOMES = /^(meta|paging|pagination|page_info|pageinfo|links|_links)$/i;

/** The document, from JSON or YAML text. Aliases refused, as in any manifest input. */
export function parseOpenApi(text: string): Node {
  const doc = parseDocument(text, { uniqueKeys: true, merge: false });
  if (doc.errors.length > 0) throw new AppError('validation', 'the OpenAPI document does not parse', { code: 'build.openapi_unreadable' });
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw new AppError('validation', 'the OpenAPI document uses aliases, which are refused', { code: 'build.openapi_unreadable' });
  }
  if (!isNode(value) || (typeof value['openapi'] !== 'string' && typeof value['swagger'] !== 'string')) {
    throw new AppError('validation', 'this is not an OpenAPI document', { code: 'build.openapi_unreadable' });
  }
  return value;
}

function resolver(root: Node) {
  const resolve = (schema: unknown, depth = 0): Node | undefined => {
    if (!isNode(schema) || depth > MAX_REF_DEPTH) return undefined;
    const ref = schema['$ref'];
    if (typeof ref === 'string') {
      if (!ref.startsWith('#/')) return undefined;
      const target = ref.slice(2).split('/').reduce<unknown>((node, key) =>
        (isNode(node) ? node[key.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined), root);
      return resolve(target, depth + 1);
    }
    const all = schema['allOf'];
    if (Array.isArray(all)) {
      const merged: Node = { type: 'object', properties: {} };
      for (const part of all) {
        const p = resolve(part, depth + 1);
        if (p !== undefined && isNode(p['properties'])) Object.assign(merged['properties'] as Node, p['properties']);
      }
      return merged;
    }
    return schema;
  };
  return resolve;
}

function fieldType(schema: Node | undefined): FieldType {
  const type = schema?.['type'];
  const format = schema?.['format'];
  if (type === 'integer') return 'integer';
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'string' && format === 'date') return 'date';
  if (type === 'string' && format === 'date-time') return 'date-time';
  if (type === 'object' || type === 'array') return 'json';
  return 'string';
}

function authOf(root: Node): { auth: Draft['auth']; note: string | null } {
  const schemes = isNode(root['components']) && isNode((root['components'] as Node)['securitySchemes'])
    ? (root['components'] as Node)['securitySchemes'] as Node : {};
  const applied = Array.isArray(root['security']) ? root['security'].flatMap((s) => (isNode(s) ? Object.keys(s) : [])) : [];
  const name = applied.find((n) => n in schemes) ?? Object.keys(schemes)[0];
  const none: Draft['auth'] = { strategy: 'none', location: null, key: null, prefix: null };
  if (name === undefined) return { auth: none, note: null };
  const scheme = schemes[name];
  if (!isNode(scheme)) return { auth: none, note: 'auth_scheme_unreadable' };
  if (scheme['type'] === 'http' && String(scheme['scheme']).toLowerCase() === 'bearer') return { auth: { ...none, strategy: 'bearer' }, note: null };
  if (scheme['type'] === 'http' && String(scheme['scheme']).toLowerCase() === 'basic') return { auth: { ...none, strategy: 'basic' }, note: null };
  if (scheme['type'] === 'apiKey' && (scheme['in'] === 'header' || scheme['in'] === 'query') && typeof scheme['name'] === 'string') {
    return { auth: { strategy: 'api_key', location: scheme['in'], key: scheme['name'], prefix: null }, note: null };
  }
  return { auth: none, note: `auth_scheme_unsupported:${String(scheme['type']).slice(0, 40)}` };
}

/** The records in a response schema: the array itself, or the envelope's array property. */
function recordsOf(schema: Node | undefined, resolve: ReturnType<typeof resolver>)
  : { recordsPath: string | null; item: Node; envelope: Node | null } | undefined {
  if (schema === undefined) return undefined;
  if (schema['type'] === 'array') {
    const item = resolve(schema['items']);
    return item !== undefined && (item['type'] === 'object' || isNode(item['properties'])) ? { recordsPath: null, item, envelope: null } : undefined;
  }
  const properties = isNode(schema['properties']) ? schema['properties'] as Node : undefined;
  if (properties === undefined) return undefined;
  for (const [key, value] of Object.entries(properties)) {
    const prop = resolve(value);
    if (prop?.['type'] !== 'array') continue;
    const item = resolve(prop['items']);
    if (item !== undefined && (item['type'] === 'object' || isNode(item['properties']))) return { recordsPath: key, item, envelope: properties };
  }
  return undefined;
}

/** Where the next cursor or the page count sits in an envelope, to depth 2. */
function envelopePath(envelope: Node | null, wanted: RegExp, resolve: ReturnType<typeof resolver>): string | null {
  if (envelope === null) return null;
  for (const [key, value] of Object.entries(envelope)) {
    if (wanted.test(key)) return key;
    const child = resolve(value);
    if (ENVELOPE_HOMES.test(key) && child !== undefined && isNode(child['properties'])) {
      for (const inner of Object.keys(child['properties'] as Node)) if (wanted.test(inner)) return `${key}.${inner}`;
    }
  }
  return null;
}

export function draftFromOpenApi(root: Node): { draft: Draft; notes: string[] } {
  const resolve = resolver(root);
  const notes: string[] = [];
  const servers = Array.isArray(root['servers']) ? root['servers'] : [];
  const server = servers.map((s) => (isNode(s) ? s['url'] : undefined)).find((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u));
  const { auth, note } = authOf(root);
  if (note !== null) notes.push(note);
  const objects: DraftObject[] = [];
  const paths = isNode(root['paths']) ? root['paths'] as Node : {};
  for (const [path, item] of Object.entries(paths)) {
    if (objects.length >= MAX_OBJECTS) {
      notes.push('objects_bounded');
      break;
    }
    if (!isNode(item) || !isNode(item['get']) || path.includes('{')) continue;
    const get = item['get'] as Node;
    const ok = isNode(get['responses']) ? (get['responses'] as Node)['200'] ?? (get['responses'] as Node)['default'] : undefined;
    const content = isNode(ok) && isNode(resolve(ok)?.['content']) ? resolve(ok)!['content'] as Node : undefined;
    const json = content === undefined ? undefined : Object.entries(content).find(([type]) => type.includes('json'))?.[1];
    const found = recordsOf(resolve(isNode(json) ? json['schema'] : undefined), resolve);
    if (found === undefined) continue;
    const properties = isNode(found.item['properties']) ? found.item['properties'] as Node : {};
    const fields = Object.entries(properties).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)).map(([key, value]) => ({
      name: key, path: key, type: fieldType(resolve(value)),
    }));
    if (fields.length === 0) continue;
    const parameters = [...(Array.isArray(item['parameters']) ? item['parameters'] : []), ...(Array.isArray(get['parameters']) ? get['parameters'] : [])]
      .map((p) => resolve(p)).filter((p): p is Node => p !== undefined && p['in'] === 'query' && typeof p['name'] === 'string');
    const names = parameters.map((p) => p['name'] as string);
    const cursor = names.find((n) => CURSOR_PARAMS.test(n));
    const pageNumber = names.find((n) => PAGE_PARAMS.test(n));
    const offset = names.find((n) => OFFSET_PARAMS.test(n));
    const size = names.find((n) => SIZE_PARAMS.test(n));
    const nextPath = envelopePath(found.envelope, CURSOR_PROPS, resolve);
    const paging: DraftObject['paging'] = cursor !== undefined && nextPath !== null
      ? { style: 'cursor', param: cursor, path: nextPath, sizeParam: null, size: null }
      : pageNumber !== undefined
        ? { style: 'page', param: pageNumber, path: envelopePath(found.envelope, PAGES_PROPS, resolve), sizeParam: size ?? null, size: size === undefined ? null : 100 }
        : offset !== undefined && size !== undefined
          ? { style: 'offset', param: offset, path: null, sizeParam: size, size: 100 }
          : { style: 'none', param: null, path: null, sizeParam: null, size: null };
    const fieldNames = new Set(fields.map((f) => f.name));
    const segment = path.split('/').filter(Boolean).pop() ?? 'records';
    objects.push({
      name: segment, label: typeof get['summary'] === 'string' ? get['summary'].slice(0, 200) : null, path, recordsPath: found.recordsPath,
      identifier: fieldNames.has('id') ? 'id' : fields.find((f) => /(^|_)id$/i.test(f.name))?.name ?? null,
      fields, paging, filters: names.filter((n) => fieldNames.has(n)).map((n) => ({ field: n, param: n })),
    });
  }
  if (objects.length === 0) throw new AppError('validation', 'the document lists no endpoint that returns a list of records', { code: 'build.openapi_no_objects' });
  return { draft: { baseUrl: server ?? null, auth, objects }, notes };
}
