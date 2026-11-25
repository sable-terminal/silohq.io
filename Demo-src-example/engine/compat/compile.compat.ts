import { manifest as v1Schema, type Manifest as V1, type ManifestObject as V1Object } from './manifestV1.compat';
import type { AuthStrategy as V1Auth } from './connectorAuthV1.compat';
import { manifestV2, type ManifestV2 } from '../../schemas/manifest.schema';
import { refusal } from '../../utils/error.util';
import { CANONICAL_PRESETS } from './presets.compat';

/**
 * A v1 document, as the v2 document that does exactly what it did.
 *
 * ── THE ENGINE EXECUTES V2 ONLY, AND STORED ROWS ARE NEVER REWRITTEN ──────
 *
 * A connector version is cited by the figures it produced, so its document is
 * never edited in place. It is compiled here each time it is loaded (MANIFEST-V2
 * §4), and the compile is total: every v1 document that validates compiles,
 * except the three things v1 stored and never executed — a JSONata
 * `transform`, and the inbound webhook verification schemes that were filed
 * under outbound signing.
 *
 * ── FAITHFUL, NOT IMPROVED ────────────────────────────────────────────────
 *
 * `strictFields: false` and `emptyPageEnds: true` where v1 stopped on a short
 * page, because that is what v1 did. A behaviour change on upgrade is a
 * connector that answered yesterday and answers differently today, with
 * nothing in its history to say why.
 */

export interface Compiled {
  manifest: ManifestV2;
  /** What the compile could not carry over and why — shown in the builder, never silent. */
  notes: string[];
}

/**
 * v1 strategy names a connection may have been recorded with, as the v2
 * alternative the compile produces for it.
 */
export const V1_STRATEGY: Readonly<Record<string, string>> = {
  jwt_bearer_assertion: 'jwt_assertion',
  session_cookie: 'placed',
  hmac_signed: 'signed',
};

export function compileV1(document: unknown): Compiled {
  const v1 = v1Schema.parse(document);
  const notes: string[] = [];
  const out = {
    schemaVersion: 2,
    identity: v1.identity,
    ...(v1.setup ? { setup: v1.setup } : {}),
    transport: transportOf(v1, notes),
    auth: v1.auth.flatMap((a) => authOf(a, v1, notes)),
    parameters: parametersOf(v1),
    credentialSharing: v1.credentialSharing,
    objects: v1.objects.map((o) => objectOf(o, v1, notes)),
    errors: v1.errors.map((e) =>
      e.kind === 'http' ? { when: `{{ status = ${e.status} }}`, means: e.means } : { when: `{{ code = "${String(e.code)}" }}`, means: e.means },
    ),
    rateLimits: { ...v1.rateLimits, concurrency: 4 },
    mappings: v1.mappings,
  };
  if (out.auth.length === 0 && v1.auth.length > 0) {
    throw refusal({
      message: 'None of this connector’s v1 authentication ever ran, so there is nothing to carry over. Declare how it authenticates.',
      code: 'refusal.v1_auth_never_executable',
      detail: { notes },
    });
  }
  return { manifest: manifestV2.parse(out), notes };
}

/* ── Transport ──────────────────────────────────────────────────────────── */

const SQL_DRIVER = { postgres: ['pg', 'postgres'], mysql: ['mysql2', 'mysql'], mssql: ['mssql', 'tsql'], oracle: ['oracledb', 'oracle'], odbc: ['odbc', 'ansi'] } as const;

