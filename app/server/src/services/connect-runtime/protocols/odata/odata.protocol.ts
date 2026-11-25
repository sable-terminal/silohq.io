// The OData protocol engine (spec 14.4: SAP S/4HANA and ECC are reached through OData; the
// discovery model is the service's $metadata). Generic: the manifest names the service path,
// the entity set and each field's EDM type; the engine writes the query from the step.
//
// - Pushdown compiles natively, as SQL's does: $filter from the step's filters (comparison,
//   in as a disjunction, contains and startswith, null), $orderby, $top, and $select of the
//   fields read. Every value is a typed OData literal the engine formats (a string quoted
//   with its quotes doubled), so a value can never become syntax.
// - Version 4.0 reads records from "value" and pages by "@odata.nextLink"; version 2.0 from
//   "d.results" and "d.__next", with $format=json, its dates (/Date(ms)/) read as instants.
// - A next link is followed only within the connection's base URL: an absolute link to
//   another host or outside the service is refused, never followed. Pages past the
//   manifest's maxPages and rows past the step's bound are refused, never truncated.
// - Sent through the credential service, which places the secret; an expired token is
//   refreshed once (rest.protocol sendOnce).

import type { EdmType, ManifestObject, OdataSource } from '../../../../contracts/connect/manifest.contract.ts';
import type { StepFilter } from '../../../../contracts/connect/step.contract.ts';
import { AppError } from '../../../../utils/errors.util.ts';
import {
  coerce, getPath, rowsBound, withRetries, type ProtocolEngine, type ReadContext, type Row,
} from '../../engine.service.ts';
import { expandPath, sendOnce, type Request } from '../rest/rest.protocol.ts';

export type OdataVersion = '4.0' | '2.0';

const NUMERIC: ReadonlySet<EdmType> = new Set(['Edm.Int16', 'Edm.Int32', 'Edm.Int64', 'Edm.Decimal', 'Edm.Double', 'Edm.Single', 'Edm.Byte', 'Edm.SByte']);

const refuse = (message: string, code: string, details?: Record<string, string>) => new AppError('validation', message, { code, ...(details ? { details } : {}) });

/** A value as an OData literal of its EDM type: the only way a value reaches a query or a key. */
export function literal(version: OdataVersion, type: EdmType, value: unknown): string {
  if (value === null || value === undefined) return 'null';
  switch (type) {
    case 'Edm.String': return `'${String(value).replaceAll("'", "''")}'`;
    case 'Edm.Boolean':
      if (typeof value !== 'boolean') throw refuse('a boolean filter takes true or false', 'odata.literal_invalid', { type });
      return value ? 'true' : 'false';
    case 'Edm.Guid': {
      const text = String(value);
      if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(text)) throw refuse('not a GUID', 'odata.literal_invalid', { type });
      return version === '2.0' ? `guid'${text}'` : text;
    }
    case 'Edm.Date': {
      const text = String(value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw refuse('not a date', 'odata.literal_invalid', { type });
      return version === '2.0' ? `datetime'${text}T00:00:00'` : text;
    }
    case 'Edm.DateTimeOffset':
    case 'Edm.DateTime': {
      const at = new Date(String(value));
      if (Number.isNaN(at.getTime())) throw refuse('not a time', 'odata.literal_invalid', { type });
      const iso = at.toISOString();
      if (version === '2.0') return type === 'Edm.DateTime' ? `datetime'${iso.replace(/Z$/, '')}'` : `datetimeoffset'${iso}'`;
      return iso;
    }
    default: {
      if (!NUMERIC.has(type)) throw refuse('a type OData filters cannot take', 'odata.literal_invalid', { type });
      const text = typeof value === 'number' ? String(value) : String(value).trim();
      if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) throw refuse('not a number', 'odata.literal_invalid', { type });
      if (version === '2.0' && type === 'Edm.Decimal') return `${text}M`;
      if (version === '2.0' && type === 'Edm.Int64') return `${text}L`;
      if (version === '2.0' && type === 'Edm.Double') return `${text}d`;
      return text;
    }
  }
}

