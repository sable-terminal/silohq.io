// SQL text for systems Silo does not own: customer databases and BigQuery. Only the SQL
// and BigQuery protocol engines and the warehouse generator build it, and only through
// this module (tests/architecture/sql.test.ts). Silo's own databases are reached through
// repos, never through this.
//
// Safe by construction, so the rule "generated SQL is parameterised" holds without review:
// - constant text comes only from the template literals of the sql tag, written in code;
// - every interpolated value becomes a bound parameter, never text;
// - identifiers come from the manifest and are quoted by the dialect's own rule (ident);
// - words chosen at run time (a sort direction, an operator, an aggregate) come from a
//   closed list (keyword).
// There is no raw-text escape hatch.

export const DIALECTS = ['postgres', 'sqlserver', 'oracle', 'mysql', 'snowflake', 'bigquery', 'databricks'] as const;
export type Dialect = (typeof DIALECTS)[number];

interface DialectRules {
  quote(part: string): string;
  placeholder(n: number): string;
  /** Longer identifiers are refused: Postgres would silently truncate them. */
  maxIdentifierBytes: number;
  /** Characters a quoted identifier cannot hold in this dialect, even escaped. */
  forbidden?: RegExp;
}

const doubled = (open: string, close: string) => (part: string): string =>
  `${open}${part.replaceAll(close, close + close)}${close}`;

const RULES: Record<Dialect, DialectRules> = {
  postgres: { quote: doubled('"', '"'), placeholder: (n) => `$${n}`, maxIdentifierBytes: 63 },
  sqlserver: { quote: doubled('[', ']'), placeholder: (n) => `@p${n}`, maxIdentifierBytes: 128 },
  oracle: { quote: doubled('"', '"'), placeholder: (n) => `:${n}`, maxIdentifierBytes: 128, forbidden: /"/ },
  mysql: { quote: doubled('`', '`'), placeholder: () => '?', maxIdentifierBytes: 64 },
  snowflake: { quote: doubled('"', '"'), placeholder: () => '?', maxIdentifierBytes: 255 },
  // BigQuery escapes inside a quoted identifier with a backslash.
  bigquery: {
    quote: (part) => `\`${part.replaceAll('\\', '\\\\').replaceAll('`', '\\`')}\``,
    placeholder: (n) => `@p${n}`, maxIdentifierBytes: 1024,
  },
  databricks: { quote: doubled('`', '`'), placeholder: () => '?', maxIdentifierBytes: 255 },
};

// Words a protocol engine may choose at run time from a plan. Anything else is either
// constant text in a template or a bound value.
export const KEYWORDS = [
  'asc', 'desc', 'nulls first', 'nulls last', 'and', 'or', 'not', 'distinct',
  '=', '<>', '<', '<=', '>', '>=', 'like', 'not like', 'in', 'not in', 'is null', 'is not null', 'between',
  'count', 'sum', 'min', 'max', 'avg',
] as const;
export type SqlKeyword = (typeof KEYWORDS)[number];

const IDENTIFIER = Symbol('identifier');
const KEYWORD = Symbol('keyword');

export interface Identifier {
  readonly [IDENTIFIER]: readonly string[];
}

export interface Keyword {
  readonly [KEYWORD]: SqlKeyword;
}

type Token = { text: string } | { value: unknown } | { identifier: readonly string[] } | { fragment: SqlFragment };

export class SqlFragment {
  readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }
}

function tokenOf(value: unknown): Token {
  if (value === undefined) throw new TypeError('a SQL value is undefined: bind null for a missing value');
  if (value instanceof SqlFragment) return { fragment: value };
  if (typeof value === 'object' && value !== null && IDENTIFIER in value) return { identifier: (value as Identifier)[IDENTIFIER] };
  if (typeof value === 'object' && value !== null && KEYWORD in value) return { text: (value as Keyword)[KEYWORD] };
  return { value };
}

/** The tag: constant text from the template, every interpolation a bound value, identifier, keyword or fragment. */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  const tokens: Token[] = [];
  strings.forEach((text, i) => {
    if (text !== '') tokens.push({ text });
    if (i < values.length) tokens.push(tokenOf(values[i]));
  });
  return new SqlFragment(tokens);
}

/** Fragments separated by a constant fragment, such as sql`, ` or sql` and `. */
sql.join = (fragments: readonly SqlFragment[], separator: SqlFragment): SqlFragment =>
  new SqlFragment(fragments.flatMap((fragment, i) => (i === 0 ? [{ fragment }] : [{ fragment: separator }, { fragment }])));

/** Values as a comma-separated list of bound parameters, for an IN list. Never empty. */
sql.list = (values: readonly unknown[]): SqlFragment => {
  if (values.length === 0) throw new TypeError('an empty SQL list: refuse the step instead');
  return new SqlFragment(values.flatMap((value, i) => (i === 0 ? [tokenOf(value)] : [{ text: ', ' }, tokenOf(value)])));
};

/** An identifier from the manifest, such as ident('sales', 'orders'): each part quoted by the dialect. */
export function ident(...parts: string[]): Identifier {
  if (parts.length === 0) throw new TypeError('an identifier needs at least one part');
  for (const part of parts) {
    if (typeof part !== 'string' || part.length === 0 || part.includes('\u0000')) {
      throw new TypeError('an identifier part must be a non-empty string without NUL');
    }
  }
  return { [IDENTIFIER]: [...parts] };
}

/** A word chosen at run time, from KEYWORDS only. */
export function keyword(word: SqlKeyword): Keyword {
  if (!(KEYWORDS as readonly string[]).includes(word)) throw new TypeError('not a permitted SQL keyword');
  return { [KEYWORD]: word };
}

export interface RenderedSql {
  text: string;
  /** In placeholder order. Named dialects (sqlserver, bigquery) name value i as p<i+1>. */
  values: unknown[];
}

export function render(fragment: SqlFragment, dialect: Dialect): RenderedSql {
  const rules = RULES[dialect];
  const values: unknown[] = [];
  const walk = (f: SqlFragment): string => f.tokens.map((token) => {
    if ('text' in token) return token.text;
    if ('fragment' in token) return walk(token.fragment);
    if ('identifier' in token) {
      return token.identifier.map((part) => {
        if (Buffer.byteLength(part, 'utf8') > rules.maxIdentifierBytes) {
          throw new TypeError(`a ${dialect} identifier is at most ${rules.maxIdentifierBytes} bytes`);
        }
        if (rules.forbidden?.test(part)) throw new TypeError(`a ${dialect} identifier cannot hold that character`);
        return rules.quote(part);
      }).join('.');
    }
    values.push(token.value);
    return rules.placeholder(values.length);
  }).join('');
  return { text: walk(fragment), values };
}
