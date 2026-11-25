// The build draft (spec 16.3 parse): structure a model or an OpenAPI compile chooses, and the
// deterministic compile from it to a manifest.
//
// The model never writes an expression. It chooses paths, where records sit, fields and
// their types, the identifier, a paging style with its parameter names, and which query
// parameters filter which fields; this module writes the CEL and JSONata for those choices
// from fixed templates, so every expression in an AI-built manifest is one Silo wrote and
// the evaluator has checked. Names become manifest names; paths are sanitised to the
// manifest's path rules or dropped with a note.

import { z } from 'zod';
import { FIELD_TYPES, type FieldType, type ManifestInput } from '../../contracts/connect/manifest.contract.ts';
import { toName } from '../schema-inference/infer.service.ts';

const text = (max: number) => z.string().max(max);

/** What the model (or the OpenAPI compile) gives. No defaults: an output schema may not carry one (spec 62.3). */
export const draftSchema = z.strictObject({
  baseUrl: text(500).nullable(),
  auth: z.strictObject({
    strategy: z.enum(['none', 'bearer', 'api_key', 'basic']),
    /** api_key: where the key goes, its header or query parameter name, and any prefix. */
    location: z.enum(['header', 'query']).nullable(),
    key: text(100).nullable(),
    prefix: text(40).nullable(),
  }),
  objects: z.array(z.strictObject({
    name: text(100),
    label: text(200).nullable(),
    /** The list endpoint's path on the base URL. */
    path: text(500),
    /** Where the records sit in the response body, as a dot path; null or empty for the body itself. */
    recordsPath: text(200).nullable(),
    identifier: text(100).nullable(),
    fields: z.array(z.strictObject({ name: text(100), path: text(500), type: z.enum(FIELD_TYPES) })).max(500),
    paging: z.strictObject({
      style: z.enum(['none', 'cursor', 'page', 'offset']),
      /** The query parameter that carries the cursor, page number or offset. */
      param: text(100).nullable(),
      /** cursor: where the next cursor sits in the body. page: where the page count sits, if anywhere. */
      path: text(200).nullable(),
      /** page and offset: the query parameter that sets the page size, and the size to ask for. */
      sizeParam: text(100).nullable(),
      size: z.number().int().min(1).max(1_000).nullable(),
    }),
    /** Query parameters that filter a field by equality. */
    filters: z.array(z.strictObject({ field: text(100), param: text(100) })).max(50),
  })).min(1).max(50),
});
export type Draft = z.infer<typeof draftSchema>;
export type DraftObject = Draft['objects'][number];

const DOT_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const QUERY_NAME = /^[A-Za-z0-9_.[\]-]{1,100}$/;
const PATH = /^\/[A-Za-z0-9_\-.~/]*$/;
const MAX_PAGES = 1_000;

/** A JSON string literal, safe inside CEL and JSONata. */
const literal = (value: string): string => JSON.stringify(value);

/** CEL that reads a dot path of the response body, guarded segment by segment, giving null where absent. */
function bodyAt(path: string): { guard: string; value: string } {
  const segments = path.split('.');
  const parts: string[] = [];
  let at = 'response.body';
  for (const segment of segments) {
    parts.push(`has(${at}.${segment})`);
    at = `${at}.${segment}`;
  }
  return { guard: parts.join(' && '), value: at };
}

/** The paging expression for a style, or undefined when the draft does not page. */
export function pagingExpression(paging: DraftObject['paging']): { next: string; initial: Record<string, string> } | undefined {
  const param = paging.param !== null && QUERY_NAME.test(paging.param) ? paging.param : null;
  const size = paging.sizeParam !== null && QUERY_NAME.test(paging.sizeParam) && paging.size !== null
    ? { param: paging.sizeParam, size: paging.size } : null;
  const initial = size === null ? {} : { [size.param]: String(size.size) };
  if (paging.style === 'cursor' && param !== null && paging.path !== null && DOT_PATH.test(paging.path)) {
    const { guard, value } = bodyAt(paging.path);
    return {
      next: `${guard} && ${value} != null && string(${value}) != "" ? {"query": {${literal(param)}: string(${value})}} : stop()`,
      initial,
    };
  }
  if (paging.style === 'page' && param !== null) {
    if (paging.path !== null && DOT_PATH.test(paging.path)) {
      const { guard, value } = bodyAt(paging.path);
      return {
        next: `${guard} && ${value} != null && double(page.number) < double(${value}) ? {"query": {${literal(param)}: string(int(page.number) + 1)}} : stop()`,
        initial,
      };
    }
    // No page count: the next page while the last one was not empty.
    return { next: `page.records > 0 ? {"query": {${literal(param)}: string(int(page.number) + 1)}} : stop()`, initial };
  }
  if (paging.style === 'offset' && param !== null && size !== null) {
    return { next: `page.records == ${size.size} ? {"query": {${literal(param)}: string(int(page.received))}} : stop()`, initial };
  }
  return undefined;
}

export interface CompileNote { object: string; note: string }

