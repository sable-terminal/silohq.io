import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who the current unit of work is acting as.
 *
 * THIS IS AN AUTHORISATION CONTROL, NOT INFRASTRUCTURE, and the placement is the
 * argument. It happens to be applied at the database boundary, which makes it
 * look like a database concern — and if it lives in `infra/` then "no query runs
 * without a tenant" becomes a property of the database wrapper rather than a
 * rule of the system. Whoever writes the second database wrapper, or the cache
 * client, or the object store, has no reason to think it applies to them. It
 * does. It is the single most likely source of a cross-tenant leak, so it lives
 * with the other security controls and the infrastructure obeys it.
 *
 * ASYNC LOCAL STORAGE, NOT A PARAMETER THREADED THROUGH EVERY CALL. Passing the
 * context explicitly is more obvious and strictly worse here: it can be
 * forgotten, and forgetting it compiles. A repository that reaches for the pool
 * directly, a helper called three layers down, a retry that runs on a different
 * tick — all of them get the context whether the author remembered it or not,
 * and `infra/db.infra.ts` refuses to run a statement when there isn't one.
 *
 * IT IS NOT THE ENFORCEMENT, IT IS THE FIRST OF THREE. The context is set here,
 * the wrapper refuses without it, and row level security in Postgres catches
 * anything that gets past both. Each layer assumes the others will fail.
 */

export interface TenantContext {
  /** The organisation every statement in this unit of work is scoped to. */
  organisationId: string;

  /**
   * The membership acting. Optional at exactly one moment: after a password is
   * verified and before an organisation is chosen, when the user has an identity
   * but no tenant yet.
   */
  membershipId?: string | null;

  /**
   * The authenticated user, before a membership is picked. Set during login so
   * `memberships_own` can answer "which organisations do I belong to".
   */
  userId?: string | null;
}

/**
 * A unit of work that deliberately has no tenant, and says why.
 *
 * The reason is a closed set rather than free text, so the audit question "what
 * runs without a tenant" has a countable answer that a reviewer can read in one
 * screen, instead of a grep for a function name.
 */
export type UntenantedReason =
  | 'login-lookup'
  | 'migration'
  | 'health-check'
  | 'directory-routing'
  /*
   * A SWEEP BELONGS TO NO ORGANISATION AND MUST REACH EVERY ONE. Row level
   * security is designed to prevent exactly that, so the reason is named here
   * rather than left to a caller passing whichever existing one looked closest.
   */
  | 'scheduled-job'
  /*
   * A SCIM REQUEST ARRIVES WITH A BEARER TOKEN AND NOTHING ELSE. The token is
   * what SAYS which organisation it belongs to, so the read that finds it
   * cannot already be inside one — the same shape as `login-lookup`, and named
   * separately so an audit can tell a provisioning read from a sign-in.
   */
  | 'scim-token-lookup';

interface Frame {
  kind: 'tenant';
  context: TenantContext;
}

interface UntenantedFrame {
  kind: 'untenanted';
  reason: UntenantedReason;
}

const storage = new AsyncLocalStorage<Frame | UntenantedFrame>();

/**
 * Run a block as a tenant. Everything inside it, however deep, sees this
 * context — including code that never asked for it.
 */
export function runWithTenant<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
  if (!context.organisationId) {
    // An empty string would set the session variable to '', which `app_org_id()`
    // maps to NULL, which matches no rows — a silent no-op wearing the costume
    // of a successful query.
    throw new Error('runWithTenant called without an organisationId');
  }
  return storage.run({ kind: 'tenant', context }, fn);
}

/**
 * Run a block with no tenant, declaring which of the permitted reasons applies.
 *
 * DELIBERATELY VERBOSE AT THE CALL SITE. This is the bypass, and a bypass should
 * be conspicuous in a diff. Anything using it is claiming it touches no
 * tenant-scoped table, and a reviewer should be able to check that claim by
 * reading one line.
 */
export function runUntenanted<T>(reason: UntenantedReason, fn: () => Promise<T>): Promise<T> {
  return storage.run({ kind: 'untenanted', reason }, fn);
}

/** The current context, or undefined outside any unit of work. */
export function currentTenant(): TenantContext | undefined {
  const frame = storage.getStore();
  return frame?.kind === 'tenant' ? frame.context : undefined;
}

/** Whether this unit of work declared itself untenanted, and why. */
export function untenantedReason(): UntenantedReason | undefined {
  const frame = storage.getStore();
  return frame?.kind === 'untenanted' ? frame.reason : undefined;
}

/**
 * The context, or a thrown error naming what went wrong.
 *
 * THROWS RATHER THAN RETURNING NULL, AND THAT IS THE POINT. A null would be
 * checked by careful callers and ignored by the rest, and the ones that ignore
 * it would then run a statement with no tenant — which row level security turns
 * into an empty result set. An empty result set reads as "no such record", so
 * the bug presents as missing data and gets investigated as a data problem. A
 * thrown error presents as what it is.
 */
export function requireTenant(operation: string): TenantContext {
  const frame = storage.getStore();

  if (frame?.kind === 'tenant') return frame.context;

  if (frame?.kind === 'untenanted') {
    throw new Error(
      `${operation} needs a tenant context, but this unit of work is explicitly ` +
        `untenanted (${frame.reason}). Untenanted work may not touch tenant-scoped tables.`,
    );
  }

  throw new Error(
    `${operation} ran with no tenant context. Wrap it in runWithTenant(), or in ` +
      `runUntenanted() with a reason if it genuinely has no tenant.`,
  );
}
