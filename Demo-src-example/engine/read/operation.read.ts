import { createHash } from 'node:crypto';
import type { ObjectV2, OperationV2, RequestV2, WriteOperationV2 } from '../../schemas/manifest.schema';
import { PROTOCOL_OF } from '../../schemas/manifest.schema';
import { CONNECTOR_TIMEOUT_MS } from '../../config/constants.config';
import { bounds, refusal, upstream } from '../../utils/error.util';
import { applyAuth } from '../auth/apply.auth';
import { deep, every, path as pathOf, text, truth, value, type Scope } from '../expression/evaluate.expression';
import type { Pushdown, Query } from '../execution/query.execution';
import { decode, parseBody } from '../formats/index.format';
import type { EvaluatedRequest, Headers, QueryValue, SocketAuth, WireRequest, WireResponse } from '../transports/contract.transport';
import { listedOf, listedValue } from '../discovery/fields.discovery';
import { transportFor } from '../transports/index.transport';
import { handlesFor } from './blob.read';
import { baseAddress, connectionSettings, resolveTls, type ReadContext } from './context.read';
import { judge, raise } from './errors.read';
import { joinPath } from './address.read';
import { mergeDeep, mergeMap } from './merge.read';
import { columnOf, renderAggregate, renderPushdown, renderSql, type Patchable, type Rendered } from './pushdown.read';

/**
 * ONE REQUEST, FOLLOWED THROUGH ITS PAGES, TURNED INTO RECORDS
 * (MANIFEST-V2 §3.1, with §9's revisions).
 *
 * ── THE ORDER, WITH NOTHING LEFT TO CHOOSE ────────────────────────────────
 *
 *   build      the request from the operation, over params, state and steps
 *   pushdown   filters → sort → limit → fields → compose
 *   state      the paging bag, initialised with the request and fragments bound;
 *              the request is then rebuilt with it, so both can see the other
 *   loop       prepare → auth → send → parse → errors → records → fields → next
 *
 * ── EVERY STOP IS A DECISION, AND A SILENT ONE IS A BUG ───────────────────
 *
 * A read ends when it has what was asked for, when `until` holds, or when there
 * is no paging. It REFUSES when a page repeats, when a `next` address leaves the
 * source, when the ceiling is reached before the answer is complete, and when
 * pages keep coming back empty while the connector says there are more. It
 * never quietly returns what it had so far.
 */

export interface AggregateAsk {
  kind: 'count' | 'sum' | 'group_by';
  field: string | null;
  by: string | null;
}

export interface OperationInput {
  ctx: ReadContext;
  /** Already merged with the manifest's defaults. */
  operation: OperationV2;
  /** Pipelines bind `steps`, `item` and `previous`. */
  scope: Scope;
  query: Query;
  plan: Pushdown;
  want: number;
  /** Map records to the object's fields here, page by page — a pipeline step does not. */
  project: { object: ObjectV2; fields: Record<string, string>; strict: boolean } | null;
  aggregate?: AggregateAsk | null;
  /** The errors after the operation's own: the defaults' and the manifest's. */
  fallbackErrors: OperationV2['errors'];
}

export interface OperationOutput {
  records: unknown[];
  pages: number;
  requests: number;
  lastResponse: unknown;
  lastHeaders: Headers;
  rendered: Rendered;
  aggregate: unknown;
}

/** Three empty pages in a row, while the connector says there are more, is not an answer. */
const EMPTY_PAGES_TOLERATED = 3;

export interface Draft extends Patchable {
  /** What only some protocols read — a table, a mailbox, a topic — worked out. */
  protocol: Record<string, unknown>;
  method: string;
  /** An absolute address — `request.url`, or a `next.url` — instead of base + path. */
  absolute: URL | null;
  auth: 'connection' | 'none';
  contentType: EvaluatedRequest['contentType'];
  soapHeaders: unknown;
  action: string | null;
}

