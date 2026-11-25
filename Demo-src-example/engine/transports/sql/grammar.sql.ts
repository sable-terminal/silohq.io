import type { Meaning } from '../../../schemas/manifest.schema';

/**
 * What SQL looks like in each database's own dialect.
 *
 * ── HOW TO CONNECT AND WHAT TO WRITE ARE TWO QUESTIONS ────────────────────
 *
 * A driver opens a socket; a grammar writes the statement (MANIFEST-V2 §9.5,
 * finding F8). An ODBC bridge reaches DB2, Informix and Teradata, each with its
 * own way of saying "the first hundred rows", so a grammar is chosen separately
 * from the driver. Each grammar is protocol code, written once, shared by every
 * connector on it; `ansi` is the degrade mode that writes no row limit at all
 * and relies on the transport stopping the cursor at the ceiling instead.
 *
 * ── EVERY IDENTIFIER QUOTED, EVERY VALUE A PARAMETER ──────────────────────
 *
 * A table or column name comes from a document; a value comes from somebody's
 * question. Neither is ever concatenated into the text: identifiers are quoted
 * with the quote character doubled, and values are bound.
 */

export type GrammarName = 'postgres' | 'mysql' | 'tsql' | 'oracle' | 'db2' | 'informix' | 'teradata' | 'ansi';

export interface Grammar {
  name: GrammarName;
  quoteIdent(name: string): string;
  /** The text for the n-th bound value, 1-based. */
  placeholder(index: number): string;
  /** Wrap a SELECT so it returns at most `n` rows, or return it unchanged when the grammar cannot say so. */
  limit(select: { head: string; rest: string }, n: number): string;
  /** Case-insensitive containment, with `%` and `_` in the value matching literally. */
  contains(column: string, placeholder: string): string;
  /** `in` over a list: one placeholder per value, or one array parameter where the driver takes arrays. */
  inList(column: string, bind: (value: unknown) => string, values: unknown[]): string;
  /** Statements that make what follows read-only, and how the transaction ends. */
  readOnly: { begin: string[]; end: 'COMMIT' | 'ROLLBACK' };
  /** What a vendor code means when the connector does not say. */
  floor: Record<string, Meaning>;
  /** How a returned row's written result is read back: RETURNING, OUTPUT, or nothing. */
  returning: 'returning' | 'output' | 'none';
}

const doubled = (open: string, close = open) => (name: string) => `${open}${name.split(close).join(close + close)}${close}`;

const escapeLike = (column: string, placeholder: string, lower = true) =>
  lower ? `LOWER(${column}) LIKE LOWER(${placeholder}) ESCAPE '\\'` : `${column} LIKE ${placeholder} ESCAPE '\\'`;

const eachPlaceholder = (column: string, bind: (value: unknown) => string, values: unknown[]) =>
  values.length === 0 ? '1 = 0' : `${column} IN (${values.map(bind).join(', ')})`;

/* SQLSTATE classes most standard databases share. */
const SQLSTATE_COMMON: Record<string, Meaning> = {
  '28000': 'auth',
  '28P01': 'auth',
  '42501': 'auth',
  '42000': 'auth',
  '3D000': 'not_found',
  '42P01': 'not_found',
  '42S02': 'not_found',
  '42703': 'not_found',
  '42S22': 'not_found',
  '57014': 'bounds',
  '53400': 'bounds',
  '08001': 'upstream',
  '08006': 'upstream',
};

