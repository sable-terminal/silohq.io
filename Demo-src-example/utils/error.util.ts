/**
 * The error taxonomy.
 *
 * A DENIAL AND A REFUSAL MUST NEVER LOOK ALIKE TO A CALLER, and that is the
 * reason this file exists rather than a convention of throwing `Error`.
 *
 *   DENIAL   You are not allowed. A permission signal. The answer exists and is
 *            being withheld. Retrying will not help; someone must grant access.
 *
 *   REFUSAL  Silo will not answer. A capability signal. Nobody is being kept
 *            from anything — the question cannot be answered inside its bounds,
 *            or a source is unreachable, or the result would be partial.
 *            Retrying may help. Narrowing the question certainly might.
 *
 * Collapse the two and the product breaks in both directions. A refusal shown as
 * a denial sends a user to their administrator for access they already have, and
 * the administrator finds nothing to grant. A denial shown as a refusal invites
 * the user to rephrase until the wording accidentally reaches something they
 * should not see — and tells them, by the shape of the failures, roughly where
 * the boundary is.
 *
 * The product's honesty claim rests on this line. "It refuses and says why"
 * means nothing if the refusal is indistinguishable from being locked out.
 */

export type ErrorKind =
  /** No usable session. Identity signal. Sign in again. */
  | 'unauthenticated'
  /** Not permitted. Permission signal. Someone must grant something. */
  | 'denial'
  /** Will not answer within bounds. Capability signal. Nobody is at fault. */
  | 'refusal'
  /** A source system failed or was unreachable. Not our judgement, theirs. */
  | 'upstream'
  /** The result would exceed a size, row, time or memory ceiling. */
  | 'bounds'
  /** The request itself is malformed. Fix the request. */
  | 'invalid'
  /** A rule of the system was violated: a delegation rule, a policy floor. */
  | 'policy'
  /** Not found, or not visible — see the note on `notFound` below. */
  | 'missing'
  /** Not now. A pace signal, and the only kind that is nobody's fault. */
  | 'limited'
  /** Right request, wrong building. A routing signal. */
  | 'other-cell'
  /** Everything else. Ours, unexpected, and worth a page. */
  | 'internal';

const STATUS: Record<ErrorKind, number> = {
  /*
   * 401 AND NOT 403, AND THE DIFFERENCE IS A WHOLE SCREEN IN THE CLIENT. 401
   * means "we do not know who you are" and the answer is to sign in; 403 means
   * "we know exactly who you are and the answer is no", and the answer is to ask
   * an administrator. Sending 403 for both — which is what happened until this
   * was tried against a suspended member — puts a user whose session merely
   * expired in front of a permissions error, with no way to guess that signing
   * in again would fix it.
   */
  unauthenticated: 401,
  denial: 403,
  /*
   * 422, NOT 403 AND NOT 200. A refusal is not a permission failure, so 403 is
   * wrong and would be read as one by every client and every log dashboard. It
   * is also not a success with an empty body, which is what "return nothing
   * rather than a partial answer" degenerates into if it is not given a status.
   */
  refusal: 422,
  upstream: 502,
  bounds: 413,
  invalid: 400,
  policy: 409,
  missing: 404,
  /*
   * 429 IS ITS OWN KIND RATHER THAN A BORROWED ONE. A rate limit is neither a
   * denial nor a refusal: nobody is being kept from anything they may have, and
   * Silo is not declining to answer the question. It is the same request at a
   * different time, which is why it is the only kind besides `upstream` and
   * `internal` that is retryable — and why dressing it up as an `invalid` would
   * tell the client to change a request that was correct.
   */
  limited: 429,
  /*
   * 421 MISDIRECTED REQUEST, which is precisely what this is: "the request was
   * directed at a server that is not able to produce a response". The person's
   * credentials may be perfect; their data is in a different cell and this
   * process cannot reach it, by design. Reporting it as a credential failure —
   * which is what happened before there was a directory — is both untrue and
   * unfixable by them.
   */
  'other-cell': 421,
  internal: 500,
};

/** Whether trying the same thing again could plausibly work. */
const RETRYABLE: Record<ErrorKind, boolean> = {
  unauthenticated: false,
  denial: false,
  refusal: false,
  upstream: true,
  bounds: false,
  invalid: false,
  policy: false,
  missing: false,
  limited: true,
  // Not here, not ever. Retrying against the right cell is a different request.
  'other-cell': false,
  internal: true,
};