export async function runOperation(input: OperationInput): Promise<OperationOutput> {
  const { ctx, operation: op, query, plan } = input;
  const transport = transportFor(ctx.manifest.transport.kind);
  const protocol = PROTOCOL_OF[ctx.manifest.transport.kind];
  const params = { ...ctx.params, ...op.request.params };
  const base = await baseAddress(ctx.manifest.transport, params);
  const tls = await resolveTls(ctx.manifest.transport, params);
  const startedAt = ctx.budget.clock.now();
  const hasSource = op.request.source !== undefined;
  const connection = await connectionSettings(ctx.manifest.transport, params);
  /* A database and a Silo import take the whole question; their pushdown is derived, not declared. */
  const isSql = ctx.manifest.transport.kind === 'sql' || ctx.manifest.transport.kind === 'silo_import';

  /* ── build, pushdown, state ── */
  const build = async (state: Record<string, unknown>): Promise<{ draft: Draft; rendered: Rendered }> => {
    const scope: Scope = { ...input.scope, params, listed: listedOf(ctx.object), state, cursor: { page: 0, received: 0 } };
    const draft = await buildDraft(ctx, op.request, scope);
    if (isSql) {
      const sql = await renderSql({ target: draft, operation: op, object: ctx.object, plan, query, want: input.want, params });
      draft.protocol.columns ??= sql.columns;
      return { draft, rendered: sql };
    }
    const rendered = await renderPushdown({
      target: draft,
      pushdown: op.pushdown,
      object: ctx.object,
      plan,
      query,
      want: input.want,
      maxRecords: op.maxRecords,
      params,
    });
    return { draft, rendered };
  };

  /*
   * A STATEMENT RUNS ONLY IF IT IS THE ONE THE ADMIN WAS SHOWN. A new version
   * of the connector with a different statement waits for somebody to confirm
   * it rather than running it on their data.
   */
  if (isSql && op.request.statement !== undefined && ctx.statementConfirmed && !ctx.statementConfirmed(op.request.statement)) {
    throw refusal({
      message: `The statement ${ctx.object.name} runs is not the one confirmed for this connection. An admin confirms it where the connection's connector version is chosen.`,
      code: 'refusal.statement_not_confirmed',
    });
  }

  let { draft, rendered } = await build({});
  let state: Record<string, unknown> = {};
  if (op.page && Object.keys(op.page.state).length > 0) {
    state = ((await deep(op.page.state, {
      ...input.scope,
      params,
      fragments: rendered.fragments,
      order: rendered.order,
      limit: rendered.limit,
      fields: rendered.fields,
      request: viewOf(draft, base),
    })) ?? {}) as Record<string, unknown>;
    ({ draft, rendered } = await build(state));
  }

  let aggregateDecl: Awaited<ReturnType<typeof renderAggregate>> = null;
  let sqlAggregate: EvaluatedRequest['aggregate'] = null;
  if (input.aggregate && isSql) {
    /* A database totals by itself; nothing needs declaring. */
    const column = input.aggregate.field ? columnOf(op, input.aggregate.field) : null;
    const by = input.aggregate.by ? columnOf(op, input.aggregate.by) : null;
    if ((input.aggregate.field && !column) || (input.aggregate.by && !by)) {
      throw refusal({ message: 'That total is over a computed field, which the database cannot add up itself.', code: 'refusal.aggregate_unsupported' });
    }
    sqlAggregate = { kind: input.aggregate.kind, column, by };
    aggregateDecl =
      input.aggregate.kind === 'group_by'
        ? { value: '{{ $number(value) }}', records: '{{ response }}', key: '{{ key }}' }
        : { value: '{{ $number(response[0].value) }}' };
  } else if (input.aggregate) {
    aggregateDecl = await renderAggregate({
      target: draft,
      pushdown: op.pushdown,
      kind: input.aggregate.kind,
      field: input.aggregate.field,
      by: input.aggregate.by,
      rendered,
      params,
    });
    if (!aggregateDecl) {
      throw refusal({ message: `This source cannot total ${input.aggregate.kind} itself.`, code: 'refusal.aggregate_unsupported' });
    }
  }

  /* The origin the read started on. A `next.url` elsewhere is refused. */
  const origin = (draft.absolute ?? (base ? joinPath(base, draft.path) : null))?.origin ?? null;

  const records: unknown[] = [];
  const seen = new Set<string>();
  let pages = 0;
  let requests = 0;
  let emptyRun = 0;
  let lastResponse: unknown = null;
  let lastHeaders: Headers = {};
  const maxPages = op.page ? op.page.maxPages : 1;
  const rules = [...op.errors, ...input.fallbackErrors];

  while (pages < maxPages) {
    ctx.budget.checkOperation(startedAt);
    const request = { ...toEvaluated(draft, base, connection, isSql ? rendered : null), aggregate: sqlAggregate };
    const cursor = { page: pages, received: records.length };

    /* ── get a response ── */
    let response: Response;
    let wire: WireRequest | null = null;
    if (hasSource) {
      response = await sourceResponse(ctx, op, { ...input.scope, params, state, cursor });
    } else {
      const fingerprint = createHash('sha256')
        .update(`${request.method} ${request.url?.toString() ?? ''} ${JSON.stringify(request.query)} ${JSON.stringify(request.body ?? null)}`)
        .digest('hex');
      if (seen.has(fingerprint)) {
        throw refusal({
          message: 'The source sent Silo back to a page it had already read. The connector’s paging needs fixing.',
          code: 'refusal.page_loop',
          detail: { page: pages },
        });
      }
      seen.add(fingerprint);
      ({ response, wire } = await send(ctx, transport, request, op, tls, 'read'));
      requests += 1;
    }

    /* ── parse ── */
    let parsed: unknown = null;
    let parseError: unknown = null;
    let raw: string | null = null;
    if (response.parsed !== undefined) {
      parsed = response.parsed;
    } else {
      try {
        parsed = await parseBody({
          bytes: response.body,
          format: transport.answersWire && !hasSource ? 'wire' : op.format,
          charset: op.charset,
          contentType: response.contentType,
          options: op.formatOptions,
        });
        parsed = handlesFor(parsed, ctx.blobs, response.contentType);
      } catch (error) {
        parseError = error;
        raw = safeDecode(response.body, op.charset, response.contentType).slice(0, 4_096);
      }
    }
    lastResponse = parsed;
    lastHeaders = response.headers;
    const links = linksOf(response.headers);

    /* ── errors: the connector's rules, then the protocol's floor ── */
    const errorScope: Scope = {
      status: response.status,
      code: response.code,
      message: response.message,
      headers: response.headers,
      response: parsed,
      raw,
      params,
      state,
      cursor,
    };
    const judged =
      (await judge(rules, errorScope, ctx.budget.clock.now())) ??
      (() => {
        const floor = wire ? transport.floor(response, wire) : null;
        return floor ? { means: floor.means, rule: null, retryAfterSeconds: floor.retryAfterSeconds ?? null } : null;
      })();
    if (judged) {
      if (judged.means === 'empty') break;
      raise(judged, {
        protocol,
        status: response.status,
        code: response.code,
        excerpt: raw ?? safeDecode(response.body, op.charset, response.contentType).slice(0, 300),
        sourceMessage: response.message,
      });
    }
    if (parseError) throw parseError;

    /* ── an aggregate is one answer, not a list ── */
    if (aggregateDecl) {
      const scope: Scope = { ...input.scope, response: parsed, headers: response.headers, params };
      if (aggregateDecl.records) {
        const groups = await value(aggregateDecl.records, scope);
        const list = Array.isArray(groups) ? groups : groups === undefined || groups === null ? [] : [groups];
        const out: unknown[] = [];
        for (const group of list) {
          const one: Scope = { ...scope, record: group };
          out.push({ key: await value(aggregateDecl.key!, one), value: await value(aggregateDecl.value, one) });
        }
        return { records: [], pages: 1, requests, lastResponse, lastHeaders, rendered, aggregate: out };
      }
      return { records: [], pages: 1, requests, lastResponse, lastHeaders, rendered, aggregate: await value(aggregateDecl.value, scope) };
    }

    /* ── records ── */
    const pageScope: Scope = {
      ...input.scope,
      response: parsed,
      headers: response.headers,
      links,
      cursor,
      state,
      params,
      request: viewOf(draft, base),
      fragments: rendered.fragments,
    };
    /* A source that pushes had `records` applied at intake; what is stored is already the record. */
    const inbound = ctx.manifest.transport.kind === 'inbound_webhook' || ctx.manifest.transport.kind === 'email_fallback' || ctx.manifest.transport.kind === 'queue_tap';
    const found = inbound ? parsed : await value(op.records, pageScope);
    const recs = recordsOf(found, op.records, pages === 0 && parsed !== null);
    if (input.project) ctx.observe?.(recs);

    if (recs.length === 0) emptyRun += 1;
    else emptyRun = 0;

    const rows = input.project
      ? await project(recs, input.project, { ...pageScope, cursor }, records.length)
      : recs;
    records.push(...rows);
    ctx.budget.addRows(rows.length);
    pages += 1;

    if (records.length >= input.want) break;
    if (records.length > op.maxRecords) throw ceiling(op.maxRecords, ctx.object.name);
    if (!op.page) break;
    if (recs.length === 0 && op.page.emptyPageEnds) break;

    /* ── next ── */
    const nextScope: Scope = { ...pageScope, cursor: { page: pages, received: records.length } };
    const nextState = await every(op.page.next.state, nextScope);
    if (await truth(op.page.until, nextScope)) break;
    if (emptyRun >= EMPTY_PAGES_TOLERATED) {
      throw upstream({
        message: `The source returned ${EMPTY_PAGES_TOLERATED} empty pages in a row while saying there were more. The connector’s paging needs checking.`,
        code: 'upstream.empty_page_mid_read',
        detail: { page: pages },
      });
    }
    if (hasSource) {
      throw refusal({ message: 'A read of a value it was given cannot page.', code: 'refusal.request_unbuildable' });
    }
    await nextDraft(draft, op, nextScope, base, origin);
    state = { ...state, ...nextState };

    if (pages >= maxPages) {
      throw bounds({
        message: `The source had more than ${maxPages} pages of ${ctx.object.name}. Narrow the question, or filter at the source.`,
        code: 'bounds.read_ceiling',
        detail: { pages: maxPages, records: records.length },
      });
    }
  }

  return {
    records: records.slice(0, input.want),
    pages,
    requests,
    lastResponse,
    lastHeaders,
    rendered,
    aggregate: null,
  };
}

