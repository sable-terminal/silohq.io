import type { Meaning, TransportV2 } from '../../schemas/manifest.schema';
import { sendWithHandshake } from '../auth/handshake.auth';
import { sendHttp } from '../../infra/network.infra';
import { parseRetryAfter } from '../../utils/backoff.util';
import { refusal } from '../../utils/error.util';
import { serialiseXml } from '../formats/xml.format';
import { setPath } from '../expression/paths.expression';
import type {
  AuthSurface,
  CanonicalRequest,
  EvaluatedRequest,
  Headers,
  SocketAuth,
  Transport,
  WireRequest,
  WireResponse,
} from './contract.transport';

/**
 * REST, GraphQL and SOAP: three protocols on one wire.
 *
 * The runner has already evaluated every header — the transport's constant ones
 * and the operation's — so `prepare` copies, never evaluates.
 *
 * ── ONE WIRE, BECAUSE IT IS ONE WIRE ──────────────────────────────────────
 *
 * All three are an HTTPS request with a method, a URL, headers and a body. They
 * differ only in how the body is shaped — a GraphQL document with variables, a
 * SOAP envelope with a header — and in what a failure looks like. So the wire,
 * the auth surface, the canonical view and `send` are written once here, and
 * each protocol is its `prepare` and its `floor`.
 *
 * ── THE QUERY STRING A URL ARRIVED WITH IS SENT BYTE FOR BYTE ─────────────
 *
 * A presigned download link carries its signature in its query string. Parsing
 * it and writing it back re-encodes it — a space as `+` rather than `%20` — and
 * the signature no longer matches. So the query a URL already had is kept as
 * text, and what the connector adds is appended after it.
 *
 * ── THE BODY IS ENCODED AT THE LAST MOMENT ────────────────────────────────
 *
 * Auth may still place a value in the body — a key in a JSON field, a password
 * in a form, a token in a SOAP header — after `prepare`. The body is a tree
 * until `send`, and `encode` is the one function both `send` and the canonical
 * view use, so a signature is always over the bytes that are sent.
 */

export interface HttpShapedWire extends WireRequest {
  kind: 'https_rest' | 'graphql' | 'soap';
  method: string;
  /** Scheme, host and path. */
  base: string;
  /** The query the URL already had, exactly as written. */
  rawQuery: string;
  /** What the connector and auth add, in order. */
  query: Array<[string, string]>;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  body: unknown;
  contentType: 'json' | 'form' | 'xml' | 'text';
  /** Form fields auth places. Merged into a form body, or they make the body a form. */
  form: Record<string, string>;
  /** SOAP only: the envelope's header, built from the connector's and auth's entries. */
  soap?: { version: '1.1' | '1.2'; header: Record<string, unknown>; action: string | null };
}

/* ── Encoding ───────────────────────────────────────────────────────────── */

/** RFC 3986 query encoding: a space is `%20`, which every server reads and every signature expects. */
const encodeQuery = (text: string): string =>
  encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function queryString(wire: HttpShapedWire): string {
  const added = wire.query.map(([name, value]) => `${encodeQuery(name)}=${encodeQuery(value)}`).join('&');
  return [wire.rawQuery, added].filter((part) => part !== '').join('&');
}

export function urlOf(wire: HttpShapedWire): string {
  const query = queryString(wire);
  return query ? `${wire.base}?${query}` : wire.base;
}

const SOAP_NAMESPACE = {
  '1.1': 'http://schemas.xmlsoap.org/soap/envelope/',
  '1.2': 'http://www.w3.org/2003/05/soap-envelope',
};

/** The bytes that go on the wire, and the content type that says what they are. */
export function encode(wire: HttpShapedWire): { body: string | null; contentType: string | null } {
  if (wire.soap) {
    const envelope: Record<string, unknown> = { '@xmlns:soap': SOAP_NAMESPACE[wire.soap.version] };
    if (Object.keys(wire.soap.header).length > 0) envelope['soap:Header'] = wire.soap.header;
    envelope['soap:Body'] = wire.body ?? {};
    const xml = `<?xml version="1.0" encoding="utf-8"?>${serialiseXml({ 'soap:Envelope': envelope })}`;
    const type =
      wire.soap.version === '1.1'
        ? 'text/xml; charset=utf-8'
        : `application/soap+xml; charset=utf-8${wire.soap.action ? `; action="${wire.soap.action}"` : ''}`;
    return { body: xml, contentType: type };
  }

  const hasForm = Object.keys(wire.form).length > 0;
  if (wire.body === undefined && !hasForm) return { body: null, contentType: null };

  if (wire.contentType === 'form' || (hasForm && (wire.body === undefined || wire.body === null))) {
    const pairs: Array<[string, string]> = [];
    if (wire.body && typeof wire.body === 'object') {
      for (const [name, value] of Object.entries(wire.body as Record<string, unknown>)) {
        if (value === null || value === undefined) continue;
        if (Array.isArray(value)) for (const one of value) pairs.push([name, scalar(one)]);
        else pairs.push([name, scalar(value)]);
      }
    }
    for (const [name, value] of Object.entries(wire.form)) pairs.push([name, value]);
    return {
      body: pairs.map(([name, value]) => `${encodeQuery(name)}=${encodeQuery(value)}`).join('&'),
      contentType: 'application/x-www-form-urlencoded',
    };
  }

  if (hasForm) {
    throw refusal({
      message: 'This connector places a credential in a form field, but the request body is not a form.',
      code: 'refusal.auth_place_unsupported',
    });
  }

  switch (wire.contentType) {
    case 'json':
      return { body: JSON.stringify(wire.body), contentType: 'application/json' };
    case 'xml':
      return {
        body: typeof wire.body === 'string' ? wire.body : serialiseXml(wire.body),
        contentType: 'application/xml; charset=utf-8',
      };
    case 'text':
      return { body: scalar(wire.body), contentType: 'text/plain; charset=utf-8' };
  }
}