function transportOf(v1: V1, notes: string[]): Record<string, unknown> {
  const t = v1.transport;
  const mtls = v1.auth.some((a) => a.strategy === 'mtls');
  switch (t.kind) {
    case 'https_rest':
      return { kind: 'https_rest', baseUrl: t.baseUrl, headers: t.headers, tls: { minVersion: t.minTlsVersion, clientCertificate: mtls } };
    case 'graphql':
      return { kind: 'graphql', endpoint: t.endpoint, tls: { clientCertificate: mtls } };
    case 'soap': {
      /* v1 posted to the WSDL's address with its query removed. */
      const endpoint = new URL(t.wsdlUrl);
      endpoint.search = '';
      return { kind: 'soap', endpoint: endpoint.toString(), wsdlUrl: t.wsdlUrl, tls: { clientCertificate: mtls } };
    }
    case 'sql_odbc': {
      const [driver, grammar] = SQL_DRIVER[t.driver];
      if (driver === 'odbc') notes.push('The ODBC bridge runs in the Silo agent; this connection needs one.');
      return {
        kind: 'sql',
        driver,
        grammar,
        host: t.host,
        port: t.port,
        database: t.database,
        schema: t.schema,
        ...(driver === 'odbc' ? { via: { agent: true } } : {}),
      };
    }
    case 'sftp_file':
      return { kind: 'sftp', host: t.host, port: t.port, directory: t.path };
    case 'inbound_webhook':
    case 'email_fallback':
      return { kind: t.kind };
    case 'silo_import':
      return { kind: 'silo_import', sourceId: t.sourceId };
  }
}

/* ── Auth ───────────────────────────────────────────────────────────────── */

function authOf(a: V1Auth, v1: V1, notes: string[]): Array<Record<string, unknown>> {
  switch (a.strategy) {
    case 'jwt_bearer_assertion':
      return [
        {
          strategy: 'jwt_assertion',
          algorithm: a.algorithm,
          claims: { iss: a.issuer, aud: a.audience, ...(a.scopes.length > 0 ? { scope: a.scopes.join(' ') } : {}) },
          /* v1 never checked the audience against the endpoint, so neither does its compile. */
          audienceIsOpaque: true,
          exchange: { tokenUrl: a.tokenUrl },
        },
      ];
    case 'session_cookie':
      /*
       * v1 NEVER LOGGED IN. It sent the stored secret as the Cookie header, so
       * that is what the compile does; a real login is `session`.
       */
      return [{ strategy: 'placed', places: { secret: 'header:cookie' } }];
    case 'hmac_signed':
      if (a.canonicalisation === 'rfc9421') {
        return [
          {
            strategy: 'signed',
            algorithm: 'hmac_sha256',
            canonical: CANONICAL_PRESETS.rfc9421_simple,
            encoding: 'base64',
            place: `header:${a.signatureName}`,
            keyId: { place: `${a.keyIdPlacement}:${a.keyIdName}` },
            timestamp: { place: 'header:x-timestamp' },
          },
        ];
      }
      /*
       * v1 EXECUTED NO SIGNING SCHEME AT ALL — it refused every request that
       * needed one — and the other names in its list were webhook verification,
       * which is inbound. Nothing that worked is lost by dropping them.
       */
      notes.push(`The v1 signing scheme ${a.canonicalisation} never ran and is not carried over; declare a signed strategy instead.`);
      return [];
    case 'oauth2_authorization_code':
    case 'oauth2_pkce':
    case 'oauth2_client_credentials':
    case 'api_key_header':
    case 'api_key_query':
    case 'bearer':
    case 'basic':
    case 'mtls':
      return [{ ...a }];
  }
  void v1;
}

function parametersOf(_v1: V1): Record<string, unknown> {
  return {};
}

/* ── Objects ────────────────────────────────────────────────────────────── */