/* ── Building ───────────────────────────────────────────────────────────── */

/** A request from the document, every expression worked out over `scope`. Shared by reads and writes. */
export async function buildDraft(ctx: ReadContext, r: RequestV2, scope: Scope): Promise<Draft> {
  const constant = 'headers' in ctx.manifest.transport ? ctx.manifest.transport.headers : {};
  const headers = await every({ ...constant, ...ctx.manifest.defaults.headers, ...r.headers }, scope);
  const url = r.url !== undefined ? await text(r.url, scope) : null;
  let absolute: URL | null = null;
  if (url) {
    try {
      absolute = new URL(url);
    } catch {
      throw refusal({ message: `This connector's address came to "${url.slice(0, 200)}", which is not an address.`, code: 'refusal.request_unbuildable' });
    }
  }
  const protocol: Record<string, unknown> = {};
  for (const name of ['table', 'schema', 'mailbox', 'service', 'rpc', 'topic', 'fromTime'] as const) {
    if (r[name] !== undefined) protocol[name] = await text(r[name], scope);
  }
  if (r.columns !== undefined) protocol.columns = r.columns;
  if (r.statement !== undefined) protocol.statement = r.statement;
  if (r.pick !== undefined) protocol.pick = r.pick;
  if (r.parts !== undefined) protocol.parts = r.parts;
  if (r.path !== undefined && ctx.manifest.transport.kind !== 'https_rest') protocol.path = await text(r.path, scope);
  return {
    protocol,
    method: r.method,
    absolute,
    auth: r.auth,
    path: r.path !== undefined ? await pathOf(r.path, scope) : null,
    query: await every(r.query, scope),
    headers,
    body: r.body !== undefined ? await deep(r.body, scope) : undefined,
    contentType: r.contentType,
    search: r.search !== undefined ? await deep(r.search, scope) : undefined,
    where: [],
    soapHeaders: r.soapHeaders !== undefined ? await deep(r.soapHeaders, scope) : undefined,
    action: r.action !== undefined ? await text(r.action, scope) : null,
  };
}

