/**
 * The builder's presets: common shapes written out as expressions.
 *
 * A PRESET IS A WAY TO WRITE EXPRESSIONS, NEVER A MODE THE ENGINE KNOWS. The
 * builder offers "cursor in a query parameter" or "method, path, timestamp and
 * body, HMAC-signed"; choosing one writes the expressions below into the
 * document and records the choice under `presets` as provenance. The engine
 * never reads `presets`, so anything a preset can write, a person can write,
 * and anything neither anticipated can still be written.
 */

/** Canonical strings for `signed`, offered by the form. */
export const CANONICAL_PRESETS = {
  /** Method, path, timestamp and body — the shape most home-grown HMAC schemes use. */
  method_path_time_body: '{{ request.method & "\\n" & request.path & "\\n" & request.timestamp & "\\n" & request.body }}',
  /** A simplified RFC 9421 base over @method, @path and created. */
  rfc9421_simple: '{{ "\\"@method\\": " & request.method & "\\n\\"@path\\": " & request.path & "\\n\\"created\\": " & request.timestamp }}',
  /** Sorted query parameters concatenated as k=v — the app-proxy style some platforms use. */
  sorted_query: '{{ $join($map($sort($keys(request.query)), function($k) { $k & "=" & $lookup(request.query, $k) }), "") }}',
  /** Timestamp, a dot, the body. */
  time_dot_body: '{{ request.timestamp & "." & request.body }}',
} as const;

/* ── Presets as data ────────────────────────────────────────────────────── */

/**
 * One value a preset asks for. `kind` says how it is written into the
 * expressions: a `path` is a dotted path into a response, turned into JSONata;
 * a `header` is a response header's name; a `name` is a query or body key; a
 * `number` is a count; `text` goes in as typed.
 */
export interface PresetParameter {
  name: string;
  label: string;
  kind: 'path' | 'header' | 'name' | 'number' | 'text';
  default?: string;
  hint?: string;
}

export interface Preset {
  id: string;
  label: string;
  description: string;
  parameters: PresetParameter[];
  /** Merged into the operation: `«name»` is replaced by the parameter, written for its kind. */
  fragment: Record<string, unknown>;
}

/**
 * HOW PAGES ARE FOLLOWED. Each is a `page` block — and, where the first
 * request needs a size or a start, the query that asks for it. A short last
 * page is detected from the running count, so no preset needs to know where
 * the records are.
 */
