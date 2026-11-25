// The REST protocol engine (spec 14.4, 14.5). Generic: the manifest says where an object is
// read, how the records sit in a response (JSONata), how a field is found in a record, how
// pushdown changes the request (CEL patches), how a page leads to the next (CEL), and what
// a failure means. The engine sends each request through the credential service, which
// places the secret; it never sees one.
//
// Paging stops when the expression returns null, or refuses when it would go past the
// manifest's page bound. Rows past the step's bound are refused, never truncated. A token
// that expired is refreshed once, under the OAuth engine's lock, and the request retried.

import type { PreparedRequest } from '../../../../contracts/credential/connectionCredential.contract.ts';
import type { ErrorMeaning, ManifestField, ManifestObject, RequestPatch, RestSource } from '../../../../contracts/connect/manifest.contract.ts';
import type { PushdownSplit } from '../../../../contracts/connect/step.contract.ts';
import { AppError, isAppError } from '../../../../utils/errors.util.ts';
import { parseLinkHeader } from '../../../expression-evaluator/library.service.ts';
import { compileExpression } from '../../../expression-evaluator/evaluator.service.ts';
import { restPatches } from '../../../pushdown-compiler/compile.service.ts';
import {
  checkDeadline, classify, coerce, getPath, limited, rowsBound, SourceError, withRetries, type ErrorInput, type ProtocolEngine, type ReadContext, type Row,
} from '../../engine.service.ts';

/** HTTP's own meanings, after the manifest's rules (spec 14.5 errors.defaults: http_standard). */
export function httpStandard(input: ErrorInput): ErrorMeaning | undefined {
  const { status } = input;
  if (status >= 200 && status < 300) return undefined;
  if (status === 401 || status === 403) return 'auth';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 409 || status === 412) return 'conflict';
  if (status === 413 || status === 414) return 'bounds';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'upstream';
  if (status >= 400) return 'validation';
  return 'upstream'; // 1xx and 3xx: redirects are never followed
}

export interface Request {
  method: PreparedRequest['method'];
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export const expandPath = (path: string, params: Record<string, string>): string =>
  path.replace(/\{params\.([a-z][a-z0-9_]*)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new AppError('validation', 'the connection is missing a parameter the request needs', { code: 'connection.parameter_missing', details: { parameter: name } });
    }
    return encodeURIComponent(value);
  });

const queryText = (value: string | number | boolean): string => String(value);

export function applyPatch(request: Request, patch: RequestPatch, params: Record<string, string>): Request {
  const next: Request = { ...request, query: { ...request.query }, headers: { ...request.headers } };
  if (patch.path !== undefined) next.path = expandPath(patch.path, params);
  for (const [key, value] of Object.entries(patch.query ?? {})) {
    if (value === null) delete next.query[key];
    else next.query[key] = queryText(value);
  }
  for (const [key, value] of Object.entries(patch.headers ?? {})) {
    if (value === null) delete next.headers[key.toLowerCase()];
    else next.headers[key.toLowerCase()] = value;
  }
  if (patch.body !== undefined) {
    const base = typeof next.body === 'object' && next.body !== null && !Array.isArray(next.body) ? next.body as Record<string, unknown> : {};
    next.body = { ...base, ...patch.body };
  }
  return next;
}

function initial(source: RestSource, params: Record<string, string>): Request {
  const { request } = source;
  return {
    method: request.method,
    path: expandPath(request.path, params),
    query: Object.fromEntries(Object.entries(request.query).map(([k, v]) => [k, queryText(v)])),
    headers: Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v])),
    body: request.body,
  };
}

export async function sendOnce(ctx: ReadContext, request: Request): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const prepared: PreparedRequest = {
    method: request.method, path: request.path, query: request.query, headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body as never }),
  };
  let refreshed = false;
  for (;;) {
    checkDeadline(ctx);
    let response;
    try {
      response = await limited(ctx, () => ctx.send(prepared));
    } catch (error) {
      // The credential service saw the token expire before sending: refresh once.
      if (isAppError(error) && error.code === 'credential.token_expired' && !refreshed) {
        refreshed = true;
        await ctx.refresh();
        continue;
      }
      throw error;
    }
    let body: unknown = null;
    const text = response.body.trim();
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
        if (response.status >= 200 && response.status < 300) {
          throw new SourceError('upstream', { reason: 'response_not_json', status: response.status });
        }
      }
    }
    const error = await classify(ctx.manifest, { status: response.status, headers: response.headers, body, sqlstate: '' }, httpStandard, ctx.now);
    if (error === undefined) return { status: response.status, headers: response.headers, body };
    // A provider that rejects an expired token (not yet past its recorded expiry): refresh once.
    if (error.meaning === 'auth' && !refreshed && ctx.manifest.auth.strategy.startsWith('oauth2_')) {
      refreshed = true;
      await ctx.refresh();
      continue;
    }
    throw new SourceError(error.meaning, { status: response.status }, error.retryAfterMs);
  }
}

async function toRows(ctx: ReadContext, records: unknown[], fields: readonly ManifestField[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const record of records) {
    const row: Row = {};
    for (const field of fields) {
      const raw = field.value === undefined ? getPath(record, field.path ?? field.name)
        : await compileExpression('field', 'jsonata', field.value.jsonata).evaluate({ input: record, params: ctx.params }, ctx.now);
      row[field.name] = coerce(raw, field.type, ctx.stats);
    }
    rows.push(row);
  }
  return rows;
}

export const restEngine: ProtocolEngine = {
  async read(ctx, object: ManifestObject, native: PushdownSplit['native'], fields) {
    if (object.source.kind !== 'rest') throw new AppError('integrity', 'a REST object has a REST source', { code: 'manifest.source_kind' });
    const source = object.source;
    let request = initial(source, ctx.params);
    for (const patch of await restPatches(object, native, ctx.params, ctx.now)) request = applyPatch(request, patch, ctx.params);
    const records = compileExpression('records', 'jsonata', source.records.jsonata);
    const next = source.paging === undefined ? undefined : compileExpression('paging.next', 'cel', source.paging.next.cel);
    const maxPages = source.paging?.maxPages ?? 1;
    const limit = native.limit;
    const rows: Row[] = [];

    for (let page = 1; ; page++) {
      const response = await withRetries(ctx, () => sendOnce(ctx, request));
      ctx.stats.pages += 1;
      const found = await records.evaluate({ input: response.body, headers: response.headers, params: ctx.params }, ctx.now);
      const list = Array.isArray(found) ? found : found === null ? [] : [found];
      ctx.stats.sourceRows += list.length;
      rows.push(...await toRows(ctx, list, fields));
      if (limit !== null && rows.length >= limit) return rows.slice(0, limit);
      if (rows.length > ctx.maxRows) throw rowsBound(ctx);
      if (next === undefined) return rows;
      const patch = await next.evaluate({
        request: { method: request.method, path: request.path, query: request.query, headers: request.headers, body: request.body ?? null },
        response: { status: response.status, headers: response.headers, body: response.body },
        page: { number: page, records: list.length, received: rows.length },
        links: response.headers['link'] === undefined ? {} : parseLinkHeader(response.headers['link']),
        params: ctx.params,
      }, ctx.now) as RequestPatch | null;
      if (patch === null) return rows;
      if (page >= maxPages) {
        throw new AppError('bounds', 'the source has more pages than the manifest allows one read; refused rather than returned in part', {
          code: 'connect.max_pages', details: { bound: 'max_pages', limit: maxPages },
        });
      }
      request = applyPatch(request, patch, ctx.params);
    }
  },
};