async function nextDraft(draft: Draft, op: OperationV2, scope: Scope, base: URL | null, origin: string | null): Promise<void> {
  const next = op.page!.next;
  if (next.url !== undefined) {
    const worked = await text(next.url, scope);
    if (!worked) {
      throw upstream({ message: 'The connector’s next page address came to nothing, but its until condition says there are more pages.', code: 'upstream.malformed_response' });
    }
    const current = draft.absolute ?? (base ? joinPath(base, draft.path) : null);
    const url = new URL(worked, current ?? undefined);
    if (url.origin !== origin) {
      throw refusal({
        message: `The source pointed the next page at ${url.origin}, which is not the system this connection reads.`,
        code: 'refusal.page_url_foreign',
        detail: { origin: url.origin },
      });
    }
    draft.absolute = url;
    draft.path = null;
    draft.query = {};
  }
  if (next.path !== undefined) {
    const worked = await pathOf(next.path, scope);
    if (draft.absolute) draft.absolute = joinPath(new URL(draft.absolute.origin), worked);
    else draft.path = worked;
  }
  if (Object.keys(next.query).length > 0) draft.query = mergeMap(draft.query, await every(next.query, scope, { keepNull: true }));
  if (Object.keys(next.headers).length > 0) draft.headers = mergeMap(draft.headers, await every(next.headers, scope, { keepNull: true }));
  if (next.body !== undefined) draft.body = mergeDeep(draft.body, await deep(next.body, scope));
}