function objectOf(o: V1Object, v1: V1, notes: string[]): Record<string, unknown> {
  const response = o.read?.response ?? v1.response;
  const pagination = o.read?.pagination ?? v1.pagination;

  if (response.transform) {
    throw refusal({
      message: `The connector's ${o.name} carries a JSONata transform, which v1 stored and never ran. Place it into the object's records or fields expressions.`,
      code: 'refusal.v1_transform_never_executable',
      detail: { object: o.name, transform: response.transform },
    });
  }

  const base = {
    name: o.name,
    identifier: o.identifier,
    fields: o.fields,
    relationships: o.relationships,
    available: o.available,
    history: o.history,
  };

  switch (v1.transport.kind) {
    case 'https_rest':
      return { ...base, read: restRead(o, v1, response, pagination), ...writesOf(o, v1, notes) };
    case 'graphql':
      return { ...base, read: graphqlRead(o, v1, response, pagination, notes) };
    case 'soap':
      return { ...base, read: soapRead(o, response) };
    case 'sql_odbc':
      return { ...base, read: { request: { table: o.path }, pushdown: sqlPushdown(o, v1) }, ...sqlWrites(v1) };
    case 'sftp_file':
      return {
        ...base,
        read: {
          request: { path: o.path },
          format: response.shape === 'csv' ? 'csv' : 'auto',
          records: '{{ response }}',
          fields: fieldsOf(response.fields),
          strictFields: false,
        },
      };
    case 'inbound_webhook':
    case 'email_fallback': {
      /* v1 took the record at `recordPath` when it was there, and the whole body when it was not. */
      const path = response.recordPath ? `response.${toJsonata(response.recordPath)}` : null;
      const records = path ? `{{ $exists(${path}) and $type(${path}) = "object" ? ${path} : response }}` : '{{ response }}';
      return { ...base, read: { request: {}, records, strictFields: false } };
    }
    case 'silo_import':
      return { ...base, read: { request: {}, records: '{{ response }}', strictFields: false } };
  }
}

/* Records, fields and format from a v1 `response`. */
function shapeOf(response: V1['response'], fallbackPath: string | null): { format?: string; records: string; formatOptions?: Record<string, unknown> } {
  const path = response.recordPath ? toJsonata(response.recordPath) : fallbackPath;
  switch (response.shape) {
    case 'array':
      return { records: '{{ response }}' };
    case 'enveloped':
      return { records: path ? `{{ response.${path} }}` : '{{ response }}' };
    case 'jsonapi':
      return { records: `{{ response.${path ?? 'data'}.$merge([attributes, { "id": id, "type": type }]) }}` };
    case 'hal':
      return { records: path ? `{{ response._embedded.${path} }}` : '{{ response._embedded.* }}' };
    case 'xml':
      return { format: 'xml', records: path ? `{{ $append([], response.${path}) }}` : '{{ $append([], response) }}' };
    case 'csv':
      return { format: 'csv', records: '{{ response }}', formatOptions: { delimiter: 'auto', header: true } };
  }
}

function fieldsOf(fields: V1['response']['fields']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, where] of Object.entries(fields ?? {})) {
    out[name] = Array.isArray(where)
      ? `{{ [${where.map(toJsonata).join(', ')}][$ != null][0] }}`
      : `{{ ${toJsonata(where)} }}`;
  }
  return out;
}

/** v1's `{name}` holes as v2 parameters, and its path as a request path. */
const holes = (path: string): string => path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '{{ params.$1 }}');

function restRead(o: V1Object, v1: V1, response: V1['response'], pagination: V1['pagination']): Record<string, unknown> {
  const read = o.read;
  const shape = shapeOf(response, null);
  const request: Record<string, unknown> = {
    method: read?.method ?? 'GET',
    path: holes(read?.path ?? o.path),
    params: read?.params ?? {},
    headers: read?.headers ?? {},
    query: { ...(read?.query ?? {}) },
    ...(read?.body ? { body: read.body } : {}),
  };
  const page = pageOf(pagination, shape.records, request);
  return {
    request,
    ...(shape.format ? { format: shape.format } : {}),
    ...(shape.formatOptions ? { formatOptions: shape.formatOptions } : {}),
    records: shape.records,
    fields: fieldsOf(response.fields),
    strictFields: false,
    ...(page ? { page } : {}),
    pushdown: httpPushdown(o, v1),
  };
}

