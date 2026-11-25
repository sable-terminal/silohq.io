import { createHash } from 'node:crypto';
import jsonata from 'jsonata';
import { refusal } from '../../utils/error.util';

/**
 * The expression evaluator every connector's behaviour runs through.
 *
 * ── WHY THERE IS AN EVALUATOR AT ALL ──────────────────────────────────────
 *
 * CONNECTORS.md §1: a connector is a protocol plus expressions. The version
 * before this one enumerated behaviours — seven pagination strategies, four
 * filter encodings, six response shapes — and an enumerated vocabulary means a
 * code change every time a real system does something the list has not seen.
 * Two applications were tried and both needed one. This is what replaces that:
 * how a page is requested, where the records are, where a value sits inside a
 * record, and what a failure means are all written down and evaluated, never
 * selected from a list.
 *
 * ── WHY JSONATA AND NOT A LANGUAGE OF OUR OWN ─────────────────────────────
 *
 * A small expression language invented here would hit its own treadmill: the
 * first API that needs a substring, a sum or a conditional becomes another
 * release. JSONata is specified, implemented, and has the whole of that surface
 * already. It has no I/O, no network and no filesystem, so there is nothing
 * outside the document for it to reach.
 *
 * IT IS NOT LOOP-FREE, and the first version of this file said it was. Lambdas
 * recurse, and a timer raced beside the evaluation never fires, because JSONata
 * evaluates in microtasks and starves the timer queue. So time is bounded from
 * INSIDE: jsonata looks up an entry hook on every node it evaluates, and the
 * hook throws once the deadline passes. Verified against the installed version
 * to stop a hundred-thousand-deep recursion in about fifty milliseconds.
 *
 * ── THREE GUARDS, AND NONE IS OPTIONAL ────────────────────────────────────
 *
 * THE CREDENTIAL IS NEVER IN SCOPE. `Scope` has no member that could hold one,
 * `bind` copies only the names below, and the names a hostile document would
 * try — `credential`, `secret`, `token`, `password`, `env` — resolve to nothing.
 * Authentication is applied by the transport after every expression has run.
 *
 * TIME AND SIZE ARE BOUNDED, from inside the evaluation for time and on the
 * output for size.
 *
 * NOTHING RUNS THAT THE SCHEMA DID NOT PARSE. `$eval` would let a SOURCE supply
 * code at read time — a response containing `"$sum(…)"` evaluated as if the
 * connector's author had written it — so it is refused with the clock and
 * randomness, which would let two reads of the same source disagree.
 */

/* ── What an expression can see ─────────────────────────────────────────── */

/**
 * Every name an expression can read, and nothing else.
 *
 * ONE TYPE FOR EVERY PHASE OF A READ OR A WRITE, with each name set only where
 * MANIFEST-V2 §2.1 and §9 say it is. Unset names bind as `null`, so a document
 * that reads `steps` outside a pipeline gets nothing rather than an error, and
 * the same expression text means the same thing wherever it is evaluated.
 */
export interface Scope {
  /** The record, when the expression is a field. `$` is the record then. */
  record?: unknown;
  /** The parsed body of the response being read. */
  response?: unknown;
  /** Response headers, names lowercased; `set-cookie`, `link` and `www-authenticate` as arrays. */
  headers?: Record<string, string | string[]>;
  /** `Link` relations, parsed, so paging says `links.next` rather than parsing. */
  links?: Record<string, string>;

  /* Error rules. */
  status?: number | null;
  code?: string | null;
  message?: string | null;
  /** The first 4,096 characters of a body that could not be parsed. */
  raw?: string | null;

  /* Paging. */
  /** Responses so far and records so far. */
  cursor?: { page: number; received: number };
  /** The paging bag, carried from one request to the next. */
  state?: Record<string, unknown>;
  /** The last request sent — method, path, query, body — before auth touched it. */
  request?: unknown;