export function toEvaluated(draft: Draft, base: URL | null, connection: Record<string, unknown>, sql: Rendered | null): EvaluatedRequest {
  const query: Record<string, QueryValue> = {};
  for (const [name, one] of Object.entries(draft.query)) {
    if (one === null || one === undefined) continue;
    query[name] = Array.isArray(one) ? one.filter((v) => v !== null && v !== undefined).map(scalar) : scalar(one);
  }
  const headers: Record<string, string> = {};
  for (const [name, one] of Object.entries(draft.headers)) {
    if (one === null || one === undefined) continue;
    headers[name] = scalar(one);
  }
  const p = draft.protocol;
  return {
    method: draft.method,
    url: draft.absolute ?? (base ? joinPath(base, draft.path) : null),
    headers,
    query,
    body: draft.body,
    contentType: draft.contentType,
    auth: draft.auth,
    connection,
    where: draft.where,
    order: sql?.order ?? [],
    limit: sql?.limit ?? null,
    fields: sql && sql.fields.length > 0 ? sql.fields : null,
    search: draft.search,
    soapHeaders: draft.soapHeaders,
    ...(draft.action !== null ? { action: draft.action } : {}),
    ...(p.table !== undefined ? { table: String(p.table) } : {}),
    ...(p.schema !== undefined && p.schema !== null ? { schema: String(p.schema) } : {}),
    ...(p.columns !== undefined ? { columns: p.columns as string[] } : {}),
    ...(p.statement !== undefined ? { statement: String(p.statement) } : {}),
    ...(p.path !== undefined && p.path !== null ? { path: String(p.path) } : {}),
    ...(p.pick !== undefined ? { pick: p.pick as EvaluatedRequest['pick'] } : {}),
    ...(p.mailbox !== undefined ? { mailbox: String(p.mailbox) } : {}),
    ...(p.parts !== undefined ? { parts: p.parts as string[] } : {}),
    ...(p.service !== undefined ? { service: String(p.service) } : {}),
    ...(p.rpc !== undefined ? { rpc: String(p.rpc) } : {}),
    ...(p.topic !== undefined ? { topic: String(p.topic) } : {}),
    ...(p.fromTime !== undefined && p.fromTime !== null ? { fromTime: String(p.fromTime) } : {}),
  };
}

const scalar = (one: unknown): string => (typeof one === 'object' && one !== null ? JSON.stringify(one) : String(one));

/** What `request` means in a scope: the last request, evaluated, before auth touched it. */
function viewOf(draft: Draft, base: URL | null): Record<string, unknown> {
  const url = draft.absolute ?? (base ? safeJoin(base, draft.path) : null);
  return {
    method: draft.method,
    url: url?.toString() ?? null,
    path: url?.pathname ?? draft.path,
    query: draft.query,
    headers: draft.headers,
    body: draft.body ?? null,
  };
}

const safeJoin = (base: URL, path: string | null): URL | null => {
  try {
    return joinPath(base, path);
  } catch {
    return null;
  }
};

/* ── Sending ────────────────────────────────────────────────────────────── */

export type Response = WireResponse & { parsed?: unknown };

/**
 * Prepare, authenticate and send one request. A write is never retried, runs
 * outside any read-only transaction, and applies the auth that only writes need.
 */