/** A property name as the service knows it: the field's path, one segment. */
export function propertyOf(object: ManifestObject, fieldName: string): string {
  const field = object.fields.find((f) => f.name === fieldName);
  if (field === undefined) throw new AppError('integrity', 'a step names a field the object does not have', { code: 'step.field_unknown', details: { field: fieldName } });
  return field.path ?? field.name;
}

const typeOf = (source: OdataSource, property: string): EdmType => source.types[property] ?? 'Edm.String';

const OPS = { eq: 'eq', ne: 'ne', lt: 'lt', lte: 'le', gt: 'gt', gte: 'ge' } as const;

/** The step's native filters as one $filter expression, each a typed comparison. */
export function filterOf(version: OdataVersion, object: ManifestObject, source: OdataSource, filters: readonly StepFilter[]): string | undefined {
  if (filters.length === 0) return undefined;
  const terms = filters.map((f) => {
    const property = propertyOf(object, f.field);
    const type = typeOf(source, property);
    switch (f.op) {
      case 'is_null': return `${property} eq null`;
      case 'is_not_null': return `${property} ne null`;
      case 'in': {
        const values = Array.isArray(f.value) ? f.value : [f.value];
        if (values.length === 0) return 'false';
        return `(${values.map((v) => `${property} eq ${literal(version, type, v)}`).join(' or ')})`;
      }
      case 'contains': return version === '2.0' ? `substringof(${literal(version, 'Edm.String', f.value)},${property})` : `contains(${property},${literal(version, 'Edm.String', f.value)})`;
      case 'starts_with': return `startswith(${property},${literal(version, 'Edm.String', f.value)})`;
      default: return `${property} ${OPS[f.op]} ${literal(version, type, f.value)}`;
    }
  });
  return terms.join(' and ');
}

/** The key predicate addressing one entity: (value) for a single key, (a=x,b=y) for a composite one. */
export function keyPredicate(version: OdataVersion, object: ManifestObject, source: OdataSource, identifier: string): string {
  const keys = object.identifier.map((name) => propertyOf(object, name));
  if (keys.length === 1) return `(${literal(version, typeOf(source, keys[0]!), identifier)})`;
  let parts: unknown;
  try {
    parts = JSON.parse(identifier);
  } catch {
    parts = undefined;
  }
  if (parts === null || typeof parts !== 'object' || Array.isArray(parts)) {
    throw refuse('a composite key is a JSON object of its parts', 'odata.key_invalid');
  }
  return `(${object.identifier.map((name, i) => `${keys[i]}=${literal(version, typeOf(source, keys[i]!), (parts as Record<string, unknown>)[name])}`).join(',')})`;
}

export function headersFor(version: OdataVersion): Record<string, string> {
  return version === '2.0'
    ? { accept: 'application/json', dataserviceversion: '2.0', maxdataserviceversion: '2.0' }
    : { accept: 'application/json;odata.metadata=minimal', 'odata-version': '4.0', 'odata-maxversion': '4.0' };
}

export const entityPath = (source: OdataSource, params: Record<string, string>): string =>
  `${expandPath(source.servicePath, params).replace(/\/$/, '')}/${source.entitySet}`;