  /** Connection parameters and declared defaults. Never a secret. */
  params?: Record<string, string>;
  /**
   * The object's declared fields — `{ name, key, type, description }` each. What a
   * request uses to name the fields it wants, however the system takes them: a
   * query parameter, a SOQL statement, a GraphQL document, a body array. After
   * Silo has read the system's own field list, that is every field it holds.
   */
  listed?: Array<{ name: string; key: string; type: string; description?: string }>;

  /* Pipelines. */
  steps?: Record<string, unknown>;
  item?: unknown;
  previous?: unknown;

  /* Fields. */
  /** 0-based position of the record within its page. */
  index?: number;
  /** 1-based position of the record across the whole read. */
  row?: number;

  /* Pushdown. */
  field?: string;
  op?: string;
  value?: unknown;
  fragments?: unknown[];
  order?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  limit?: number | null;
  fields?: string[];
  by?: string;
  /** For a read variant's `when`: every filter the question asks for. */
  filters?: Array<{ field: string; op: string; value: unknown }>;

  /* Writes. */
  values?: Record<string, unknown>;
  identifier?: Record<string, unknown>;
  prior?: unknown;
  result?: unknown;
  records?: unknown[];
}

/** The names `bind` copies. A key not listed here cannot reach an expression. */
const NAMES = [
  'response', 'headers', 'links', 'status', 'code', 'message', 'raw',
  'cursor', 'state', 'request', 'params', 'listed', 'steps', 'item', 'previous',
  'index', 'row', 'field', 'op', 'value', 'fragments', 'order', 'limit',
  'fields', 'by', 'filters', 'values', 'identifier', 'prior', 'result', 'records',
] as const satisfies ReadonlyArray<Exclude<keyof Scope, 'record'>>;

/**
 * NAMES A HOSTILE DOCUMENT WOULD TRY, pinned to nothing on purpose. They are
 * already absent from `NAMES`; binding them to `null` explicitly means a test
 * can assert the exact result, and a later edit that adds one to `NAMES` breaks
 * that test rather than quietly exposing whatever it pointed at.
 */
export const NEVER_BOUND = [
  'credential', 'credentials', 'secret', 'secrets', 'token', 'password',
  'key', 'env', 'connection', 'agent',
] as const;

/* ── Bounds ─────────────────────────────────────────────────────────────── */

const TIMEOUT_MS = 250;
const MAX_OUTPUT = 5_000_000;

/** The one binding the timebox hook reads. A number, harmless if an expression reads it. */
const DEADLINE = '__silo_deadline';
const TIMEBOX = Symbol.for('jsonata.__evaluate_entry');

class Timeboxed extends Error {
  constructor() {
    super('timeboxed');
  }
}

/* ── Syntax ─────────────────────────────────────────────────────────────── */

/**
 * `{{ … }}` IS THE WHOLE SYNTAX. A string with no braces is a literal, which is
 * what most of a manifest is. A string that is nothing but one expression keeps
 * the expression's own type, so `records` can return an array and `until` a
 * boolean; a string with an expression inside other text interpolates.
 */
const WHOLE = /^\s*\{\{([\s\S]+)\}\}\s*$/;
const PART = /\{\{([\s\S]+?)\}\}/g;

const isExpression = (source: string): boolean => /\{\{[\s\S]+?\}\}/.test(source);

/** Every expression inside a string, as JSONata source. */
export const expressionsIn = (source: string): string[] =>
  [...source.matchAll(PART)].map((match) => match[1]!);

/* ── Helpers a connector may call ───────────────────────────────────────── */

/**
 * A path segment written as-is, for the rare value that really is several
 * segments. Everything else interpolated into a path is encoded as ONE segment
 * (MANIFEST-V2 §9.2), because a value that came from a response or from a
 * person's request must not be able to walk to another endpoint with `../`.
 */
const RAW_PATH = '__silo_raw_path';
const rawPath = (value: unknown): { [RAW_PATH]: string } => ({ [RAW_PATH]: String(value ?? '') });
const isRawPath = (value: unknown): value is { [RAW_PATH]: string } =>
  typeof value === 'object' && value !== null && RAW_PATH in value;