export async function send(
  ctx: ReadContext,
  transport: ReturnType<typeof transportFor>,
  request: EvaluatedRequest,
  op: OperationV2 | WriteOperationV2,
  tls: SocketAuth['tls'],
  mode: 'read' | 'write',
  beforeSend?: (surface: ReturnType<ReturnType<typeof transportFor>['authSurface']>) => void,
): Promise<{ response: Response; wire: WireRequest }> {
  const target = request.url;

  /*
   * A CREDENTIAL GOES ONLY TO A PINNED ORIGIN. A `url` anywhere else — the
   * presigned download at the end of an export — is sent with no auth at all,
   * no cookie, and never through the agent (MANIFEST-V2 §9.2).
   */
  const pinned = target ? ctx.auth.mayReceiveCredential(target) : true;
  const authenticated = request.auth === 'connection' && pinned && ctx.strategy !== null;
  const route = authenticated || !target || pinned ? ctx.route : ({ via: 'silo' } as const);

  if (transport.local) {
    const wire = transport.prepare({ transport: ctx.manifest.transport, request, operation: op, params: ctx.params });
    if (!ctx.local) throw refusal({ message: 'This source is held by Silo and cannot be read from here.', code: 'refusal.local_unreadable' });
    const rows = await ctx.local(wire);
    const body = Buffer.from(JSON.stringify(rows));
    ctx.budget.addBytes(body.length);
    return { response: { status: null, code: null, message: null, headers: {}, body, contentType: 'application/json', durationMs: 0 }, wire };
  }

  let retried = false;
  for (;;) {
    const socket: SocketAuth = { tls: { ...tls } };
    const wire = transport.prepare({ transport: ctx.manifest.transport, request, operation: op, params: ctx.params });
    const surface = transport.authSurface(wire, socket);
    if (authenticated) {
      await applyAuth({
        strategy: ctx.strategy!,
        credential: ctx.credential,
        params: ctx.params,
        kind: ctx.manifest.transport.kind,
        req: wire,
        surface,
        canonicalView: transport.canonicalView?.bind(transport),
        isWrite: mode === 'write',
        route: ctx.route,
        cacheKey: ctx.cacheKey,
        origin: target ? new URL(target.origin) : null,
        base: ctx.manifest.transport.kind === 'https_rest' ? await baseAddress(ctx.manifest.transport, ctx.params) : null,
        deps: ctx.auth,
      });
    }

    beforeSend?.(surface);
    ctx.budget.request();
    const response = await ctx.dispatch(
      transport,
      wire,
      {
        socket,
        timeoutMs: CONNECTOR_TIMEOUT_MS,
        maxBytes: ctx.budget.limits.maxBytes - ctx.budget.bytes,
        retry: mode === 'read',
        mode,
        connectionId: ctx.connectionId,
      },
      route,
    );
    ctx.budget.addBytes(response.body.length);

    /*
     * A TOKEN SILO OBTAINED ITSELF IS REFRESHED ONCE ON A 401. A session that
     * expired early, a JWT exchanged against a clock that drifted: one retry
     * with a fresh one, then the refusal.
     */
    if (authenticated && !retried && (response.status === 401 || response.status === 403) && derivesTokens(ctx)) {
      retried = true;
      await ctx.auth.invalidate(ctx.cacheKey);
      continue;
    }
    return { response, wire };
  }
}

function derivesTokens(ctx: ReadContext): boolean {
  const strategy = ctx.strategy;
  if (!strategy) return false;
  const parts = strategy.strategy === 'all_of' ? strategy.parts : [strategy];
  return parts.some((p) => ['session', 'jwt_assertion', 'oauth2_client_credentials', 'oauth2_password'].includes(p.strategy));
}

/** `request.source`: a value to parse instead of a request — usually a file an earlier step fetched. */
async function sourceResponse(ctx: ReadContext, op: OperationV2, scope: Scope): Promise<Response> {
  const given = await value(op.request.source, scope);
  const blob = ctx.blobs.get(given);
  const empty = { status: null, code: null, message: null, headers: {}, durationMs: 0 };
  if (blob) return { ...empty, body: blob.bytes, contentType: blob.contentType };
  if (typeof given === 'string') return { ...empty, body: Buffer.from(given, 'utf8'), contentType: null };
  if (Buffer.isBuffer(given)) return { ...empty, body: given, contentType: null };
  return { ...empty, body: Buffer.alloc(0), contentType: null, parsed: given ?? null };
}

/* ── Reading ────────────────────────────────────────────────────────────── */