/** Field names unique within an object, from a draft field's own name. */
function fieldNames(fields: DraftObject['fields']): Map<number, string> {
  const taken = new Set<string>();
  const out = new Map<number, string>();
  fields.forEach((f, i) => {
    const base = toName(f.name);
    let candidate = base;
    for (let n = 2; taken.has(candidate); n += 1) candidate = `${base.slice(0, 59)}_${n}`;
    taken.add(candidate);
    out.set(i, candidate);
  });
  return out;
}

/**
 * The manifest a draft compiles to, with what was dropped and why, and the manifest name
 * each draft object became (null where it was dropped), in draft order.
 */
export function compileDraft(draft: Draft, identity: { name: string; provider: string; version: string }, baseUrl: string | undefined)
  : { document: ManifestInput; notes: CompileNote[]; names: (string | null)[] } {
  const notes: CompileNote[] = [];
  const compiled: (string | null)[] = [];
  // Paths start with /, so a base URL's trailing / would double it.
  const url = (baseUrl ?? draft.baseUrl ?? undefined)?.replace(/\/+$/, '');
  const auth: ManifestInput['auth'] = draft.auth.strategy === 'bearer'
    ? { strategy: 'bearer', fields: [{ name: 'token', kind: 'secret', label: 'API token', role: 'token' }] }
    : draft.auth.strategy === 'basic'
      ? { strategy: 'basic', fields: [
        { name: 'username', kind: 'public', label: 'Username', role: 'username' },
        { name: 'password', kind: 'secret', label: 'Password', role: 'password' }] }
      : draft.auth.strategy === 'api_key'
        ? { strategy: 'api_key', fields: [{
          name: 'api_key', kind: 'secret', label: 'API key', role: 'api_key', location: draft.auth.location ?? 'header',
          key: draft.auth.key ?? 'Authorization', ...(draft.auth.prefix ? { prefix: draft.auth.prefix } : {}),
        }] }
        : { strategy: 'none' };

  const objectNames = new Set<string>();
  const objects: ManifestInput['objects'] = [];
  for (const o of draft.objects) {
    let objectName = toName(o.name);
    for (let n = 2; objectNames.has(objectName); n += 1) objectName = `${toName(o.name).slice(0, 59)}_${n}`;
    compiled.push(null);
    if (!PATH.test(o.path) || o.path.includes('//') || /(^|\/)\.\.?(\/|$)/.test(o.path)) {
      notes.push({ object: objectName, note: 'path_unusable' });
      continue;
    }
    const names = fieldNames(o.fields);
    const fields = o.fields.flatMap((f, i) => {
      if (!DOT_PATH.test(f.path)) {
        notes.push({ object: objectName, note: `field_path_unusable:${names.get(i)}` });
        return [];
      }
      const fieldName = names.get(i)!;
      return [{ name: fieldName, type: f.type as FieldType, ...(f.path === fieldName ? {} : { path: f.path }), provenance: 'documented' as const }];
    });
    const byDraftName = new Map(o.fields.map((f, i) => [f.name, names.get(i)!]));
    const identifierName = o.identifier === null ? undefined : byDraftName.get(o.identifier) ?? toName(o.identifier);
    if (fields.length === 0 || identifierName === undefined || !fields.some((f) => f.name === identifierName)) {
      notes.push({ object: objectName, note: fields.length === 0 ? 'no_fields' : 'no_identifier' });
      continue;
    }
    const paging = pagingExpression(o.paging);
    if (o.paging.style !== 'none' && paging === undefined) notes.push({ object: objectName, note: 'paging_incomplete' });
    const records = o.recordsPath === null || o.recordsPath === '' || o.recordsPath === '$' ? '$'
      : DOT_PATH.test(o.recordsPath) ? o.recordsPath : undefined;
    if (records === undefined) {
      notes.push({ object: objectName, note: 'records_path_unusable' });
      continue;
    }
    const filters = o.filters.flatMap((f) => {
      const field = byDraftName.get(f.field) ?? toName(f.field);
      if (!fields.some((x) => x.name === field) || !QUERY_NAME.test(f.param)) return [];
      return [{ field, ops: ['eq' as const], patch: { cel: `{"query": {${literal(f.param)}: string(value)}}` } }];
    });
    objectNames.add(objectName);
    compiled[compiled.length - 1] = objectName;
    objects.push({
      name: objectName, ...(o.label ? { label: o.label.slice(0, 200) } : {}), identifier: [identifierName], fields,
      source: {
        kind: 'rest', request: { method: 'GET', path: o.path, query: paging?.initial ?? {} }, records: { jsonata: records },
        ...(paging === undefined ? {} : { paging: { next: { cel: paging.next }, maxPages: MAX_PAGES } }),
      },
      pushdown: { filters, sort: [] },
    });
  }
  return {
    document: {
      schemaVersion: '1', identity, transport: { viaAgent: false, ...(url === undefined ? {} : { baseUrl: url }) }, protocol: { kind: 'rest' },
      auth, objects,
    },
    notes,
    names: compiled,
  };
}