/* ── Paging (§4.1) ──────────────────────────────────────────────────────── */

const inner = (records: string) => records.replace(/^\{\{\s*|\s*\}\}$/g, '');

function pageOf(p: V1['pagination'], records: string, request: Record<string, unknown>): Record<string, unknown> | null {
  const query = request.query as Record<string, string>;
  switch (p.strategy) {
    case 'none':
      return null;
    case 'offset_limit':
      query[p.limitParam] = String(p.pageSize);
      query[p.offsetParam] = '0';
      return {
        state: { offset: 0 },
        next: {
          query: { [p.offsetParam]: `{{ $string(state.offset + ${p.pageSize}) }}` },
          state: { offset: `{{ state.offset + ${p.pageSize} }}` },
        },
        until: `{{ $count(${inner(records)}) < ${p.pageSize} }}`,
        emptyPageEnds: true,
      };
    case 'page_number':
      query[p.pageParam] = String(p.firstPage);
      query[p.sizeParam] = String(p.pageSize);
      return {
        next: { query: { [p.pageParam]: `{{ $string(cursor.page + ${p.firstPage}) }}` } },
        until: `{{ $count(${inner(records)}) < ${p.pageSize} }}`,
        emptyPageEnds: true,
      };
    case 'cursor': {
      const at = `response.${toJsonata(p.cursorPath)}`;
      const until = `{{ $not($exists(${at})) or ${at} = "" or ${at} = null }}`;
      if (p.where === 'body') {
        if (p.limitParam) request.body = { ...((request.body as object) ?? {}), [p.limitParam]: p.pageSize };
        return { next: { body: { [p.cursorParam]: `{{ ${at} }}` } }, until };
      }
      if (p.limitParam) query[p.limitParam] = String(p.pageSize);
      return { next: { query: { [p.cursorParam]: `{{ ${at} }}` } }, until };
    }
    case 'link_header':
      return { next: { url: '{{ links.next }}' }, until: '{{ $not($exists(links.next)) }}' };
    case 'body_token': {
      const at = `response.${toJsonata(p.tokenPath)}`;
      return { next: { query: { [p.tokenParam]: `{{ ${at} }}` } }, until: `{{ $not($exists(${at})) or ${at} = "" or ${at} = null }}` };
    }
    case 'scroll':
      query.scroll = p.keepAlive;
      return {
        next: { query: { [p.scrollParam]: `{{ response.${toJsonata(p.scrollPath)} }}` } },
        until: `{{ $count(${inner(records)}) = 0 }}`,
        emptyPageEnds: true,
      };
  }
}

/* ── Pushdown (§4.3) ────────────────────────────────────────────────────── */

const SCALAR = '$type(value) = "array" ? $join($map(value, $string), ",") : $string(value)';
const ODATA: Record<string, string> = { eq: 'eq', neq: 'ne', gt: 'gt', gte: 'ge', lt: 'lt', lte: 'le' };
const RSQL: Record<string, string> = { eq: '==', neq: '!=', gt: '=gt=', gte: '=ge=', lt: '=lt=', lte: '=le=' };

