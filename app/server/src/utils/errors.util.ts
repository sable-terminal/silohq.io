// Errors that are safe to log, return and count.
//
// Every error crossing a service boundary is an AppError with a category from a closed
// set. Its message is written by a developer and never carries a record value; a
// foreign error (a driver, an SDK) is reduced to a category and its message is dropped,
// because "source driver error messages are not logged, because drivers include row
// values in them" (spec 13.1). The original error is kept as cause for a debugger, and
// never logged.
//
// A refusal is not an error (spec 12.1): exceeding a bound, shedding under load and an
// unreachable source are correct outcomes, counted apart from failures, and never
// return partial data (invariant 2).

export const ERROR_CATEGORIES = [
  'validation',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'bounds',
  'capacity',
  'source_unreachable',
  'upstream',
  'unavailable',
  'timeout',
  'integrity',
  'configuration',
  'internal',
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

const REFUSALS: ReadonlySet<ErrorCategory> = new Set(['bounds', 'capacity', 'source_unreachable']);

const HTTP_STATUS: Record<ErrorCategory, number> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  bounds: 422,
  capacity: 503,
  source_unreachable: 503,
  upstream: 502,
  unavailable: 503,
  timeout: 504,
  integrity: 500,
  configuration: 500,
  internal: 500,
};

/** Identifiers, counts and names from a closed set only. Never a record value. */
export type SafeDetails = Readonly<Record<string, string | number | boolean>>;

export interface AppErrorOptions {
  /** Stable machine code, for example 'executor.rows_per_source_step'. */
  code?: string;
  details?: SafeDetails;
  retryable?: boolean;
  /** Seconds the caller should wait. Required on a capacity refusal (spec 12.4). */
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly details: SafeDetails;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(category: ErrorCategory, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.category = category;
    this.code = options.code ?? category;
    this.details = options.details ?? {};
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.retryable = options.retryable
      ?? (category === 'unavailable' || category === 'timeout' || category === 'capacity');
  }

  get refusal(): boolean {
    return REFUSALS.has(this.category);
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.category];
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

// Refusals, each naming what was refused (invariant 2: refuse and say why).
export const refuse = {
  bound(bound: string, limit: number, details: SafeDetails = {}): AppError {
    return new AppError('bounds', `refused: the ${bound} bound of ${limit} was exceeded`, {
      code: `bound.${bound}`, details: { bound, limit, ...details }, retryable: false,
    });
  },
  capacity(retryAfterSeconds: number, details: SafeDetails = {}): AppError {
    return new AppError('capacity', `refused: capacity; retry after ${retryAfterSeconds} seconds`, {
      code: 'capacity.shed', details, retryAfterSeconds,
    });
  },
  sourceUnreachable(connectionId: string): AppError {
    return new AppError('source_unreachable', 'refused: the source is unreachable', {
      code: 'source.unreachable', details: { connectionId }, retryable: true,
    });
  },
};

// SQLSTATE classes (PostgreSQL appendix A) to categories. The message, detail and hint
// are dropped: a unique violation's detail names the duplicated values.
export function fromDatabaseError(error: unknown): AppError {
  if (isAppError(error)) return error;
  const pgError = error as { code?: unknown; constraint?: unknown; table?: unknown; schema?: unknown };
  const sqlstate = typeof pgError.code === 'string' && /^[0-9A-Z]{5}$/.test(pgError.code) ? pgError.code : '';
  const details: Record<string, string> = { sqlstate };
  if (typeof pgError.constraint === 'string') details['constraint'] = pgError.constraint;
  if (typeof pgError.schema === 'string' && typeof pgError.table === 'string') {
    details['table'] = `${pgError.schema}.${pgError.table}`;
  }
  const options = (extra: AppErrorOptions = {}): AppErrorOptions => ({ code: `db.${sqlstate || 'unknown'}`, details, cause: error, ...extra });

  if (sqlstate === '23505' || sqlstate === '23503' || sqlstate === '23P01') {
    return new AppError('conflict', 'database constraint conflict', options());
  }
  if (sqlstate === '40001' || sqlstate === '40P01') {
    return new AppError('conflict', 'concurrent update; retry the transaction', options({ retryable: true }));
  }
  if (sqlstate.startsWith('23') || sqlstate.startsWith('22')) {
    return new AppError('validation', 'database rejected the values', options());
  }
  if (sqlstate === '42501') return new AppError('forbidden', 'database refused the statement', options());
  if (sqlstate === '57014') return new AppError('timeout', 'database statement timed out', options());
  if (sqlstate.startsWith('08') || sqlstate.startsWith('57P') || sqlstate.startsWith('53')) {
    return new AppError('unavailable', 'database unavailable', options());
  }
  if (sqlstate === '') {
    const code = pgError.code;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
      return new AppError('unavailable', 'database unreachable', options({ code: `db.${code}` }));
    }
  }
  return new AppError('internal', 'database error', options());
}

// Any error reduced to what may be logged: category, code, class and safe details.
export interface SafeErrorDescription {
  errorCategory: ErrorCategory;
  errorCode: string;
  errorClass: string;
  refusal: boolean;
}

export function describeError(error: unknown): SafeErrorDescription {
  if (isAppError(error)) {
    return { errorCategory: error.category, errorCode: error.code, errorClass: 'AppError', refusal: error.refusal };
  }
  const errorClass = error instanceof Error ? error.constructor.name : typeof error;
  return { errorCategory: 'internal', errorCode: 'unhandled', errorClass, refusal: false };
}

/** Where a request failed its contract: the path and the rule, never the value. */
export interface Issue {
  path: string;
  code: string;
  message: string;
}

/** A request that does not match its contract, with the paths at fault (never the values). */
export class ContractViolation extends AppError {
  readonly issues: readonly Issue[];

  constructor(message: string, code: string, issues: readonly Issue[]) {
    super('validation', message, { code, details: { issues: issues.length } });
    this.issues = issues;
  }
}