export const PAGE_PRESETS: readonly Preset[] = [
  {
    id: 'none',
    label: 'Everything comes back at once',
    description: 'One request; no paging.',
    parameters: [],
    fragment: {},
  },
  {
    id: 'cursor_query',
    label: 'A cursor in the response, sent back as a query parameter',
    description: 'The response carries a token for the next page, which goes back in the URL.',
    parameters: [
      { name: 'param', label: 'Query parameter', kind: 'name', default: 'cursor' },
      { name: 'path', label: 'Where the cursor is in the response', kind: 'path', default: 'next_cursor' },
    ],
    fragment: {
      page: {
        next: { query: { '«param»': '{{ response.«path» }}' } },
        until: '{{ $not($exists(response.«path»)) or response.«path» = "" or response.«path» = null }}',
      },
    },
  },
  {
    id: 'cursor_body',
    label: 'A cursor in the response, sent back in the request body',
    description: 'For a list endpoint that is a POST: the cursor rides in the body, never the query.',
    parameters: [
      { name: 'param', label: 'Body field', kind: 'name', default: 'start_cursor' },
      { name: 'path', label: 'Where the cursor is in the response', kind: 'path', default: 'next_cursor' },
    ],
    fragment: {
      page: {
        next: { body: { '«param»': '{{ response.«path» }}' } },
        until: '{{ $not($exists(response.«path»)) or response.«path» = "" or response.«path» = null }}',
      },
    },
  },
  {
    id: 'last_record_id',
    label: 'The last record’s id, and a has-more flag',
    description: 'The next page starts after the last record on this one.',
    parameters: [
      { name: 'param', label: 'Query parameter', kind: 'name', default: 'starting_after' },
      { name: 'records', label: 'Where the records are', kind: 'path', default: 'data' },
      { name: 'id', label: 'The id field of a record', kind: 'path', default: 'id' },
      { name: 'more', label: 'The has-more flag', kind: 'path', default: 'has_more' },
    ],
    fragment: {
      page: {
        next: { query: { '«param»': '{{ response.«records»[-1].«id» }}' } },
        until: '{{ $not(response.«more») }}',
      },
    },
  },
  {
    id: 'link_header',
    label: 'A Link header with rel="next"',
    description: 'The next page’s whole address comes back in a header; nothing to configure.',
    parameters: [],
    fragment: { page: { next: { url: '{{ links.next }}' }, until: '{{ $not($exists(links.next)) }}' } },
  },
  {
    id: 'resume_position',
    label: 'Carry on where the last read stopped (IMAP, Kafka)',
    description: 'The protocol says where it got to in x-silo-next; the next read starts there.',
    parameters: [],
    fragment: { page: { next: { body: { position: "{{ headers.'x-silo-next' }}" } }, until: "{{ $not($exists(headers.'x-silo-next')) }}" } },
  },
  {
    id: 'next_url_in_body',
    label: 'The next page’s address in the response body',
    description: 'The response carries a full URL for the next page.',
    parameters: [{ name: 'path', label: 'Where the address is', kind: 'path', default: 'next' }],
    fragment: { page: { next: { url: '{{ response.«path» }}' }, until: '{{ $not($exists(response.«path»)) or response.«path» = null }}' } },
  },
  {
    id: 'header_token',
    label: 'A token for the next page in a response header',
    description: 'The next page is asked for with a value a response header carries.',
    parameters: [
      { name: 'header', label: 'Response header', kind: 'header', default: 'x-next-page' },
      { name: 'param', label: 'Query parameter', kind: 'name', default: 'page_token' },
    ],
    fragment: {
      page: {
        next: { query: { '«param»': '{{ headers.«header» }}' } },
        until: '{{ $not($exists(headers.«header»)) or headers.«header» = "" }}',
      },
    },
  },
  {
    id: 'offset_limit',
    label: 'An offset and a limit',
    description: 'Ask for a page size and move the offset on by it; a short page is the last.',
    parameters: [
      { name: 'offset', label: 'Offset parameter', kind: 'name', default: 'offset' },
      { name: 'limit', label: 'Limit parameter', kind: 'name', default: 'limit' },
      { name: 'size', label: 'Page size', kind: 'number', default: '100' },
    ],
    fragment: {
      request: { query: { '«limit»': '«size»', '«offset»': '0' } },
      page: {
        state: { offset: 0 },
        next: { query: { '«offset»': '{{ $string(state.offset + «size») }}' }, state: { offset: '{{ state.offset + «size» }}' } },
        until: '{{ cursor.received < cursor.page * «size» }}',
        emptyPageEnds: true,
      },
    },
  },
  {
    id: 'page_number',
    label: 'Page numbers',
    description: 'Ask for page 1, 2, 3 … of a stated size; a short page is the last.',
    parameters: [
      { name: 'page', label: 'Page parameter', kind: 'name', default: 'page' },
      { name: 'sizeParam', label: 'Page size parameter', kind: 'name', default: 'per_page' },
      { name: 'size', label: 'Page size', kind: 'number', default: '100' },
      { name: 'first', label: 'The first page’s number', kind: 'number', default: '1' },
    ],
    fragment: {
      request: { query: { '«page»': '«first»', '«sizeParam»': '«size»' } },
      page: {
        next: { query: { '«page»': '{{ $string(cursor.page + «first») }}' } },
        until: '{{ cursor.received < cursor.page * «size» }}',
        emptyPageEnds: true,
      },
    },
  },
  {
    id: 'offset_total',
    label: 'A start index and a total',
    description: 'The response says how many there are in all; stop when that many have been read.',
    parameters: [
      { name: 'start', label: 'Start parameter', kind: 'name', default: 'startAt' },
      { name: 'sizeParam', label: 'Page size parameter', kind: 'name', default: 'maxResults' },
      { name: 'size', label: 'Page size', kind: 'number', default: '100' },
      { name: 'total', label: 'Where the total is', kind: 'path', default: 'total' },
    ],
    fragment: {
      request: { query: { '«start»': '0', '«sizeParam»': '«size»' } },
      page: {
        next: { query: { '«start»': '{{ $string(cursor.received) }}' } },
        until: '{{ cursor.received >= response.«total» }}',
      },
    },
  },
  {
    id: 'graphql_relay',
    label: 'GraphQL connection (pageInfo and endCursor)',
    description: 'A Relay-style connection: the cursor goes back as the after variable.',
    parameters: [{ name: 'connection', label: 'Where the connection is', kind: 'path', default: 'data.items' }],
    fragment: {
      page: {
        next: { body: { variables: { after: '{{ response.«connection».pageInfo.endCursor }}' } } },
        until: '{{ $not(response.«connection».pageInfo.hasNextPage) }}',
      },
    },
  },
];