function httpPushdown(o: V1Object, v1: V1): Record<string, unknown> {
  const caps = v1.capabilities;
  const enc = caps.filterEncoding;
  const filters: Record<string, Record<string, unknown>> = {};
  let compose: Record<string, unknown> | undefined;

  for (const f of o.fields) {
    const byOp: Record<string, unknown> = {};
    for (const op of caps.filters) {
      switch (enc.style) {
        case 'query_param': {
          const suffix = enc.operatorSuffix[op];
          if (suffix === undefined && op !== 'eq') continue;
          byOp[op] = { query: { [`${f.name}${suffix ?? ''}`]: `{{ ${SCALAR} }}` } };
          break;
        }
        case 'jsonapi':
          if (op === 'eq') byOp[op] = { query: { [`filter[${f.name}]`]: `{{ ${SCALAR} }}` } };
          break;
        case 'odata': {
          const quoted = '$quote(value, "literal_single")';
          if (op === 'is_null') byOp[op] = { fragment: `${f.name} eq null` };
          else if (op === 'contains') byOp[op] = { fragment: `{{ "contains(${f.name}," & $quote(value, "single") & ")" }}` };
          else if (ODATA[op]) byOp[op] = { fragment: `{{ "${f.name} ${ODATA[op]} " & ${quoted} }}` };
          compose = { query: { [enc.param]: '{{ $join(fragments, " and ") }}' } };
          break;
        }
        case 'rsql': {
          if (op === 'in') byOp[op] = { fragment: `{{ "${f.name}=in=(" & $join($quoteEach(value, "double"), ",") & ")" }}` };
          else if (op === 'contains') byOp[op] = { fragment: `{{ "${f.name}==" & $quote("*" & $escape(value, "backslash") & "*", "double") }}` };
          else if (RSQL[op]) byOp[op] = { fragment: `{{ "${f.name}${RSQL[op]}" & $quote(value, "double") }}` };
          compose = { query: { [enc.param]: '{{ $join(fragments, ";") }}' } };
          break;
        }
      }
    }
    if (Object.keys(byOp).length > 0) filters[f.name] = byOp;
  }

  return {
    filters,
    ...(caps.sort
      ? { sort: { query: { sort: '{{ $join($map(order, function($s) { ($s.direction = "desc" ? "-" : "") & $s.field }), ",") }}' } } }
      : {}),
    ...(caps.fieldSelection ? { fields: { query: { fields: '{{ $join(fields, ",") }}' } } } : {}),
    ...(compose ? { compose } : {}),
    maxFilterValues: caps.maxFilterValues,
  };
}

/** SQL derives its pushdown; a v1 document that declared fewer operators keeps that restriction. */
function sqlPushdown(o: V1Object, v1: V1): Record<string, unknown> | undefined {
  const all = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null'];
  const declared = v1.capabilities.filters;
  if (all.every((op) => declared.includes(op as never))) return undefined;
  const filters: Record<string, Record<string, unknown>> = {};
  for (const f of o.fields) {
    filters[f.name] = Object.fromEntries(declared.map((op) => [op, { where: { column: f.name } }]));
  }
  return { filters, maxFilterValues: v1.capabilities.maxFilterValues };
}

/* ── GraphQL and SOAP (§4.5) ────────────────────────────────────────────── */

function graphqlRead(o: V1Object, v1: V1, response: V1['response'], pagination: V1['pagination'], notes: string[]): Record<string, unknown> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.path)) {
    throw refusal({
      message: `${o.name} names ${o.path} as its GraphQL field, which is not a field name.`,
      code: 'refusal.request_unbuildable',
      detail: { object: o.name },
    });
  }
  const names = o.fields.map((f) => f.name).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  const edges = (response.recordPath ?? '').includes('edges');
  const cursor = pagination.strategy === 'cursor';
  const selection = edges ? `edges { node { ${names.join(' ')} } } pageInfo { hasNextPage endCursor }` : cursor ? `${names.join(' ')} pageInfo { hasNextPage endCursor }` : names.join(' ');
  const args = cursor ? '(first: $first, after: $after)' : '';
  const variables = cursor ? '($first: Int, $after: String)' : '';
  if (v1.capabilities.filters.length > 0) {
    notes.push('v1 wrote GraphQL filters into the document as literals; v2 documents are literal, so filters on this connector are applied by Silo until the connector declares them as variables.');
  }
  const records = response.recordPath
    ? `{{ response.${toJsonata(response.recordPath)}${edges && !/edges$/.test(response.recordPath) ? '' : ''} }}`
    : `{{ response.data.${o.path} }}`;
  return {
    request: {
      method: 'POST',
      body: {
        query: `query${variables} { ${o.path}${args} { ${selection} } }`,
        ...(cursor ? { variables: { first: pagination.pageSize } } : {}),
      },
    },
    records: edges ? `{{ ${inner(records)}.node ? ${inner(records)}.node : ${inner(records)} }}` : records,
    strictFields: false,
    ...(cursor
      ? {
          page: {
            next: { body: { variables: { after: `{{ response.data.${o.path}.pageInfo.endCursor }}` } } },
            until: `{{ $not(response.data.${o.path}.pageInfo.hasNextPage) }}`,
          },
        }
      : {}),
  };
}