const scalar = (value: unknown): string =>
  value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);

/** Headers as sent: the content type unless the connector set one, and the cookie jar. */
function headersOf(wire: HttpShapedWire, contentType: string | null): Record<string, string> {
  const headers: Record<string, string> = { ...wire.headers };
  if (contentType && !Object.keys(headers).some((name) => name === 'content-type')) headers['content-type'] = contentType;
  if (wire.soap?.version === '1.1' && wire.soap.action !== null) headers.soapaction ??= `"${wire.soap.action}"`;
  const jar = Object.entries(wire.cookies);
  if (jar.length > 0) {
    const mine = jar.map(([name, value]) => `${name}=${value}`).join('; ');
    headers.cookie = headers.cookie ? `${headers.cookie}; ${mine}` : mine;
  }
  if (!headers.accept) headers.accept = wire.soap ? 'text/xml, application/soap+xml, */*;q=0.5' : 'application/json, */*;q=0.5';
  return headers;
}

/* ── Shared halves ──────────────────────────────────────────────────────── */

function surfaceOf(wire: HttpShapedWire, socket: SocketAuth): AuthSurface {
  return {
    setHeader(name, value) {
      wire.headers[name.toLowerCase()] = value;
    },
    setQuery(name, value) {
      const at = wire.query.findIndex(([one]) => one === name);
      if (at === -1) wire.query.push([name, value]);
      else wire.query[at] = [name, value];
    },
    setBodyPath(path, value) {
      if (wire.contentType === 'form' && !path.includes('.')) {
        wire.form[path] = value;
        return;
      }
      if (wire.body !== undefined && (typeof wire.body !== 'object' || wire.body === null)) {
        throw refusal({
          message: `This connector places a credential at body:${path}, but the request body is not a document with fields.`,
          code: 'refusal.auth_place_unsupported',
        });
      }
      wire.body = setPath(wire.body ?? {}, path, value);
    },
    setCookie(name, value) {
      wire.cookies[name] = value;
    },
    setForm(name, value) {
      wire.form[name] = value;
    },
    setSoapHeader(path, value) {
      if (!wire.soap) {
        throw refusal({
          message: `A credential can only be placed at soap:${path} on a SOAP connection.`,
          code: 'refusal.auth_place_unsupported',
        });
      }
      wire.soap.header = setPath(wire.soap.header, path.split('/').join('.'), value) as Record<string, unknown>;
    },
    socket,
  };
}

