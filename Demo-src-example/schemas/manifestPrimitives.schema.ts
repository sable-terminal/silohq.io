import { z } from 'zod';
import jsonata from 'jsonata';

/**
 * The building blocks the v2 manifest and its auth strategies share.
 *
 * A FILE OF ITS OWN BECAUSE BOTH SCHEMAS NEED THEM AND NEITHER MAY IMPORT THE
 * OTHER FOR THEM. The manifest imports the auth union; the auth union needs
 * `expression`, `tree` and the placement grammar. Put in either file, the other
 * would import it back, and a circular import of module-level zod objects
 * evaluates one side as `undefined`.
 */

/* ── Expressions ────────────────────────────────────────────────────────── */

const PART = /\{\{([\s\S]+?)\}\}/g;

/**
 * Whether every `{{ … }}` in a string parses, and if not, why.
 *
 * PARSED AT THE BOUNDARY so the builder can point at the expression that is
 * wrong, rather than the engine refusing at read time with a sentence about a
 * field the person has long since moved away from.
 */
export function expressionsParse(source: string): string | null {
  for (const match of source.matchAll(PART)) {
    try {
      jsonata(match[1]!);
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : error && typeof error === 'object' && 'message' in error
            ? String((error as { message: unknown }).message)
            : 'unreadable';
      return `${match[1]!.trim()}: ${reason}`;
    }
  }
  return null;
}

/*
 * THE BOUND IS ON CODE, NOT ON TEXT. What runs is what is inside `{{ }}`, and
 * that stays at 4,000 characters. The text around it may be longer: a request
 * that names every field a system holds — in a query parameter, a SOQL
 * statement, a GraphQL document — is a long list of names and nothing else.
 */
export const MAX_EXPRESSION_CODE = 4_000;
const MAX_EXPRESSION_TEXT = 20_000;

/** A literal, or text with `{{ JSONata }}` in it. Most of a manifest is literals. */
export const expression = z
  .string()
  .max(MAX_EXPRESSION_TEXT)
  .superRefine((source, ctx) => {
    const code = [...source.matchAll(PART)].reduce((sum, match) => sum + match[1]!.length, 0);
    if (code > MAX_EXPRESSION_CODE) {
      ctx.addIssue({ code: 'custom', message: `An expression may run to ${MAX_EXPRESSION_CODE} characters of code; this has ${code}.` });
      return;
    }
    const problem = expressionsParse(source);
    if (problem) ctx.addIssue({ code: 'custom', message: `Not an expression Silo can read — ${problem}` });
  })
  .describe('A literal, or {{ JSONata }}');

export const MAX_TREE_DEPTH = 16;
export const MAX_TREE_LEAVES = 2_000;

function walkTree(value: unknown, ctx: z.RefinementCtx, path: (string | number)[], counter: { leaves: number }): void {
  if (path.length > MAX_TREE_DEPTH) {
    ctx.addIssue({ code: 'custom', path, message: `Deeper than ${MAX_TREE_DEPTH} levels.` });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((one, index) => walkTree(one, ctx, [...path, index], counter));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, one] of Object.entries(value as Record<string, unknown>)) walkTree(one, ctx, [...path, key], counter);
    return;
  }
  counter.leaves += 1;
  if (counter.leaves > MAX_TREE_LEAVES) {
    ctx.addIssue({ code: 'custom', path, message: `More than ${MAX_TREE_LEAVES} values.` });
    return;
  }
  if (typeof value === 'string') {
    const problem = expressionsParse(value);
    if (problem) ctx.addIssue({ code: 'custom', path, message: `Not an expression Silo can read — ${problem}` });
  }
}

/**
 * A JSON value whose string leaves may be expressions — a body, a fragment, a
 * state bag.
 *
 * BOUNDED IN DEPTH AND WIDTH AT THE BOUNDARY, because a document can arrive from
 * another organisation and the evaluator walks every leaf of a body on every
 * request.
 */
export const tree = z.unknown().superRefine((value, ctx) => walkTree(value, ctx, [], { leaves: 0 }));

/** Every string leaf of a tree, for checks that read expressions wherever they sit. */
export function stringsIn(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) value.forEach((one) => stringsIn(one, into));
  else if (value !== null && typeof value === 'object') Object.values(value).forEach((one) => stringsIn(one, into));
  return into;
}

export const name = z.string().min(1).max(128);
export const identifierName = z.string().regex(/^[a-z][a-z0-9_]*$/, 'lower_snake_case').max(64);
export const stringMap = z.record(z.string().min(1).max(128), expression);


/* ── Where a value rides ────────────────────────────────────────────────── */

/**
 * `header:<name>`, `query:<name>`, `body:<json.path>`, `cookie:<name>`,
 * `form:<name>`, `soap:<Header/element/path>`, and `socket:<name>` for a value
 * the protocol takes on the connection (a database login, a Kafka registry key).
 *
 * ONE PLACEMENT GRAMMAR FOR EVERY STRATEGY THAT PLACES SOMETHING. A signed
 * scheme puts a signature in one header and a key id in another; a session
 * reads a token out of a body and puts it in a cookie; WS-Security writes a
 * UsernameToken into the SOAP header. Each was a differently named field in v1.
 */
export const place = z
  .string()
  .regex(/^(header|query|body|cookie|form|soap):[A-Za-z0-9_.:\-\[\]\/]+$|^socket:(username|password|accessToken|privateKey|passphrase|registryUsername|registryPassword)$/)
  .describe('header:<name> | query:<name> | body:<json.path> | cookie:<name> | form:<name> | soap:<Header/path> | socket:<username|password|accessToken|registryUsername|registryPassword>');

/** Where a value is READ from in a response. */
export const placeFrom = z
  .string()
  .regex(/^(body|header|cookie):[A-Za-z0-9_.\-\[\]]+$/)
  .describe('body:<json.path> | header:<name> | cookie:<name>');

export type Place = z.infer<typeof place>;
export type PlaceFrom = z.infer<typeof placeFrom>;

/* ── Regular expressions a manifest supplies ────────────────────────────── */

/**
 * Whether a manifest-supplied regular expression is safe to run on Silo.
 *
 * A PATTERN RUNS ON THE API INSTANCE HANDLING SOMEBODY'S CONNECT FORM, so
 * `^(a+)+$` against a long mismatching value would stall it (MANIFEST-V2 §9.6).
 * Nested quantifiers and backreferences are the shapes that backtrack
 * catastrophically; refusing them outright is a cheaper guarantee than a
 * linear-time engine, and no honest connect-form pattern needs either.
 */
export function unsafePattern(pattern: string): string | null {
  try {
    new RegExp(pattern);
  } catch (error) {
    return `not a regular expression: ${error instanceof Error ? error.message : 'unreadable'}`;
  }
  if (/\\[1-9]|\\k</.test(pattern)) return 'backreferences are not allowed';
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{?]/.test(pattern)) return 'a quantified group containing a quantifier can backtrack without end';
  return null;
}

/** The input a manifest pattern is ever matched against is at most this long. */
export const PATTERN_INPUT_MAX = 512;
