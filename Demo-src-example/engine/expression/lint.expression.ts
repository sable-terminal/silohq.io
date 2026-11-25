import jsonata from 'jsonata';
import { expressionsIn } from './evaluate.expression';

/**
 * Checks on what an expression READS, made on its syntax tree at schema time.
 *
 * ── WHY THESE ARE NOT LEFT TO THE AUTHOR ──────────────────────────────────
 *
 * Two places in a manifest turn a value somebody else supplied into text a
 * system will interpret. A pushdown fragment splices a filter value from a
 * person's question into JQL, SOQL, OData or a search string; a signed
 * request's canonical string is what the transport will sign with the
 * connection's key. In both, a mistake is silent — the query still runs, the
 * signature still verifies — so MANIFEST-V2 §9.4 and §9.1 make them rules the
 * schema checks rather than advice.
 *
 * ── WHAT THIS IS AND IS NOT A DEFENCE AGAINST ─────────────────────────────
 *
 * It catches the honest author who forgot to quote, which is the realistic
 * failure: a user of the connector, asking a question, then injects through the
 * hole. It is not a defence against a hostile AUTHOR — somebody writing the
 * connector already chooses the whole query, and deliberately reaching `value`
 * through `$lookup($$, "value")` is authorship, governed by trust tiers and
 * review rather than by a parser.
 */

type Node = {
  type?: string;
  value?: unknown;
  steps?: Node[];
  procedure?: Node;
  arguments?: Node[];
  lhs?: Node;
  rhs?: Node;
  body?: Node;
  [key: string]: unknown;
};

/** Helpers that make a value safe to splice: the whole of their first argument is quoted or numeric. */
const QUOTING = new Set(['quote', 'quoteEach', 'escape', 'number']);

const JSONATA_BUILTINS = new Set([
  'sum', 'count', 'max', 'min', 'average', 'string', 'substring', 'substringBefore', 'substringAfter',
  'lowercase', 'uppercase', 'length', 'trim', 'pad', 'contains', 'split', 'join', 'match', 'replace',
  'now', 'millis', 'formatNumber', 'formatBase', 'formatInteger', 'parseInteger', 'number', 'abs',
  'floor', 'ceil', 'round', 'power', 'sqrt', 'random', 'boolean', 'not', 'exists', 'keys', 'lookup',
  'spread', 'merge', 'sift', 'each', 'error', 'assert', 'type', 'sort', 'reverse', 'shuffle', 'distinct',
  'zip', 'map', 'filter', 'single', 'reduce', 'append', 'base64encode', 'base64decode',
  'encodeUrlComponent', 'encodeUrl', 'decodeUrlComponent', 'decodeUrl', 'eval', 'toMillis', 'fromMillis',
  'clone', 'quote', 'quoteEach', 'escape', 'rawPath', 'sha256',
]);

function astOf(source: string): Node | null {
  try {
    return jsonata(source).ast() as Node;
  } catch {
    return null;
  }
}

/** Names a lambda or a `:=` binds inside the expression. They are local, not reads of the scope. */
function localNames(node: Node, into = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return into;
  if (node.type === 'lambda') {
    for (const arg of node.arguments ?? []) if (typeof arg.value === 'string') into.add(arg.value);
  }
  if (node.type === 'bind' && node.lhs && typeof node.lhs.value === 'string') into.add(node.lhs.value);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach((one) => localNames(one as Node, into));
    else if (child && typeof child === 'object') localNames(child as Node, into);
  }
  return into;
}

/**
 * The scope name a path or variable reads first, or null when it reads nothing
 * from the scope (a literal, a local, a built-in).
 */
function rootOf(node: Node, locals: Set<string>): string | null {
  if (node.type === 'variable') {
    const name = String(node.value ?? '');
    if (name === '' || name === '$') return '$';
    if (locals.has(name) || JSONATA_BUILTINS.has(name)) return null;
    return name;
  }
  if (node.type === 'path' && node.steps && node.steps.length > 0) {
    const first = node.steps[0]!;
    if (first.type === 'name') return String(first.value);
    if (first.type === 'variable') {
      const name = String(first.value ?? '');
      if (name === '' || name === '$') {
        const second = node.steps[1];
        return second && second.type === 'name' ? String(second.value) : '$';
      }
      if (locals.has(name) || JSONATA_BUILTINS.has(name)) return null;
      return name;
    }
  }
  if (node.type === 'name') return String(node.value);
  return null;
}