function canonical(wire: HttpShapedWire, stamp: { timestamp: string; nonce: string }): CanonicalRequest {
  const encoded = encode(wire);
  const url = new URL(wire.base);
  const query: Record<string, string | string[]> = {};
  const all = [...new URLSearchParams(wire.rawQuery), ...wire.query];
  for (const [name, value] of all) {
    const existing = query[name];
    query[name] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return {
    method: wire.method,
    host: url.host,
    baseUrl: wire.base,
    path: url.pathname,
    query,
    queryString: queryString(wire),
    headers: headersOf(wire, encoded.contentType),
    body: encoded.body ?? '',
    timestamp: stamp.timestamp,
    nonce: stamp.nonce,
  };
}

async function send(wire: HttpShapedWire, options: Parameters<Transport['send']>[1]): Promise<WireResponse> {
  const encoded = encode(wire);
  if (options.socket.handshake) {
    return sendWithHandshake(
      { url: urlOf(wire), method: wire.method, headers: headersOf(wire, encoded.contentType), body: encoded.body },
      options.socket,
      { tls: options.socket.tls, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes, retry: false, signal: options.signal, allowPrivate: options.inAgent === true, inAgent: options.inAgent === true },
    );
  }
  return sendHttp(
    { url: urlOf(wire), method: wire.method, headers: headersOf(wire, encoded.contentType), body: encoded.body },
    /* Inside the agent the target is private by design; the agent's own list is the guard there. */
    { tls: options.socket.tls, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes, retry: options.retry, signal: options.signal, allowPrivate: options.inAgent === true },
  );
}

const retryAfterOf = (headers: Headers): number | undefined => {
  const raw = headers['retry-after'];
  const one = Array.isArray(raw) ? raw[0] : raw;
  if (!one) return undefined;
  const ms = parseRetryAfter(one);
  return ms === null || ms === undefined ? undefined : Math.ceil(ms / 1_000);
};

/** What an HTTP status means when the connector says nothing. */
function statusFloor(res: WireResponse): { means: Meaning; retryAfterSeconds?: number } | null {
  const status = res.status ?? 0;
  if (status < 400) return null;
  if (status === 401 || status === 403) return { means: 'auth' };
  if (status === 404 || status === 410) return { means: 'not_found' };
  if (status === 429) return { means: 'rate_limit', retryAfterSeconds: retryAfterOf(res.headers) };
  if (status === 413 || status === 414) return { means: 'bounds' };
  if (status === 503 && res.headers['retry-after']) return { means: 'rate_limit', retryAfterSeconds: retryAfterOf(res.headers) };
  return { means: 'upstream' };
}

/** Split an absolute URL into what is kept as written and what is not. */
function baseOf(url: URL): { base: string; rawQuery: string } {
  return { base: `${url.origin}${url.pathname}`, rawQuery: url.search.replace(/^\?/, '') };
}

function pairsOf(query: EvaluatedRequest['query']): Array<[string, string]> {
  return Object.entries(query).flatMap(([name, value]) =>
    Array.isArray(value) ? value.map((one): [string, string] => [name, one]) : [[name, value] as [string, string]],
  );
}

function needUrl(request: EvaluatedRequest): URL {
  if (!request.url) {
    throw refusal({ message: 'This request has no address.', code: 'refusal.request_unbuildable' });
  }
  return request.url;
}

const lowerKeys = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

/* ── REST ───────────────────────────────────────────────────────────────── */

export const rest: Transport<HttpShapedWire> = {
  kind: 'https_rest',
  writes: true,

  prepare({ transport, request }) {
    void transport;
    const url = needUrl(request);
    return {
      kind: 'https_rest',
      method: request.method,
      ...baseOf(url),
      query: pairsOf(request.query),
      headers: lowerKeys(request.headers),
      cookies: {},
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body ?? undefined,
      contentType: request.contentType,
      form: {},
    };
  },

  authSurface: surfaceOf,
  canonicalView: canonical,
  send,
  floor: statusFloor,
};

/* ── GraphQL ────────────────────────────────────────────────────────────── */

/**
 * GRAPHQL ANSWERS 200 WHEN IT FAILS. A response with `errors` and no `data` is a
 * failure whatever its status; one with both is a partial answer, which the
 * connector's own error rules may choose to refuse — the floor does not guess.
 */
export const graphql: Transport<HttpShapedWire> = {
  kind: 'graphql',
  writes: true,

  prepare({ transport, request }) {
    void transport;
    const url = needUrl(request);
    const method = request.method === 'GET' ? 'GET' : 'POST';
    const body = (request.body ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
    const wire: HttpShapedWire = {
      kind: 'graphql',
      method,
      ...baseOf(url),
      query: [],
      headers: lowerKeys(request.headers),
      cookies: {},
      body: undefined,
      contentType: 'json',
      form: {},
    };
    if (method === 'GET') {
      wire.query.push(['query', String(body.query ?? '')]);
      if (body.variables !== undefined) wire.query.push(['variables', JSON.stringify(body.variables)]);
      if (body.operationName) wire.query.push(['operationName', String(body.operationName)]);
    } else {
      wire.body = {
        query: body.query,
        ...(body.variables !== undefined ? { variables: body.variables } : {}),
        ...(body.operationName ? { operationName: body.operationName } : {}),
      };
    }
    return wire;
  },

  authSurface: surfaceOf,
  canonicalView: canonical,
  send,

  floor(res, _wire) {
    const status = statusFloor(res);
    if (status) return status;
    try {
      const parsed = JSON.parse(res.body.toString('utf8')) as { data?: unknown; errors?: unknown[] };
      if (Array.isArray(parsed.errors) && parsed.errors.length > 0 && (parsed.data === null || parsed.data === undefined)) {
        return { means: 'upstream' };
      }
    } catch {
      /* not JSON: the parser will say so */
    }
    return null;
  },
};

/* ── SOAP ───────────────────────────────────────────────────────────────── */

/**
 * SOAP 1.1 FAULTS ARE A 500. A fault that says the credentials are wrong is
 * still an authentication failure, and the connector's error rules — which see
 * the parsed fault — say so; the floor only knows that a 500 is not an answer.
 */
export const soap: Transport<HttpShapedWire> = {
  kind: 'soap',
  writes: true,

  prepare({ transport, request }) {
    const url = needUrl(request);
    const t = transport as Extract<TransportV2, { kind: 'soap' }>;
    return {
      kind: 'soap',
      method: 'POST',
      ...baseOf(url),
      query: pairsOf(request.query),
      headers: lowerKeys(request.headers),
      cookies: {},
      body: request.body ?? {},
      contentType: 'xml',
      form: {},
      soap: {
        version: t.soapVersion ?? '1.1',
        header: (request.soapHeaders as Record<string, unknown> | undefined) ?? {},
        action: request.action ?? null,
      },
    };
  },

  authSurface: surfaceOf,
  canonicalView: canonical,
  send,
  floor: statusFloor,
};
