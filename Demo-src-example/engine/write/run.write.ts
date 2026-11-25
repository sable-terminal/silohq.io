import { createHash } from 'node:crypto';
import type { OperationV2, WriteOperationV2 } from '../../schemas/manifest.schema';
import { isPipeline, isVariants, PROTOCOL_OF } from '../../schemas/manifest.schema';
import { invalid, notFound, refusal, upstream } from '../../utils/error.util';
import { every, value, type Scope } from '../expression/evaluate.expression';
import { parseBody } from '../formats/index.format';
import { place } from '../auth/place.auth';
import { baseAddress, connectionSettings, resolveTls, type ReadContext } from '../read/context.read';
import { judge, raise } from '../read/errors.read';
import { buildDraft, safeDecode, send, toEvaluated } from '../read/operation.read';
import { prepareWrite, type SqlWire } from '../transports/database.transport';
import { transportFor } from '../transports/index.transport';
import { applyAuth } from '../auth/apply.auth';

/**
 * Changing a record in a connected system, as the document says to.
 *
 * ── A WRITE IS AN EXPRESSION TOO ──────────────────────────────────────────
 *
 * The request is built from `values`, `identifier` and `prior` exactly as a
 * read's is built from `params` and `state` — method, path, body, headers — so
 * a system with an odd write shape is a document, not code. The inverse of a
 * read's `fields` is written out explicitly in the body, because nobody can
 * invert an expression and guessing would corrupt records quietly.
 *
 * ── NEVER RETRIED, NEVER GUESSED ──────────────────────────────────────────
 *
 * A create run twice is two records. Writes are not retried by the transport;
 * an idempotency key is placed where the document says, derived from what is
 * being written, so a caller that retries a whole change cannot double it.
 * An update or delete that the source says touched nothing is a refusal, not
 * a success — that is how an undo silently fails to undo.
 *
 * WHAT IT DOES NOT DECIDE IS WHETHER THE WRITE IS ALLOWED. Grants, approval
 * and `writes_enabled` are the service's; this refuses only what the CONNECTOR
 * cannot do.
 */

export type WriteKind = 'create' | 'update_full' | 'update_partial' | 'delete' | 'upsert';

export interface WriteAsk {
  object: string;
  /** A CRUD role, or the name of a custom action the connector declares. */
  kind: WriteKind | string;
  identifier?: Record<string, unknown>;
  values?: Record<string, unknown>;
  /** The record before the change, for a source that wants it (an ETag, a version). */
  prior?: Record<string, unknown> | null;
  /** Stable across a caller's retries of the same change. Derived when absent. */
  idempotencyKey?: string;
}

/** The names the mutation machinery has always used for these. */
export type MutationKind = WriteKind;
export type Mutation = WriteAsk & { kind: MutationKind | string };
export type MutationResult = WriteResult;

export interface WriteResult {
  record: Record<string, unknown> | null;
  identifier: Record<string, unknown>;
  durationMs: number;
}

/** Which declared operation a request for `kind` runs. */
export function operationFor(names: string[], kind: string): string | null {
  const has = (n: string) => names.includes(n);
  switch (kind) {
    case 'update_full':
      return has('update_full') ? 'update_full' : has('update') ? 'update' : null;
    case 'update_partial':
      return has('update_partial') ? 'update_partial' : has('update') ? 'update' : null;
    default:
      return has(kind) ? kind : null;
  }
}

