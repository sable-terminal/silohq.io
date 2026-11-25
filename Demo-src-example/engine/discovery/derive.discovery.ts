import { getIntrospectionQuery } from 'graphql';
import { compileGraphql } from '../compile/graphql.compile';
import { compileOpenApi, parseSpecification } from '../compile/openapi.compile';
import { candidatesFromResponse, pagingFragment, type PagingCandidate } from '../compile/paging.compile';
import { fieldsBlock, identifierOf, keyPath, singular, type CompiledField, type FieldType } from '../compile/shared.compile';

/**
 * Connect first, then find out what the system holds (MANIFEST-V2 WP10).
 *
 * ── A SPECIFICATION IF THE SYSTEM PUBLISHES ONE ──────────────────────────
 *
 * Most APIs serve their own OpenAPI document at one of a handful of places,
 * and a GraphQL server will describe itself when asked. Those are tried first,
 * with the connection's own credential, and compiled.
 *
 * ── OTHERWISE, WHAT A READ SHOWS ─────────────────────────────────────────
 *
 * For each path the person names, one read: where the records are, their
 * fields and types from their STRUCTURE — values are looked at to decide a
 * type and never kept — and which field identifies one. Paging is proposed
 * from what the response carries and KEPT ONLY IF a second page is fetched
 * and holds different records. At most thirty requests in all.
 */

export interface Prober {
  /** One request on the connection, authenticated as it is; the parsed body and headers, or null when it failed. */
  fetch(request: { method?: 'GET' | 'POST'; path: string; query?: Record<string, string>; body?: unknown; format?: 'auto' | 'text' }): Promise<{ body: unknown; headers: Record<string, string | string[]> } | null>;
  /** A read of one drafted object, page by page, as the engine would run it; the raw records of each page, or null when it failed. */
  pages(object: Record<string, unknown>, maxPages: number): Promise<unknown[][] | null>;
}

export interface Derived {
  objects: Array<Record<string, unknown>>;
  /** A whole document, when a specification was found and compiled. */
  compiledFrom: 'openapi' | 'graphql' | null;
  notes: string[];
  requests: number;
}

const MAX_REQUESTS = 30;
const SPEC_PATHS = ['/openapi.json', '/openapi.yaml', '/swagger.json', '/v3/api-docs', '/api-docs', '/swagger/v1/swagger.json', '/.well-known/openapi.json'];
const RECORD_KEYS = ['data', 'items', 'results', 'records', 'values', 'value', 'entries', 'list', 'rows', 'objects', 'elements', 'content', 'nodes'];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The largest list of records in a body, within three levels: its path, and the records. */
export function recordsIn(body: unknown): { path: string | null; records: Json[] } | null {
  if (Array.isArray(body)) return body.every(isObject) && body.length > 0 ? { path: null, records: body as Json[] } : null;
  if (!isObject(body)) return null;
  let best: { path: string; records: Json[]; score: number } | null = null;
  const visit = (node: Json, path: string[], depth: number) => {
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value) && value.length > 0 && value.every(isObject)) {
        const score = value.length + (RECORD_KEYS.includes(key) ? 1_000 : 0) - depth;
        if (!best || score > best.score) best = { path: [...path, key].map(keyPath).join('.'), records: value as Json[], score };
      } else if (isObject(value) && depth < 3) {
        visit(value, [...path, key], depth + 1);
      }
    }
  };
  visit(body, [], 0);
  const found = best as { path: string; records: Json[] } | null;
  return found ? { path: found.path, records: found.records } : null;
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMEY = /(^|_)(at|time|timestamp|date|created|updated|modified)$|At$|Time$|Timestamp$/;

/**
 * A field's type from the values of one page. The values decide the type and
 * are then dropped: nothing about a record leaves this function but its shape.
 * A number that is plainly an epoch in a field named for a time becomes a
 * datetime, normalised as it is read (§3.6).
 */