export const GRAMMARS: Record<GrammarName, Grammar> = {
  postgres: {
    name: 'postgres',
    quoteIdent: doubled('"'),
    placeholder: (n) => `$${n}`,
    limit: ({ head, rest }, n) => `${head}${rest} LIMIT ${Math.floor(n)}`,
    contains: (column, p) => `${column}::text ILIKE ${p}`,
    inList: (column, bind, values) => `${column} = ANY(${bind(values)})`,
    readOnly: { begin: ['BEGIN READ ONLY'], end: 'COMMIT' },
    floor: SQLSTATE_COMMON,
    returning: 'returning',
  },
  mysql: {
    name: 'mysql',
    quoteIdent: doubled('`'),
    placeholder: () => '?',
    limit: ({ head, rest }, n) => `${head}${rest} LIMIT ${Math.floor(n)}`,
    contains: (column, p) => `${column} LIKE ${p}`,
    inList: eachPlaceholder,
    readOnly: { begin: ['START TRANSACTION READ ONLY'], end: 'COMMIT' },
    floor: {
      ...SQLSTATE_COMMON,
      ER_ACCESS_DENIED_ERROR: 'auth',
      ER_DBACCESS_DENIED_ERROR: 'auth',
      ER_TABLEACCESS_DENIED_ERROR: 'auth',
      ER_NO_SUCH_TABLE: 'not_found',
      ER_BAD_FIELD_ERROR: 'not_found',
      ER_BAD_DB_ERROR: 'not_found',
      ER_QUERY_TIMEOUT: 'bounds',
      ER_QUERY_INTERRUPTED: 'bounds',
      ER_CON_COUNT_ERROR: 'rate_limit',
    },
    returning: 'none',
  },
  tsql: {
    name: 'tsql',
    quoteIdent: doubled('[', ']'),
    placeholder: (n) => `@p${n}`,
    limit: ({ head, rest }, n) => `${head.replace(/^SELECT /, `SELECT TOP (${Math.floor(n)}) `)}${rest}`,
    contains: (column, p) => escapeLike(column, p),
    inList: eachPlaceholder,
    /*
     * SQL SERVER HAS NO READ-ONLY TRANSACTION. Every read runs inside one that
     * is always rolled back, so nothing a read did can persist; the role's
     * write permission is shown to the admin at connect.
     */
    readOnly: { begin: ['BEGIN TRANSACTION'], end: 'ROLLBACK' },
    floor: { ...SQLSTATE_COMMON, '18456': 'auth', '229': 'auth', '230': 'auth', '208': 'not_found', '207': 'not_found', '4060': 'not_found', ETIMEOUT: 'bounds', ELOGIN: 'auth' },
    returning: 'output',
  },
  oracle: {
    name: 'oracle',
    quoteIdent: doubled('"'),
    placeholder: (n) => `:${n}`,
    limit: ({ head, rest }, n) => `${head}${rest} FETCH FIRST ${Math.floor(n)} ROWS ONLY`,
    contains: (column, p) => escapeLike(column, p),
    inList: eachPlaceholder,
    readOnly: { begin: ['SET TRANSACTION READ ONLY'], end: 'COMMIT' },
    floor: { 'ORA-01017': 'auth', 'ORA-01031': 'auth', 'ORA-28000': 'auth', 'ORA-00942': 'not_found', 'ORA-00904': 'not_found', 'ORA-01013': 'bounds', 'ORA-12541': 'upstream', 'NJS-500': 'upstream' },
    returning: 'none',
  },
  db2: {
    name: 'db2',
    quoteIdent: doubled('"'),
    placeholder: () => '?',
    limit: ({ head, rest }, n) => `${head}${rest} FETCH FIRST ${Math.floor(n)} ROWS ONLY`,
    contains: (column, p) => escapeLike(column, p),
    inList: eachPlaceholder,
    readOnly: { begin: [], end: 'ROLLBACK' },
    floor: { ...SQLSTATE_COMMON, '42704': 'not_found', '42502': 'auth', '08004': 'auth', '57033': 'bounds' },
    returning: 'none',
  },
  informix: {
    name: 'informix',
    quoteIdent: doubled('"'),
    placeholder: () => '?',
    limit: ({ head, rest }, n) => `${head.replace(/^SELECT /, `SELECT FIRST ${Math.floor(n)} `)}${rest}`,
    contains: (column, p) => escapeLike(column, p),
    inList: eachPlaceholder,
    readOnly: { begin: [], end: 'ROLLBACK' },
    floor: { ...SQLSTATE_COMMON, IX000: 'upstream' },
    returning: 'none',
  },
  teradata: {
    name: 'teradata',
    quoteIdent: doubled('"'),
    placeholder: () => '?',
    limit: ({ head, rest }, n) => `${head.replace(/^SELECT /, `SELECT TOP ${Math.floor(n)} `)}${rest}`,
    contains: (column, p) => escapeLike(column, p),
    inList: eachPlaceholder,
    readOnly: { begin: [], end: 'ROLLBACK' },
    floor: { ...SQLSTATE_COMMON, '3807': 'not_found', '3810': 'not_found', '8017': 'auth', '3523': 'auth' },
    returning: 'none',
  },
  /*
   * THE DEGRADE MODE. No row limit in the text at all: the transport reads the
   * cursor to the ceiling plus one and stops, which is correct on any database
   * that speaks standard SQL, only slower.
   */
  ansi: {
    name: 'ansi',
    quoteIdent: doubled('"'),
    placeholder: () => '?',
    limit: ({ head, rest }) => `${head}${rest}`,
    contains: (column, p) => escapeLike(column, p),
    inList: eachPlaceholder,
    readOnly: { begin: [], end: 'ROLLBACK' },
    floor: SQLSTATE_COMMON,
    returning: 'none',
  },
};