/** The connection's base as the credential service resolves it: an origin and a path. */
function baseOf(ctx: ReadContext): { origin: string; path: string } {
  const template = ctx.manifest.transport.baseUrl;
  const parts = template === undefined ? null : /^(https?:\/\/[^/?#]+)(\/[^?#]*)?$/.exec(template);
  if (parts === null) throw new AppError('integrity', 'an OData connector names its base URL', { code: 'manifest.base_url_invalid' });
  const fill = (text: string) => text.replace(/\{params\.([a-z][a-z0-9_]*)\}/g, (_, name: string) => ctx.params[name] ?? '');
  return { origin: new URL(fill(parts[1]!)).origin, path: fill(parts[2] ?? '').replace(/\/$/, '') };
}

/** A next link as a request on the connection, or refused: never another host, never outside the base path. */
export function followLink(ctx: ReadContext, current: Request, link: string): Request {
  const base = baseOf(ctx);
  const here = new URL(`${base.origin}${base.path}${current.path}`);
  const next = new URL(link, here);
  if (next.origin !== base.origin || !next.pathname.startsWith(`${base.path}/`)) {
    throw new AppError('upstream', 'the source\'s next link leaves the connection; it is not followed', { code: 'odata.next_link_foreign' });
  }
  return { ...current, path: next.pathname.slice(base.path.length), query: Object.fromEntries(next.searchParams) };
}

const V2_DATE = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/;

/** A record's value: version 2.0's dates read as instants. */
function valueOf(version: OdataVersion, raw: unknown): unknown {
  if (version === '2.0' && typeof raw === 'string') {
    const m = V2_DATE.exec(raw);
    if (m) return new Date(Number(m[1])).toISOString();
  }
  return raw;
}

function recordsOf(version: OdataVersion, body: unknown): { records: unknown[]; next: string | undefined } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (version === '4.0') {
    const value = b['value'];
    return { records: Array.isArray(value) ? value : [], next: typeof b['@odata.nextLink'] === 'string' ? b['@odata.nextLink'] as string : undefined };
  }
  const d = b['d'] as Record<string, unknown> | unknown[] | undefined;
  if (Array.isArray(d)) return { records: d, next: undefined };
  const results = d?.['results'];
  return { records: Array.isArray(results) ? results : d === undefined ? [] : [d], next: typeof d?.['__next'] === 'string' ? d['__next'] as string : undefined };
}

export const odataEngine: ProtocolEngine = {
  async read(ctx, object, native, fields) {
    if (object.source.kind !== 'odata' || ctx.manifest.protocol.kind !== 'odata') {
      throw new AppError('integrity', 'an OData object has an OData source', { code: 'manifest.source_kind' });
    }
    const source = object.source;
    const version = ctx.manifest.protocol.version;
    const query: Record<string, string> = {};
    const select = [...new Set(fields.map((f) => (f.path ?? f.name).split('.')[0]!))];
    if (select.length > 0) query['$select'] = select.join(',');
    const filter = filterOf(version, object, source, native.filters);
    if (filter !== undefined) query['$filter'] = filter;
    if (native.sort.length > 0) query['$orderby'] = native.sort.map((s) => `${propertyOf(object, s.field)} ${s.direction}`).join(',');
    if (native.limit !== null) query['$top'] = String(native.limit);
    if (version === '2.0') query['$format'] = 'json';
    let request: Request = { method: 'GET', path: entityPath(source, ctx.params), query, headers: headersFor(version), body: undefined };
    const rows: Row[] = [];
    for (let page = 1; ; page++) {
      const response = await withRetries(ctx, () => sendOnce(ctx, request));
      ctx.stats.pages += 1;
      const { records, next } = recordsOf(version, response.body);
      ctx.stats.sourceRows += records.length;
      for (const record of records) {
        const row: Row = {};
        for (const field of fields) row[field.name] = coerce(valueOf(version, getPath(record, field.path ?? field.name)), field.type, ctx.stats);
        rows.push(row);
      }
      if (native.limit !== null && rows.length >= native.limit) return rows.slice(0, native.limit);
      if (rows.length > ctx.maxRows) throw rowsBound(ctx);
      if (next === undefined) return rows;
      if (page >= source.maxPages) {
        throw new AppError('bounds', 'the source has more pages than the manifest allows one read; refused rather than returned in part', {
          code: 'connect.max_pages', details: { bound: 'max_pages', limit: source.maxPages },
        });
      }
      request = followLink(ctx, request, next);
    }
  },
};