export interface AppErrorOptions {
  /** Shown to the person. Must be true, specific, and free of internals. */
  message: string;
  /** A stable code for clients to branch on: `bounds.row_limit`. */
  code: string;
  /** Structured context for the log. Redacted before it is written. */
  detail?: Record<string, unknown>;
  /**
   * Per-field messages, and the ONLY part of an error besides `message` that
   * reaches the caller.
   *
   * SEPARATE FROM `detail` BECAUSE THEY HAVE OPPOSITE AUDIENCES. `detail` is for
   * the log and is assumed to hold things a caller must not see — which is why
   * `toResponse` drops it. That left a form no way to learn WHICH input was
   * wrong: every validation failure arrived as "the request is not valid" with
   * nothing to point at, so the person re-submits the same form guessing. A
   * field name and a sentence is the difference between one attempt and four.
   *
   * Whatever goes here is published. Put the reason a value was rejected in it,
   * never the value.
   */
  fields?: Record<string, string>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown>;
  readonly fields: Record<string, string>;

  constructor(kind: ErrorKind, options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'AppError';
    this.kind = kind;
    this.code = options.code;
    this.status = STATUS[kind];
    this.retryable = RETRYABLE[kind];
    this.detail = options.detail ?? {};
    this.fields = options.fields ?? {};
  }
}

/**
 * You are not allowed to do this.
 *
 * THE MESSAGE SHOULD NAME THE PERMISSION, NOT THE RESOURCE. "You need
 * `mutation.approve` on this connection" is actionable — the reader can ask for
 * it by name. "You cannot approve mutations on Sage" tells them they are locked
 * out and leaves them to guess what to request. It also avoids confirming that
 * a specific resource exists to somebody who cannot see it.
 */
export function denial(options: AppErrorOptions): AppError {
  return new AppError('denial', options);
}

/**
 * We do not know who you are.
 *
 * EVERY CAUSE COLLAPSES TO ONE MESSAGE. Expired, revoked, never valid, belongs
 * to a user who was suspended, names a membership that was removed — telling
 * them apart would tell somebody holding a stolen token whether it was ever
 * real, and which of those things to try next.
 */
export function unauthenticated(
  options: AppErrorOptions = { message: 'Sign in to continue.', code: 'unauthenticated.no_session' },
): AppError {
  return new AppError('unauthenticated', options);
}

/**
 * Silo will not answer this.
 *
 * IT MUST SAY WHY, AND THE WHY MUST BE ACTIONABLE. "A source was unavailable, so
 * the total would be incomplete" tells the reader what happened and that
 * retrying is reasonable. "Could not answer" is the failure the product exists
 * to avoid — a refusal without a reason is indistinguishable from being broken.
 */
export function refusal(options: AppErrorOptions): AppError {
  return new AppError('refusal', options);
}

export function upstream(options: AppErrorOptions): AppError {
  return new AppError('upstream', options);
}

export function bounds(options: AppErrorOptions): AppError {
  return new AppError('bounds', options);
}

export function invalid(options: AppErrorOptions): AppError {
  return new AppError('invalid', options);
}

export function policy(options: AppErrorOptions): AppError {
  return new AppError('policy', options);
}

/**
 * Not found.
 *
 * ALSO WHAT A HIDDEN RESOURCE RETURNS, AND THAT IS DELIBERATE. Under row level
 * security a row another tenant owns is not visible, so "denied" and "does not
 * exist" are the same observation — and answering 403 for one and 404 for the
 * other turns the error code into an existence oracle. Ask for another tenant's
 * organisation by id and the honest answer is that there is no such thing here.
 *
 * This is the one place the taxonomy deliberately loses information.
 */
export function notFound(options: AppErrorOptions): AppError {
  return new AppError('missing', options);
}

/**
 * Too many, too fast.
 *
 * THE MESSAGE SHOULD SAY WHEN, and the caller should set `Retry-After` to match.
 * "Too many requests" with no interval leaves a client to invent a backoff, and
 * the one it invents is usually an immediate retry loop.
 */
export function limited(options: AppErrorOptions): AppError {
  return new AppError('limited', options);
}

/**
 * Your data lives somewhere else.
 *
 * THE MESSAGE MUST NAME WHERE, when we know. "Your account is in another region"
 * with no address leaves somebody stuck at a sign-in form that will never work,
 * and the `detail` a client needs to redirect is published in `fields` rather
 * than `detail` because it is for the caller, not the log.
 */
