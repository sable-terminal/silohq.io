// The GraphQL protocol engine (docs/siloServiceCatalogue.doc.md; spec 14.4, 14.5). Generic:
// the manifest names the root query field, its typed variables, where the records sit and
// how a page leads to the next; the engine builds the query from the plan (the fields
// asked for), sends it through the credential service, which places the secret, and reads
// the records. Pushdown and paging change variables only, never the query's shape, so the
// query text never holds a value.
//
// A GraphQL server answers most failures with 200 and an errors list. Those are errors
// here, never partial data: the manifest's rules first, then HTTP's meaning, then the
// error's extensions code. Rows past the step's bound and pages past the manifest's are
// refused, never truncated. An expired token is refreshed once, under the OAuth lock.

import type { PreparedRequest } from '../../../../contracts/credential/connectionCredential.contract.ts';
import type { ErrorMeaning, GraphqlSource, ManifestObject, RequestPatch } from '../../../../contracts/connect/manifest.contract.ts';
import { AppError, isAppError } from '../../../../utils/errors.util.ts';
import { compileExpression } from '../../../expression-evaluator/evaluator.service.ts';
import { restPatches } from '../../../pushdown-compiler/compile.service.ts';
import {
  checkDeadline, classify, coerce, getPath, limited, rowsBound, SourceError, withRetries, type ErrorInput, type ProtocolEngine, type ReadContext, type Row,
} from '../../engine.service.ts';
import { httpStandard } from '../rest/rest.protocol.ts';
import { buildQuery, recordsAt } from './query.protocol.ts';

// Extensions codes in common use across GraphQL servers, and the GraphQL over HTTP draft's.
const CODES: Readonly<Record<string, ErrorMeaning>> = {
  UNAUTHENTICATED: 'auth', FORBIDDEN: 'auth', UNAUTHORIZED: 'auth', 'access-denied': 'auth',
  NOT_FOUND: 'not_found', RATE_LIMITED: 'rate_limit', THROTTLED: 'rate_limit', TOO_MANY_REQUESTS: 'rate_limit',
  BAD_USER_INPUT: 'validation', GRAPHQL_VALIDATION_FAILED: 'validation', GRAPHQL_PARSE_FAILED: 'validation', 'validation-failed': 'validation',
  MAX_COMPLEXITY: 'bounds', QUERY_TOO_COMPLEX: 'bounds',
};

/** HTTP's meaning, then a 200 carrying errors by its first error's extensions code. */
export function graphqlStandard(input: ErrorInput): ErrorMeaning | undefined {
  const http = httpStandard(input);
  if (http !== undefined) return http;
  const errors = (input.body as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const code = (errors[0] as { extensions?: { code?: unknown } } | null)?.extensions?.code;
  return typeof code === 'string' && CODES[code] !== undefined ? CODES[code] : 'upstream';
}

/** The source's path with the connection's parameters, each one path-encoded. */
export const expandPath = (path: string, params: Record<string, string>): string =>
  path.replace(/\{params\.([a-z][a-z0-9_]*)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new AppError('validation', 'the connection is missing a parameter the request needs', { code: 'connection.parameter_missing', details: { parameter: name } });
    }
    return encodeURIComponent(value);
  });

/** Applies the variables of a patch; anything else in it is a manifest fault. Only declared variables may be set. */
function applyVariables(source: GraphqlSource, variables: Record<string, unknown>, patch: RequestPatch): Record<string, unknown> {
  if (patch.path !== undefined || patch.query !== undefined || patch.headers !== undefined || patch.body !== undefined) {
    throw new AppError('integrity', 'a GraphQL patch changes variables only', { code: 'graphql.patch_not_variables' });
  }
  const declared = new Set(source.variables.map((v) => v.name));
  const next = { ...variables };
  for (const [name, value] of Object.entries(patch.variables ?? {})) {
    if (!declared.has(name)) throw new AppError('integrity', 'a patch sets a variable the query does not declare', { code: 'graphql.variable_undeclared', details: { variable: name } });
    if (value === null) delete next[name];
    else next[name] = value;
  }
  return next;
}

export async function sendOnce(ctx: ReadContext, path: string, query: string, variables: Record<string, unknown>)
  : Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const prepared: PreparedRequest = { method: 'POST', path, query: {}, headers: {}, body: { query, variables } as never };
  let refreshed = false;
  for (;;) {
    checkDeadline(ctx);
    let response;
    try {
      response = await limited(ctx, () => ctx.send(prepared));
    } catch (error) {
      if (isAppError(error) && error.code === 'credential.token_expired' && !refreshed) {
        refreshed = true;
        await ctx.refresh();
        continue;
      }
      throw error;
    }
    let body: unknown = null;
    if (response.body.trim() !== '') {
      try {
        body = JSON.parse(response.body);
      } catch {
        if (response.status >= 200 && response.status < 300) throw new SourceError('upstream', { reason: 'response_not_json', status: response.status });
      }
    }
    const error = await classify(ctx.manifest, { status: response.status, headers: response.headers, body, sqlstate: '' }, graphqlStandard, ctx.now);
    if (error === undefined) return { status: response.status, headers: response.headers, body };
    if (error.meaning === 'auth' && !refreshed && ctx.manifest.auth.strategy.startsWith('oauth2_')) {
      refreshed = true;
      await ctx.refresh();
      continue;
    }
    throw new SourceError(error.meaning, { status: response.status }, error.retryAfterMs);
  }
}

export const graphqlEngine: ProtocolEngine = {
  async read(ctx, object: ManifestObject, native, fields) {
    if (object.source.kind !== 'graphql') throw new AppError('integrity', 'a GraphQL object has a GraphQL source', { code: 'manifest.source_kind' });
    const source = object.source;
    const path = expandPath(source.path, ctx.params);
    const query = buildQuery(source, fields);
    let variables: Record<string, unknown> = { ...source.constants };
    for (const patch of await restPatches(object, native, ctx.params, ctx.now)) variables = applyVariables(source, variables, patch);
    const next = source.paging === undefined ? undefined : compileExpression('paging.next', 'cel', source.paging.next.cel);
    const maxPages = source.paging?.maxPages ?? 1;
    const rows: Row[] = [];

    for (let page = 1; ; page++) {
      const sent = variables;
      const response = await withRetries(ctx, () => sendOnce(ctx, path, query, sent));
      ctx.stats.pages += 1;
      const result = (response.body as { data?: Record<string, unknown> | null } | null)?.data?.[source.root];
      const records = result === undefined || result === null ? [] : recordsAt(result, source.recordPath);
      ctx.stats.sourceRows += records.length;
      for (const record of records) {
        const row: Row = {};
        for (const field of fields) row[field.name] = coerce(getPath(record, field.path ?? field.name), field.type, ctx.stats);
        rows.push(row);
      }
      if (native.limit !== null && rows.length >= native.limit) return rows.slice(0, native.limit);
      if (rows.length > ctx.maxRows) throw rowsBound(ctx);
      if (next === undefined) return rows;
      const patch = await next.evaluate({
        request: { variables: sent },
        response: { status: response.status, headers: response.headers, body: response.body },
        page: { number: page, records: records.length, received: rows.length },
        links: {},
        params: ctx.params,
      }, ctx.now) as RequestPatch | null;
      if (patch === null) return rows;
      if (page >= maxPages) {
        throw new AppError('bounds', 'the source has more pages than the manifest allows one read; refused rather than returned in part', {
          code: 'connect.max_pages', details: { bound: 'max_pages', limit: maxPages },
        });
      }
      variables = applyVariables(source, variables, patch);
    }
  },
};