/** WHERE THE RECORDS ARE, and what the body is when it is not JSON. */
export const RECORDS_PRESETS: readonly Preset[] = [
  { id: 'whole_body', label: 'The records are the whole body', description: 'A JSON array.', parameters: [], fragment: { records: '{{ response }}' } },
  {
    id: 'under_path',
    label: 'The records sit under a field',
    description: 'An envelope such as { "data": [...] }.',
    parameters: [{ name: 'path', label: 'Where the records are', kind: 'path', default: 'data' }],
    fragment: { records: '{{ response.«path» }}' },
  },
  {
    id: 'jsonapi',
    label: 'JSON:API',
    description: 'Records under data, values under attributes; the id and type kept.',
    parameters: [],
    fragment: { records: '{{ response.data.$merge([attributes, { "id": id, "type": type }]) }}' },
  },
  {
    id: 'hal',
    label: 'HAL',
    description: 'Records under _embedded.',
    parameters: [{ name: 'collection', label: 'The embedded collection', kind: 'path', default: 'items' }],
    fragment: { records: '{{ response._embedded.«collection» }}' },
  },
  {
    id: 'graphql_edges',
    label: 'GraphQL edges',
    description: 'A Relay connection’s edges, each record under node.',
    parameters: [{ name: 'connection', label: 'Where the connection is', kind: 'path', default: 'data.items' }],
    fragment: { records: '{{ response.«connection».edges.node }}' },
  },
  {
    id: 'xml',
    label: 'XML',
    description: 'An XML body; one record is still a list.',
    parameters: [{ name: 'path', label: 'Where the records are', kind: 'path', default: 'Envelope.Body.Response.Item' }],
    fragment: { format: 'xml', records: '{{ $append([], response.«path») }}' },
  },
  { id: 'csv', label: 'CSV', description: 'A comma- or semicolon-separated file; each row a record.', parameters: [], fragment: { format: 'csv', records: '{{ response }}' } },
];

/**
 * HOW A FILTER IS WRITTEN, per field and operator. A style is code rather than
 * data because operators differ in shape — `in` is a list, `is_null` has no
 * value — but what it writes is ordinary pushdown templates, and every value
 * that enters a query language is quoted.
 */
export interface FilterStyle {
  id: string;
  label: string;
  description: string;
  parameters: PresetParameter[];
}

export const FILTER_STYLES: readonly FilterStyle[] = [
  {
    id: 'query_param',
    label: 'A query parameter per field',
    description: '?status=paid; operators as suffixes such as total__gte=100.',
    parameters: [{ name: 'suffixes', label: 'Operator suffixes', kind: 'text', default: 'eq=,gt=__gt,gte=__gte,lt=__lt,lte=__lte,in=__in,neq=__ne', hint: 'operator=suffix, comma separated' }],
  },
  {
    id: 'odata',
    label: 'OData $filter',
    description: "status eq 'paid' and total gt 100",
    parameters: [{ name: 'param', label: 'Query parameter', kind: 'name', default: '$filter' }],
  },
  {
    id: 'sql_like',
    label: 'A query language with SQL-style comparisons',
    description: "JQL, SOQL, CQL and their kind: Status = 'Done' AND …",
    parameters: [
      { name: 'param', label: 'Query parameter', kind: 'name', default: 'q' },
      { name: 'prefix', label: 'Text before the conditions', kind: 'text', default: '' },
      { name: 'quote', label: 'Quote style', kind: 'text', default: 'single', hint: 'single, double or backslash_double' },
    ],
  },
];