export function fieldsFrom(records: Json[]): CompiledField[] {
  const keys = new Map<string, unknown[]>();
  for (const record of records.slice(0, 50)) for (const [k, v] of Object.entries(record)) keys.set(k, [...(keys.get(k) ?? []), v]);
  const fields: CompiledField[] = [];
  for (const [name, values] of keys) {
    const present = values.filter((v) => v !== null && v !== undefined);
    let type: FieldType = 'unknown';
    let expression: string | undefined;
    if (present.length > 0) {
      if (present.every((v) => typeof v === 'boolean')) type = 'boolean';
      else if (present.every((v) => typeof v === 'number')) {
        type = 'number';
        const nums = present as number[];
        if (TIMEY.test(name) && nums.every((n) => n > 1e9 && n < 1e10)) {
          type = 'datetime';
          expression = `{{ $fromMillis(${keyPath(name)} * 1000) }}`;
        } else if (TIMEY.test(name) && nums.every((n) => n > 1e12 && n < 1e13)) {
          type = 'datetime';
          expression = `{{ $fromMillis(${keyPath(name)}) }}`;
        }
      } else if (present.every((v) => typeof v === 'string')) {
        const strings = present as string[];
        type = strings.every((s) => ISO_DATETIME.test(s)) ? 'datetime' : strings.every((s) => ISO_DATE.test(s)) ? 'date' : 'string';
      } else if (present.every((v) => typeof v === 'object')) type = 'json';
      else type = 'string';
    }
    fields.push({ name, type, ...(expression ? { expression } : {}) });
  }
  return fields;
}

function uniqueIdentifier(records: Json[], fields: string[], objectName: string): string[] | null {
  const ordered = [...identifierOf(fields, objectName), ...fields.filter((f) => /id$/i.test(f))];
  for (const candidate of [...new Set(ordered)]) {
    const values = records.map((r) => r[candidate]);
    if (values.every((v) => v !== null && v !== undefined && typeof v !== 'object') && new Set(values.map(String)).size === values.length) return [candidate];
  }
  return null;
}

/** A candidate's size made small enough that one page cannot be all of them, for the check. */
function small(candidate: PagingCandidate, seen: number): PagingCandidate {
  if (!candidate.values.size) return candidate;
  return { ...candidate, values: { ...candidate.values, size: String(Math.max(1, Math.floor(seen / 2))) } };
}