export function otherCell(options: AppErrorOptions): AppError {
  return new AppError('other-cell', options);
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * What a caller is told.
 *
 * `detail` IS NOT INCLUDED. It is for the log. An unexpected error's message is
 * replaced wholesale, because an internal message is a stack trace, a connection
 * string or a SQL fragment often enough that it cannot be trusted per-case.
 */
export function toResponse(error: unknown): {
  status: number;
  body: {
    error: {
      kind: ErrorKind;
      code: string;
      message: string;
      retryable: boolean;
      fields?: Record<string, string>;
    };
  };
} {
  if (isAppError(error)) {
    return {
      status: error.status,
      body: {
        error: {
          kind: error.kind,
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          // Omitted rather than sent empty, so a client can branch on presence.
          ...(Object.keys(error.fields).length > 0 ? { fields: error.fields } : {}),
        },
      },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        kind: 'internal',
        code: 'internal.unexpected',
        message: 'Something went wrong. It has been logged.',
        retryable: true,
      },
    },
  };
}

/**
 * A Postgres error, translated into the taxonomy.
 *
 * THE DATABASE ENFORCES RULES THAT NO APPLICATION CODE RESTATES — a check
 * constraint, a unique index, a trigger that refuses a cycle. When one of them
 * fires, the operation failed for a reason the caller could act on, and letting
 * the raw driver error through turns every one of those into a 500. "Something
 * went wrong" is a lie about a request that was refused for a knowable reason,
 * and it sends the reader to look for an outage that is not there.
 *
 * `P0001` MESSAGES ARE SHOWN AND EVERY OTHER MESSAGE IS NOT. A `RAISE EXCEPTION`
 * in a migration is a sentence somebody here wrote for a reader — "A scope cannot
 * be moved beneath its own descendant" — and it is the best available
 * explanation. A unique-violation message is built by Postgres out of the
 * conflicting values: `Key (email)=(someone@example.com) already exists` handed
 * back to an anonymous caller is an account-enumeration oracle. So the first is
 * passed through and the rest are replaced, with the constraint name kept in
 * `detail` for the log.
 */
interface DatabaseError {
  code?: string;
  message?: string;
  constraint?: string;
  table?: string;
  detail?: string;
}

function asDatabaseError(error: unknown): DatabaseError | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as DatabaseError;
  // Postgres codes are five characters. Checking the shape rather than
  // `instanceof DatabaseError` keeps this free of a dependency on pg's classes,
  // which the driver does not export consistently.
  return typeof candidate.code === 'string' && candidate.code.length === 5 ? candidate : null;
}

export function fromDatabaseError(error: unknown): unknown {
  if (isAppError(error)) return error;

  const db = asDatabaseError(error);
  if (!db) return error;

  const detail = { constraint: db.constraint, table: db.table, sqlState: db.code };

  switch (db.code) {
    // A rule written in a trigger. The message is ours; show it.
    case 'P0001':
      return policy({
        message: db.message ?? 'That is not allowed.',
        code: 'policy.database_rule',
        detail,
        cause: error,
      });

    case '23505':
      return policy({
        message: 'That already exists.',
        code: 'policy.duplicate',
        detail,
        cause: error,
      });

    case '23503':
      return invalid({
        message: 'That refers to something that does not exist.',
        code: 'invalid.reference',
        detail,
        cause: error,
      });

    case '23514':
    case '23502':
    case '22001':
      return invalid({
        message: 'A value in the request is not acceptable.',
        code: 'invalid.constraint',
        detail,
        cause: error,
      });

    /*
     * A ROW LEVEL SECURITY REFUSAL LOOKS LIKE THIS ON A WRITE. On a read the
     * policy simply returns nothing, which the caller reports as `notFound` —
     * the deliberate ambiguity described above. On a write there is no way to
     * return nothing, so it surfaces here and is a denial.
     */
    case '42501':
      return denial({
        message: 'You are not allowed to do that.',
        code: 'denial.row_policy',
        detail,
        cause: error,
      });

    // Concurrency. Genuinely worth trying again, and only these.
    case '40001':
    case '40P01':
      return upstream({
        message: 'That collided with another change. Try again.',
        code: 'upstream.contention',
        detail,
        cause: error,
      });

    case '57014':
      return bounds({
        message: 'That took too long and was stopped. Narrow it and try again.',
        code: 'bounds.timeout',
        detail,
        cause: error,
      });

    default:
      return error;
  }
}