function soapRead(o: V1Object, response: V1['response']): Record<string, unknown> {
  const path = response.recordPath ? toJsonata(response.recordPath) : `Envelope.Body.${o.path}Response`;
  return {
    request: { action: o.path, body: { [o.path]: {} } },
    format: 'xml',
    records: `{{ $append([], response.${path}) }}`,
    strictFields: false,
  };
}

/* ── Writes (§4.4) ──────────────────────────────────────────────────────── */

function writesOf(o: V1Object, v1: V1, notes: string[]): Record<string, unknown> {
  const m = v1.mutation;
  const p = holes(o.path);
  if (o.identifier.length > 1 && (m.updateFull || m.updatePartial || m.delete || m.upsert)) {
    notes.push(`${o.name} has a composite identifier; its write paths use the first part and need checking.`);
  }
  const id = `{{ identifier.${o.identifier[0]} }}`;
  const result = v1.response.recordPath ? `{{ response.${toJsonata(v1.response.recordPath)} }}` : '{{ response }}';
  const operations: Record<string, unknown> = {};
  if (m.create) operations.create = { request: { method: 'POST', path: p, body: '{{ values }}' }, result };
  if (m.updateFull) operations.update_full = { request: { method: 'PUT', path: `${p}/${id}`, body: '{{ values }}' } };
  if (m.updatePartial) operations.update_partial = { request: { method: 'PATCH', path: `${p}/${id}`, body: '{{ values }}' } };
  if (m.delete) operations.delete = { request: { method: 'DELETE', path: `${p}/${id}` } };
  if (m.upsert) operations.upsert = { request: { method: 'PUT', path: `${p}/${id}`, body: '{{ values }}' } };
  for (const action of m.customActions) operations[action.name] = { request: { method: 'POST', path: holes(action.path), body: '{{ values }}' } };
  if (m.batch) notes.push('v1 declared batch writes and never executed them; they are not carried over.');
  return Object.keys(operations).length > 0 ? { write: { operations } } : {};
}

function sqlWrites(v1: V1): Record<string, unknown> {
  const m = v1.mutation;
  const operations: Record<string, unknown> = {};
  if (m.create) operations.create = {};
  if (m.updateFull || m.updatePartial) operations.update = {};
  if (m.delete) operations.delete = {};
  if (m.upsert) operations.upsert = {};
  return Object.keys(operations).length > 0 ? { write: { operations } } : {};
}

/* ── Paths (§4.6) ───────────────────────────────────────────────────────── */

const KEYWORDS = new Set(['and', 'or', 'in', 'true', 'false', 'null', 'function']);

/**
 * A v1 dotted path as JSONata: dots and indexes carry over, negative indexes
 * included (JSONata counts `[-1]` from the end), and a segment JSONata would
 * read as something else is backticked.
 */
export function toJsonata(path: string): string {
  return path
    .split('.')
    .filter((s) => s !== '')
    .map((segment) => {
      const match = /^(.*?)((?:\[-?\d+\])*)$/.exec(segment)!;
      const name = match[1]!;
      const indexes = match[2] ?? '';
      const safe = name === '' ? '' : /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !KEYWORDS.has(name) ? name : `\`${name.replace(/`/g, '')}\``;
      return `${safe}${indexes}`;
    })
    .join('.');
}