export async function derive(prober: Prober, input: { kind: 'https_rest' | 'graphql' | 'soap'; baseUrl: string; paths: string[] }): Promise<Derived> {
  const notes: string[] = [];
  let requests = 0;
  const spend = () => ++requests <= MAX_REQUESTS;

  /* ── A specification it publishes ── */
  if (input.kind === 'graphql') {
    spend();
    const answer = await prober.fetch({ method: 'POST', path: '', body: { query: getIntrospectionQuery() } });
    const schema = isObject(answer?.body) && isObject((answer!.body as Json).data) ? answer!.body : null;
    if (schema) {
      const compiled = compileGraphql(schema, { endpoint: input.baseUrl });
      return { objects: (compiled.document.objects as Json[]) ?? [], compiledFrom: 'graphql', notes: compiled.notes.filter((n) => !n.startsWith('Introspection does not say')), requests };
    }
    notes.push('The server does not answer introspection, so name the queries to read and build them in the builder.');
    return { objects: [], compiledFrom: null, notes, requests };
  }
  if (input.kind === 'https_rest') {
    for (const path of SPEC_PATHS) {
      if (!spend()) break;
      const answer = await prober.fetch({ path, format: 'text' });
      if (!answer || typeof answer.body !== 'string') continue;
      try {
        const spec = parseSpecification(answer.body) as Json;
        if (!isObject(spec) || (!spec.openapi && !spec.swagger)) continue;
        const compiled = compileOpenApi(spec, { baseUrl: input.baseUrl });
        const objects = (compiled.document.objects as Json[]) ?? [];
        if (objects.length === 0) continue;
        return { objects, compiledFrom: 'openapi', notes: [`Compiled from the specification the system serves at ${path}.`, ...compiled.notes], requests };
      } catch {
        /* not a specification: the next place, or the paths */
      }
    }
  }

  /* ── What a read of each named path shows ── */
  const objects: Json[] = [];
  const names = new Set<string>();
  for (const raw of input.paths) {
    if (requests >= MAX_REQUESTS) {
      notes.push('Stopped after thirty requests; derive the rest separately.');
      break;
    }
    const [path, search] = raw.split('?') as [string, string | undefined];
    const query = Object.fromEntries(new URLSearchParams(search ?? ''));
    spend();
    const first = await prober.fetch({ path, query });
    if (!first) {
      notes.push(`${path} could not be read with this connection.`);
      continue;
    }
    const found = recordsIn(first.body);
    if (!found) {
      notes.push(`${path} did not return a list of records.`);
      continue;
    }
    const segments = path.split('/').filter((s) => s && !/^v\d+/i.test(s) && !/^\{/.test(s));
    let objectName = singular(segments.at(-1) ?? 'record');
    if (names.has(objectName)) objectName = singular(segments.slice(-2).join('_'));
    names.add(objectName);

    const block = fieldsBlock(fieldsFrom(found.records));
    const fieldNames = block.fields.map((f) => f.name);
    const identifier = uniqueIdentifier(found.records, fieldNames, objectName);
    if (!identifier) notes.push(`${objectName}: no field was unique across the first page; say which identifies a record.`);
    const records = found.path ? `{{ response.${found.path} }}` : '{{ response }}';
    const object: Json = {
      name: objectName,
      identifier: identifier ?? identifierOf(fieldNames, objectName),
      fields: block.fields,
      read: {
        request: { path, ...(Object.keys(query).length ? { query } : {}) },
        records,
        ...(Object.keys(block.expressions).length ? { fields: block.expressions } : {}),
      },
    };

    /* ── Paging, kept only if a second page differs ── */
    const candidates = candidatesFromResponse({ body: first.body, headers: first.headers, recordsPath: found.path, queryParams: Object.keys(query) });
    let confirmed: PagingCandidate | null = null;
    for (const candidate of candidates.slice(0, 4)) {
      if (requests + 2 > MAX_REQUESTS) break;
      const trial = pagingFragment(small(candidate, found.records.length));
      const read = object.read as Json;
      const attempt = {
        ...object,
        read: {
          ...read,
          request: { ...(read.request as Json), ...(isObject(trial.request) ? { query: { ...((read.request as Json).query as Json), ...((trial.request as Json).query as Json) } } : {}) },
          page: { ...(trial.page as Json), maxPages: 2 },
        },
      };
      requests += 2;
      const pages = await prober.pages(attempt, 2);
      if (!pages || pages.length < 2 || pages[1]!.length === 0) continue;
      const key = (identifier ?? fieldNames.slice(0, 1))[0]!;
      const one = new Set(pages[0]!.map((r) => String((r as Json)[key])));
      if (pages[1]!.some((r) => !one.has(String((r as Json)[key])))) {
        confirmed = candidate;
        break;
      }
    }
    if (confirmed) {
      const fragment = pagingFragment(confirmed);
      const read = object.read as Json;
      if (isObject(fragment.request)) read.request = { ...(read.request as Json), query: { ...((read.request as Json).query as Json), ...((fragment.request as Json).query as Json) } };
      read.page = fragment.page;
      notes.push(`${objectName}: paging by ${confirmed.because.replace(/\.$/, '')} — confirmed by reading a second page.`);
    } else {
      notes.push(`${objectName}: no paging could be confirmed; one page is read. If the list is longer, add paging and test it.`);
    }
    objects.push(object);
  }
  if (objects.length === 0 && input.paths.length === 0) notes.push('The system publishes no specification Silo could find. Name the paths that list records.');
  return { objects, compiledFrom: null, notes, requests };
}