export async function runWrite(ctx: ReadContext, ask: WriteAsk): Promise<WriteResult> {
  const started = ctx.budget.clock.now();
  const object = ctx.object;
  if (!object.available) {
    throw refusal({ message: `${object.name} has not been mapped, so it cannot be changed.`, code: 'refusal.object_unmapped' });
  }
  const operations = object.write?.operations ?? {};
  const name = operationFor(Object.keys(operations), ask.kind);
  if (!name) {
    throw refusal({ message: `This connector cannot ${ask.kind.replace('_', ' ')} ${object.name} records.`, code: 'refusal.mutation_unsupported' });
  }
  const op = operations[name]!;

  const crud = ['create', 'update_full', 'update_partial', 'delete', 'upsert'].includes(ask.kind);
  if (crud && ask.kind !== 'create' && ask.kind !== 'upsert' && !object.identifier.every((f) => ask.identifier?.[f] !== undefined)) {
    throw invalid({
      message: `${object.name} is identified by ${object.identifier.join(' and ')}, and all of them are needed to change a record.`,
      code: 'invalid.incomplete_identifier',
    });
  }
  if (ask.kind !== 'delete' && crud && !ask.values) throw invalid({ message: 'Nothing to write.', code: 'invalid.no_values' });

  const transport = transportFor(ctx.manifest.transport.kind);
  if (!transport.writes) {
    throw refusal({
      message: `Silo does not write to a ${ctx.manifest.transport.kind} source. This is a gap in the product rather than a problem with your system.`,
      code: 'refusal.mutation_transport_unsupported',
    });
  }

  const params = { ...ctx.params };
  const scope: Scope = { values: ask.values ?? {}, identifier: ask.identifier ?? {}, prior: ask.prior ?? null, params };
  const tls = await resolveTls(ctx.manifest.transport, params);
  const connection = await connectionSettings(ctx.manifest.transport, params);
  const idempotencyKey =
    ask.idempotencyKey ??
    createHash('sha256').update(JSON.stringify([ctx.connectionId, object.name, name, ask.identifier ?? null, ask.values ?? null])).digest('hex');

  const { response, sqlResult } =
    ctx.manifest.transport.kind === 'sql' && !op.request
      ? await sqlWrite(ctx, name, ask, connection, tls)
      : { ...(await httpShapedWrite(ctx, transport, op, scope, connection, tls, idempotencyKey)), sqlResult: null };

  /* ── what it means ── */
  let parsed: unknown = null;
  let raw: string | null = null;
  try {
    parsed = await parseBody({ bytes: response.body, format: op.format, charset: op.charset, contentType: response.contentType, options: op.formatOptions });
  } catch {
    raw = safeDecode(response.body, op.charset, response.contentType).slice(0, 4_096);
  }
  const rules = [...op.errors, ...ctx.manifest.defaults.errors, ...ctx.manifest.errors];
  const errorScope: Scope = { status: response.status, code: response.code, message: response.message, headers: response.headers, response: parsed, raw, params };
  const judged =
    (await judge(rules, errorScope, ctx.budget.clock.now())) ??
    (() => {
      const floor = transport.floor(response, response.wire);
      return floor ? { means: floor.means, rule: null, retryAfterSeconds: floor.retryAfterSeconds ?? null } : null;
    })();
  if (judged) {
    raise(judged, {
      protocol: PROTOCOL_OF[ctx.manifest.transport.kind],
      status: response.status,
      code: response.code,
      excerpt: raw ?? safeDecode(response.body, op.charset, response.contentType).slice(0, 300),
      sourceMessage: response.message,
    });
  }
  if (raw !== null && response.body.length > 0) {
    throw upstream({ message: 'The source answered the write with something Silo could not read.', code: 'upstream.malformed_response' });
  }

  /* ── what was stored ── */
  let record: Record<string, unknown> | null;
  if (sqlResult) {
    if ((name === 'update' || name === 'delete' || ask.kind === 'update_full' || ask.kind === 'update_partial' || ask.kind === 'delete') && sqlResult.affected === 0) {
      throw notFound({ message: 'The source has no record matching that identifier, so nothing was changed.', code: 'missing.record' });
    }
    record = sqlResult.rows[0] ?? null;
  } else {
    const resultScope: Scope = { ...scope, response: parsed, headers: response.headers };
    const found = await value(op.result, resultScope);
    record = found !== null && typeof found === 'object' && !Array.isArray(found) ? (found as Record<string, unknown>) : null;
  }

  const declared = Object.keys(op.identifier).length > 0 ? await every(op.identifier, { ...scope, response: parsed, result: record }) : null;
  const identifier =
    declared ??
    (ask.identifier && Object.keys(ask.identifier).length > 0
      ? ask.identifier
      : Object.fromEntries(object.identifier.map((f) => [f, record?.[f] ?? ask.values?.[f] ?? null])));

  return { record, identifier, durationMs: ctx.budget.clock.now() - started };
}

/* ── HTTP-shaped: the document's request ────────────────────────────────── */

async function httpShapedWrite(
  ctx: ReadContext,
  transport: ReturnType<typeof transportFor>,
  op: WriteOperationV2,
  scope: Scope,
  connection: Record<string, unknown>,
  tls: Awaited<ReturnType<typeof resolveTls>>,
  idempotencyKey: string,
) {
  if (!op.request) throw refusal({ message: 'This write has no request.', code: 'refusal.request_unbuildable' });
  const base = await baseAddress(ctx.manifest.transport, ctx.params);
  const draft = await buildDraft(ctx, op.request, scope);
  const request = toEvaluated(draft, base, connection, null);
  const { response, wire } = await send(ctx, transport, request, op, tls, 'write', (surface) => {
    if (op.idempotency) place(surface, op.idempotency.place, idempotencyKey);
  });
  return { response: { ...response, wire } };
}

/* ── SQL: derived from the table the read names ─────────────────────────── */

async function sqlWrite(
  ctx: ReadContext,
  name: string,
  ask: WriteAsk,
  connection: Record<string, unknown>,
  tls: Awaited<ReturnType<typeof resolveTls>>,
) {
  const read = ctx.object.read;
  const first = (isVariants(read) ? read[read.length - 1]! : read) as OperationV2;
  if (isPipeline(first as never) || !first.request.table) {
    throw refusal({ message: `${ctx.object.name} is not read from a table, so Silo does not know where to write it.`, code: 'refusal.request_unbuildable' });
  }
  const kind = name === 'create' ? 'create' : name === 'delete' ? 'delete' : name === 'upsert' ? 'upsert' : 'update';
  const t = ctx.manifest.transport as Extract<typeof ctx.manifest.transport, { kind: 'sql' }>;
  const wire: SqlWire = prepareWrite(t, connection, {
    table: first.request.table,
    schema: typeof connection.schema === 'string' ? connection.schema : null,
    identifier: ctx.object.identifier,
    kind,
    values: ask.values ?? {},
    key: ask.identifier ?? {},
  });
  const transport = transportFor('sql');
  const socket = { tls: { ...tls } };
  const surface = transport.authSurface(wire, socket);
  if (ctx.strategy) {
    await applyAuth({
      strategy: ctx.strategy,
      credential: ctx.credential,
      params: ctx.params,
      kind: 'sql',
      req: wire,
      surface,
      isWrite: true,
      route: ctx.route,
      cacheKey: ctx.cacheKey,
      origin: null,
      deps: ctx.auth,
    });
  }
  ctx.budget.request();
  const response = await ctx.dispatch(transport, wire, { socket, timeoutMs: 30_000, maxBytes: ctx.budget.limits.maxBytes, retry: false, mode: 'write', connectionId: ctx.connectionId }, ctx.route);
  const body = response.code === null && response.body.length > 0 ? (JSON.parse(response.body.toString('utf8')) as { rows: Array<Record<string, unknown>>; affected: number | null }) : null;
  return { response: { ...response, body: Buffer.alloc(0), wire }, sqlResult: body ?? { rows: [], affected: null } };
}