const SIMPLE_PATH = /^\{\{\s*[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*\s*\}\}$/;

/**
 * What the `records` expression produced, as a list.
 *
 * An array is the records; one object is one record; `null` is none. NOTHING
 * AT ALL on the first page, from a plain path, means the path is wrong — the
 * envelope moved — and is refused by name, because reading it as "no records"
 * would answer every question with zero.
 */
function recordsOf(found: unknown, expression: string, firstPageWithBody: boolean): unknown[] {
  if (Array.isArray(found)) return found;
  if (found === null) return [];
  if (found === undefined) {
    if (firstPageWithBody && SIMPLE_PATH.test(expression)) {
      throw upstream({
        message: `The response has nothing at ${expression.replace(/^\{\{\s*|\s*\}\}$/g, '')}, where this connector expects its records. The source may have changed shape.`,
        code: 'upstream.records_not_found',
        detail: { records: expression },
      });
    }
    return [];
  }
  return [found];
}

const FIELD_PATH = /^\{\{\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*\}\}$/;
const SCOPE_NAMES = new Set(['response', 'headers', 'links', 'params', 'steps', 'item', 'previous', 'cursor', 'state', 'request', 'record', 'index', 'row', 'fragments']);

/** A plain path through plain objects, read without the evaluator — the same answer, faster. */
function fastPath(record: unknown, expression: string): { hit: true; value: unknown } | { hit: false } {
  const match = FIELD_PATH.exec(expression);
  if (!match || SCOPE_NAMES.has(match[1]!.split('.')[0]!)) return { hit: false };
  let here: unknown = record;
  for (const step of match[1]!.split('.')) {
    if (here === null || here === undefined) return { hit: true, value: null };
    if (typeof here !== 'object' || Array.isArray(here)) return { hit: false };
    here = (here as Record<string, unknown>)[step];
  }
  if (Array.isArray(here) || (here !== null && typeof here === 'object' && !Buffer.isBuffer(here))) return { hit: false };
  return { hit: true, value: here === undefined ? null : here };
}

/**
 * Records onto the object's fields.
 *
 * STRICT BY DEFAULT (finding F31): the row holds the declared fields and
 * nothing else, so a field policy hiding `amount` cannot leave `amount_pence`
 * beside it. A declared field with no expression reads the source key of the
 * same name.
 */
async function project(
  recs: unknown[],
  shape: NonNullable<OperationInput['project']>,
  scope: Scope,
  before: number,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  const declared = shape.object.fields.map((f) => f.name);
  const plain = (r: unknown): r is Record<string, unknown> => r !== null && typeof r === 'object' && !Array.isArray(r);

  for (const [index, record] of recs.entries()) {
    const row: Record<string, unknown> = !shape.strict && plain(record) ? { ...record } : {};
    const names = shape.strict ? declared : [...new Set([...declared, ...Object.keys(shape.fields)])];
    for (const name of names) {
      const expression = shape.fields[name];
      if (expression === undefined) {
        /* A field the object declares but does not map: its field list's value expression reads it, where there is one. */
        const declared = shape.object.fieldList ? shape.object.fields.find((one) => one.name === name) : undefined;
        row[name] = declared
          ? await listedValue(shape.object.fieldList!.value, declared, { ...scope, record, index, row: before + index + 1 })
          : plain(record) && record[name] !== undefined
            ? record[name]
            : null;
        continue;
      }
      const quick = fastPath(record, expression);
      if (quick.hit) {
        row[name] = quick.value;
        continue;
      }
      const worked = await value(expression, { ...scope, record, index, row: before + index + 1 });
      row[name] = worked === undefined ? null : worked;
    }
    out.push(row);
  }
  return out;
}

/** `Link: <…>; rel="next"` as `{ next: '…' }` (RFC 8288). */
export function linksOf(headers: Headers): Record<string, string> {
  const raw = headers.link;
  const all = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const out: Record<string, string> = {};
  for (const header of all) {
    for (const part of header.split(/,(?=\s*<)/)) {
      const match = /<([^>]*)>\s*;(.*)$/.exec(part.trim());
      if (!match) continue;
      const rel = /rel\s*=\s*"?([^";]+)"?/i.exec(match[2]!);
      if (!rel) continue;
      for (const name of rel[1]!.trim().split(/\s+/)) out[name.toLowerCase()] = match[1]!;
    }
  }
  return out;
}

export function safeDecode(bytes: Buffer, charset: string, contentType: string | null): string {
  try {
    return decode(bytes, charset, contentType);
  } catch {
    return bytes.toString('latin1');
  }
}

const ceiling = (limit: number, object: string) =>
  bounds({
    message: `There are more than ${limit} ${object} records to read for this question. Filter at the source, or ask for a total rather than a list.`,
    code: 'bounds.read_ceiling',
    detail: { limit },
  });