/**
 * QUOTING BY STYLE, NEVER BY SYSTEM. A filter value comes from a person's
 * question and lands in a source's query language — JQL, SOQL, OData, Gmail's
 * search — so quoting cannot be left to whoever wrote the connector (§9.4). These
 * are the styles query languages actually use; which system uses which is the
 * manifest's business, and no system is named here.
 */
function quote(value: unknown, style: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  switch (style) {
    /*
     * A LITERAL IN A LANGUAGE WITH TYPES — OData, SOQL, SQL-shaped filters. A
     * number or a boolean is written bare, null is `null`, and anything else is
     * a string, quoted with the quote character doubled.
     */
    case 'literal_single':
    case 'literal_double': {
      if (value === null || value === undefined) return 'null';
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (typeof value === 'boolean') return String(value);
      return quote(text, style === 'literal_single' ? 'single' : 'double');
    }
    case 'single':
      return `'${text.replace(/'/g, "''")}'`;
    case 'double':
      return `"${text.replace(/"/g, '""')}"`;
    case 'backtick':
      return `\`${text.replace(/`/g, '``')}\``;
    case 'backslash_single':
      return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    case 'backslash_double':
      return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    default:
      throw new Error(`$quote does not know the style ${String(style)}.`);
  }
}

/** Characters with a meaning inside a quoted search term, escaped by style. */
function escape(value: unknown, style: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  switch (style) {
    case 'backslash':
      return text.replace(/[\\"']/g, (c) => `\\${c}`);
    case 'lucene':
      return text.replace(/[+\-!(){}[\]^"~*?:\\/&|]/g, (c) => `\\${c}`);
    case 'like':
      return text.replace(/[\\%_]/g, (c) => `\\${c}`);
    default:
      throw new Error(`$escape does not know the style ${String(style)}.`);
  }
}

/* ── Compiling ──────────────────────────────────────────────────────────── */

const compiled = new Map<string, ReturnType<typeof jsonata>>();

const refused = (name: string, why: string) => () => {
  throw new Error(`$${name}() is not available: ${why}`);
};

function parse(source: string): ReturnType<typeof jsonata> {
  const already = compiled.get(source);
  if (already) return already;

  let expression: ReturnType<typeof jsonata>;
  try {
    expression = jsonata(source);
  } catch (error) {
    throw refusal({
      message: `This connector has an expression Silo cannot read: ${source.trim()}`,
      code: 'refusal.expression_invalid',
      detail: { source: source.trim(), reason: reasonOf(error) },
    });
  }

  expression.registerFunction('now', refused('now', 'a connector must not depend on the clock.'));
  expression.registerFunction('millis', refused('millis', 'a connector must not depend on the clock.'));
  expression.registerFunction('random', refused('random', 'two reads of one source must agree.'));
  expression.registerFunction('eval', refused('eval', 'only what the connector declared is ever run.'));

  expression.registerFunction('quote', quote);
  /* An `in` list: every member quoted the same way, for `$join` to assemble. */
  expression.registerFunction('quoteEach', (values: unknown, style: unknown) =>
    (Array.isArray(values) ? values : values === null || values === undefined ? [] : [values]).map((one) => quote(one, style)),
  );
  expression.registerFunction('escape', escape);
  expression.registerFunction('rawPath', rawPath);
  expression.registerFunction('sha256', (text: unknown, encoding?: unknown) =>
    createHash('sha256')
      .update(text === null || text === undefined ? '' : String(text))
      .digest(encoding === 'base64' ? 'base64' : 'hex'),
  );

  /*
   * THE TIMEBOX, FROM INSIDE. The hook is registered once on the compiled
   * expression and reads the deadline bound for THIS evaluation, so one cached
   * expression evaluated by two reads at once gives each its own clock.
   */
  expression.assign(TIMEBOX as unknown as string, (_node: unknown, _input: unknown, environment: {
    lookup(name: string): unknown;
  }) => {
    const deadline = environment.lookup(DEADLINE);
    if (typeof deadline === 'number' && Date.now() > deadline) throw new Timeboxed();
  });

  compiled.set(source, expression);
  return expression;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : 'failed';

/**
 * THE RECORD IS THE CONTEXT, AND EVERYTHING ELSE IS BOUND BY NAME. A field
 * expression reads `properties.Status.select.name` — the record itself, with no
 * prefix, because that is how somebody writes it when they are looking at one.
 * Everywhere else `$` is the scope, so `response.data`, `state.page` and
 * `steps.list.records` read the way MANIFEST-V2 writes them. Every name is also
 * `$name`.
 */
function bind(scope: Scope): { context: unknown; bindings: Record<string, unknown> } {
  const bindings: Record<string, unknown> = {};
  const context: Record<string, unknown> = {};

  for (const name of NAMES) {
    const one = scope[name];
    bindings[name] = one === undefined ? null : one;
    if (one !== undefined) context[name] = one;
  }
  for (const name of NEVER_BOUND) bindings[name] = null;

  bindings[DEADLINE] = Date.now() + TIMEOUT_MS;

  return { context: scope.record !== undefined ? scope.record : context, bindings };
}

async function run(source: string, scope: Scope): Promise<unknown> {
  const expression = parse(source);
  const { context, bindings } = bind(scope);

  let result: unknown;
  try {
    result = await expression.evaluate(context as never, bindings);
  } catch (error) {
    if (error instanceof Timeboxed) {
      throw refusal({
        message: `An expression in this connector took too long to work out: ${source.trim()}`,
        code: 'refusal.expression_timeout',
        detail: { source: source.trim(), timeoutMs: TIMEOUT_MS },
      });
    }
    if (error && typeof error === 'object' && 'kind' in error && 'code' in error) throw error;
    throw refusal({
      message: `This connector's expression could not be worked out: ${source.trim()}`,
      code: 'refusal.expression_failed',
      detail: { source: source.trim(), reason: reasonOf(error) },
    });
  }

  if (typeof result === 'string' && result.length > MAX_OUTPUT) {
    throw refusal({
      message: 'An expression in this connector produced more than Silo will hold.',
      code: 'refusal.expression_too_large',
      detail: { source: source.trim() },
    });
  }

  return unwrapSequence(result);
}

/**
 * JSONATA RETURNS A SEQUENCE WHERE JSON WOULD RETURN AN ARRAY. It is an array
 * with a flag on it, and it behaves like one everywhere that matters — except
 * that `toEqual` and `JSON.stringify` see the flag. Copying it into a plain
 * array keeps what the engine hands on indistinguishable from parsed JSON.
 */
function unwrapSequence(result: unknown): unknown {
  if (Array.isArray(result) && 'sequence' in result) return [...result];
  return result;
}

/* ── Public ─────────────────────────────────────────────────────────────── */

/**
 * A value from the manifest, with any expression in it worked out.
 *
 * A LITERAL PASSES STRAIGHT THROUGH, which is most of a manifest and is why
 * nobody writing an ordinary connector ever sees this machinery.
 */
export async function value(source: unknown, scope: Scope): Promise<unknown> {
  if (typeof source !== 'string') return source;

  const whole = WHOLE.exec(source);
  if (whole && !whole[1]!.includes('}}')) return run(whole[1]!, scope);

  if (!source.includes('{{')) return source;

  const parts: string[] = [];
  let last = 0;
  for (const match of source.matchAll(PART)) {
    parts.push(source.slice(last, match.index));
    const piece = await run(match[1]!, scope);
    parts.push(textOf(piece));
    last = match.index + match[0].length;
  }
  parts.push(source.slice(last));
  return parts.join('');
}

const textOf = (piece: unknown): string =>
  piece === null || piece === undefined ? '' : isRawPath(piece) ? piece[RAW_PATH] : typeof piece === 'object' ? JSON.stringify(piece) : String(piece);

/** A value that has to be a string for a URL, a header or a parameter; `null` when it came to nothing. */
export async function text(source: unknown, scope: Scope): Promise<string | null> {
  const result = await value(source, scope);
  if (result === null || result === undefined) return null;
  return textOf(result);
}

/**
 * A value that has to be true or false: `until`, `when`, an error's condition.
 *
 * ANYTHING THAT IS NOT `true` IS FALSE. A paging condition that evaluates to
 * nothing because a path is misspelt must not end a read early — it must let
 * the read run into its bounds, which refuse and say so.
 */
export async function truth(source: unknown, scope: Scope): Promise<boolean> {
  return (await value(source, scope)) === true;
}

/**
 * Every value in a map, worked out.
 *
 * `keepNull` IS FOR PATCHES, where `null` means "remove this key" and has to
 * survive to the merge. Everywhere else a value that came to nothing is simply
 * not sent.
 */
export async function every(
  source: Record<string, unknown> | undefined,
  scope: Scope,
  options: { keepNull?: boolean } = {},
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [name, one] of Object.entries(source ?? {})) {
    const worked = await value(one, scope);
    if (worked === undefined) continue;
    if (worked === null && !options.keepNull) continue;
    out[name] = worked;
  }
  return out;
}

/**
 * A tree — a body, a fragment, a state bag — with every string leaf worked out
 * and every other leaf left alone. `null` survives, because in a body patch it
 * means "remove this key".
 */
export async function deep(tree: unknown, scope: Scope): Promise<unknown> {
  if (typeof tree === 'string') return value(tree, scope);
  if (Array.isArray(tree)) {
    const out: unknown[] = [];
    for (const one of tree) out.push(await deep(one, scope));
    return out;
  }
  if (tree !== null && typeof tree === 'object') {
    const out: Record<string, unknown> = {};
    for (const [name, one] of Object.entries(tree as Record<string, unknown>)) {
      const worked = await deep(one, scope);
      if (worked !== undefined) out[name] = worked;
    }
    return out;
  }
  return tree;
}

/**
 * A path, with every interpolated value encoded as ONE segment.
 *
 * `/v1/invoices/{{ identifier.id }}` with an id of `123/../../admin?x=1` must
 * address invoice `123%2F..%2F..%2Fadmin%3Fx%3D1`, not the admin endpoint with a
 * query string — the value came from a person's request or from a response,
 * and neither may choose which endpoint receives a credentialed request
 * (MANIFEST-V2 §9.2). The literal text around the braces is the connector's and
 * is kept as written; `$rawPath()` is the declared exception.
 */
export async function path(source: unknown, scope: Scope): Promise<string | null> {
  if (source === undefined || source === null) return null;
  if (typeof source !== 'string') return String(source);
  if (!source.includes('{{')) return source;

  const parts: string[] = [];
  let last = 0;
  for (const match of source.matchAll(PART)) {
    parts.push(source.slice(last, match.index));
    const piece = await run(match[1]!, scope);
    /*
     * A HOLE NOTHING FILLS IS A REFUSAL, NOT AN EMPTY SEGMENT. `/invoices/{{
     * identifier.id }}` with no id would otherwise ask for `/invoices/` — the
     * whole collection, confidently — or `//` somewhere a server resolves.
     */
    if (piece === null || piece === undefined || piece === '') {
      throw refusal({
        message: `This connector's path needs ${match[1]!.trim()}, which came to nothing for this request.`,
        code: 'refusal.request_unbuildable',
        detail: { source: match[1]!.trim() },
      });
    }
    parts.push(isRawPath(piece) ? piece[RAW_PATH] : encodeURIComponent(textOf(piece)));
    last = match.index + match[0].length;
  }
  parts.push(source.slice(last));
  return parts.join('');
}

/** Only for tests: the cache is keyed by source and would otherwise outlive a suite. */
export function forget(): void {
  compiled.clear();
}