/**
 * Every place `value` is read outside a quoting helper's first argument.
 *
 * Returns a sentence per violation, empty when the expression is safe. Applied
 * to every `fragment`, `compose`, `sort` and `aggregates` template (§9.4).
 */
export function unquotedValue(source: string): string[] {
  const problems: string[] = [];

  for (const inner of expressionsIn(source)) {
    const ast = astOf(inner);
    if (!ast) continue;
    const locals = localNames(ast);

    const walk = (node: Node, quoted: boolean): void => {
      if (!node || typeof node !== 'object') return;

      if (node.type === 'function' && node.procedure?.type === 'variable' && QUOTING.has(String(node.procedure.value))) {
        const [first, ...rest] = node.arguments ?? [];
        if (first) walk(first, true);
        rest.forEach((one) => walk(one, quoted));
        return;
      }

      if ((node.type === 'path' || node.type === 'variable') && rootOf(node, locals) === 'value' && !quoted) {
        problems.push(
          `${inner.trim()} splices value into the query without $quote, $quoteEach, $escape or $number — a filter value comes from somebody's question and must be quoted.`,
        );
        return;
      }

      for (const [key, child] of Object.entries(node)) {
        if (key === 'position') continue;
        if (Array.isArray(child)) child.forEach((one) => walk(one as Node, quoted));
        else if (child && typeof child === 'object') walk(child as Node, quoted);
      }
    };

    walk(ast, false);
  }

  return problems;
}

/**
 * Every scope name an expression reads that is not one of `allowed`.
 *
 * Applied to `signed.canonical` with `['request', 'params']` (§9.1): the text a
 * connection's key signs must describe the request being sent, not something
 * else the document could reach.
 */
export function readsOutside(source: string, allowed: readonly string[]): string[] {
  const permitted = new Set(allowed);
  const outside = new Set<string>();

  for (const inner of expressionsIn(source)) {
    const ast = astOf(inner);
    if (!ast) continue;
    const locals = localNames(ast);

    const walk = (node: Node): void => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'function') {
        (node.arguments ?? []).forEach(walk);
        return;
      }
      if (node.type === 'path' || node.type === 'variable') {
        const root = rootOf(node, locals);
        if (root !== null && !permitted.has(root)) outside.add(root);
        if (node.type === 'path') {
          (node.steps ?? []).slice(1).forEach((step) => {
            if (step.type !== 'name' && step.type !== 'variable') walk(step);
          });
        }
        return;
      }
      for (const [key, child] of Object.entries(node)) {
        if (key === 'position') continue;
        if (Array.isArray(child)) child.forEach((one) => walk(one as Node));
        else if (child && typeof child === 'object') walk(child as Node);
      }
    };

    walk(ast);
  }

  return [...outside];
}

/**
 * The record keys an expression reads, when the record is its context: the
 * first step of every plain path. A SQL read uses this to name the columns a
 * derived field needs, so it never has to fall back to `SELECT *`.
 */
export function recordKeysRead(source: string): string[] {
  const keys = new Set<string>();
  for (const inner of expressionsIn(source)) {
    const ast = astOf(inner);
    if (!ast) continue;
    const walk = (node: Node): void => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'path' && node.steps && node.steps[0]?.type === 'name') keys.add(String(node.steps[0].value));
      else if (node.type === 'name') keys.add(String(node.value));
      for (const [key, child] of Object.entries(node)) {
        if (key === 'position' || (node.type === 'path' && key === 'steps')) continue;
        if (Array.isArray(child)) child.forEach((one) => walk(one as Node));
        else if (child && typeof child === 'object') walk(child as Node);
      }
      if (node.type === 'path') (node.steps ?? []).slice(1).forEach((step) => { if (step.type !== 'name') walk(step); });
    };
    walk(ast);
  }
  return [...keys];
}