const ODATA_OPS: Record<string, string> = { eq: 'eq', neq: 'ne', gt: 'gt', gte: 'ge', lt: 'lt', lte: 'le' };
const SQL_OPS: Record<string, string> = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** Pushdown templates for `fields` × `ops` in one style. */
export function filterTemplates(
  styleId: string,
  params: Record<string, string>,
  fields: string[],
  ops: string[],
): { filters: Record<string, Record<string, unknown>>; compose?: Record<string, unknown> } {
  const filters: Record<string, Record<string, unknown>> = {};
  const scalar = '{{ $type(value) = "array" ? $join($map(value, $string), ",") : $string(value) }}';
  switch (styleId) {
    case 'query_param': {
      const suffix = Object.fromEntries(
        (params.suffixes ?? '')
          .split(',')
          .map((pair) => pair.split('=').map((part) => part.trim()))
          .filter((pair): pair is [string, string] => pair.length === 2 && pair[0] !== ''),
      );
      for (const field of fields) {
        filters[field] = Object.fromEntries(ops.filter((op) => op in suffix).map((op) => [op, { query: { [`${field}${suffix[op]}`]: scalar } }]));
      }
      return { filters };
    }
    case 'odata': {
      for (const field of fields) {
        const byOp: Record<string, unknown> = {};
        for (const op of ops) {
          if (ODATA_OPS[op]) byOp[op] = { fragment: `{{ "${field} ${ODATA_OPS[op]} " & $quote(value, 'literal_single') }}` };
          else if (op === 'contains') byOp[op] = { fragment: `{{ "contains(${field}," & $quote(value, 'literal_single') & ")" }}` };
          else if (op === 'is_null') byOp[op] = { fragment: `${field} eq null` };
          else if (op === 'in') byOp[op] = { fragment: `{{ "${field} in (" & $join($quoteEach(value, 'literal_single'), ",") & ")" }}` };
        }
        filters[field] = byOp;
      }
      return { filters, compose: { query: { [params.param ?? '$filter']: '{{ $join(fragments, " and ") }}' } } };
    }
    case 'sql_like': {
      const quote = ['single', 'double', 'backslash_single', 'backslash_double'].includes(params.quote ?? '') ? params.quote! : 'single';
      for (const field of fields) {
        const byOp: Record<string, unknown> = {};
        for (const op of ops) {
          if (SQL_OPS[op]) byOp[op] = { fragment: `{{ "${field} ${SQL_OPS[op]} " & $quote(value, '${quote}') }}` };
          else if (op === 'in') byOp[op] = { fragment: `{{ "${field} IN (" & $join($quoteEach(value, '${quote}'), ", ") & ")" }}` };
          else if (op === 'contains') byOp[op] = { fragment: `{{ "${field} LIKE " & $quote("%" & $escape(value, 'like') & "%", '${quote}') }}` };
          else if (op === 'is_null') byOp[op] = { fragment: `${field} IS NULL` };
        }
        filters[field] = byOp;
      }
      const prefix = (params.prefix ?? '').replace(/"/g, '\\"');
      return {
        filters,
        compose: { query: { [params.param ?? 'q']: `{{ "${prefix}" & ($count(fragments) > 0 ? ${prefix ? '" WHERE " & ' : ''}$join(fragments, " AND ") : "") }}` } },
      };
    }
    default:
      return { filters };
  }
}

/* ── Filling in a preset ────────────────────────────────────────────────── */

const KEYWORDS = new Set(['and', 'or', 'in', 'true', 'false', 'null', 'function']);

/** A dotted path, as JSONata: segments JSONata would read as something else are backticked. */
function asPath(path: string): string {
  return path
    .split('.')
    .filter((segment) => segment !== '')
    .map((segment) => {
      const match = /^(.*?)((?:\[-?\d+\])*)$/.exec(segment)!;
      const name = match[1]!;
      const safe = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !KEYWORDS.has(name) ? name : `\`${name.replace(/`/g, '')}\``;
      return `${safe}${match[2] ?? ''}`;
    })
    .join('.');
}

function written(parameter: PresetParameter, raw: string): string {
  switch (parameter.kind) {
    case 'path':
      return asPath(raw);
    case 'header':
      return `\`${raw.toLowerCase().replace(/`/g, '')}\``;
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? String(n) : '0';
    }
    case 'name':
    case 'text':
      return raw;
  }
}

/** A preset's fragment with every `«name»` filled in, in keys and in values. */
export function expandPreset(preset: Preset, values: Record<string, string>): Record<string, unknown> {
  const filled = Object.fromEntries(preset.parameters.map((p) => [p.name, written(p, values[p.name] ?? p.default ?? '')]));
  const fill = (text: string) => text.replace(/«([A-Za-z]+)»/g, (_, name: string) => filled[name] ?? '');
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      /* A value that is wholly one number placeholder becomes a number, where the schema wants one. */
      const whole = /^«([A-Za-z]+)»$/.exec(node);
      const parameter = whole ? preset.parameters.find((p) => p.name === whole[1]) : undefined;
      if (parameter?.kind === 'number' && !node.includes('{{')) return fill(node);
      return fill(node);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [fill(k), walk(v)]));
    return node;
  };
  return walk(preset.fragment) as Record<string, unknown>;
}
