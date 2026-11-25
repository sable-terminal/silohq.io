import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { env, isProd } from '../config/env.config';
import { logger } from '../config/logger.config';
import { fromDatabaseError } from '../utils/error.util';
import {
  currentTenant,
  requireTenant,
  untenantedReason,
  type TenantContext,
} from '../utils/tenantContext.util';

/**
 * The product database.
 *
 * THE POOL IS NOT EXPORTED. Every statement goes through `query` or
 * `withTransaction`, both of which refuse to run without a tenant context. An
 * exported pool is an unguarded door beside a locked one — and the code that
 * would use it is exactly the code written in a hurry.
 *
 * THE TENANT RULE LIVES IN `utils/tenantContext.util.ts`, NOT HERE. This file
 * obeys it. That direction matters: the rule applies to the cache and the object
 * store too, and a rule that lives inside the database wrapper is a rule the
 * next wrapper's author has no reason to know about.
 *
 * THE POOL CONNECTS AS `silo_app`, WHICH CANNOT BYPASS ROW LEVEL SECURITY. That
 * is the third layer. The context is set, the wrapper refuses without it, and
 * Postgres refuses anything that gets past both. Each assumes the others fail.
 */

const pool: Pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: isProd ? 20 : 6,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
});

pool.on('error', (error) => {
  logger.error({ err: error }, 'Idle database client errored');
});

export interface Executor {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

/**
 * Apply the tenant context to a connection for the length of a transaction.
 *
 * `SET LOCAL`, NEVER `SET`, AND THIS IS THE MOST IMPORTANT LINE IN THE FILE.
 * `SET` binds the value to the CONNECTION, and connections are pooled across
 * requests belonging to different customers. One `SET` and the next request on
 * that connection inherits somebody else's tenant id — reading their data, under
 * their policies, with nothing in the logs to say so. `SET LOCAL` is scoped to
 * the transaction and discarded at COMMIT or ROLLBACK, so the worst case is a
 * connection with no context, which reads nothing.
 *
 * `set_config` RATHER THAN THE `SET LOCAL` STATEMENT, because `SET LOCAL` takes
 * no bind parameters and the value comes from a request. The third argument is
 * `is_local` — passing false there silently turns this back into `SET`, which is
 * the same bug wearing a different hat.
 */
async function applyContext(client: PoolClient, context: TenantContext): Promise<void> {
  await client.query('SELECT set_config($1, $2, true)', ['app.org_id', context.organisationId]);
  await client.query('SELECT set_config($1, $2, true)', [
    'app.membership_id',
    context.membershipId ?? '',
  ]);
  await client.query('SELECT set_config($1, $2, true)', ['app.user_id', context.userId ?? '']);
}

/**
 * One statement, inside its own transaction, with the tenant context applied.
 *
 * A SINGLE STATEMENT STILL GETS A TRANSACTION, which looks wasteful and is not.
 * `SET LOCAL` only exists inside one: outside a transaction it either errors or
 * silently does nothing depending on the driver, so a "cheap" unwrapped query is
 * a query with no tenant context — which returns an empty set that reads like a
 * missing record.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: readonly unknown[],
): Promise<QueryResult<T>> {
  const context = requireTenant('query');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyContext(client, context);
    const result = await client.query<T>(text, values as unknown[]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw fromDatabaseError(error);
  } finally {
    client.release();
  }
}

/** Several statements, one transaction, one tenant context. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const context = requireTenant('withTransaction');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyContext(client, context);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw fromDatabaseError(error);
  } finally {
    client.release();
  }
}

/**
 * A transaction for work that has declared itself untenanted.
 *
 * IT STILL REFUSES ANYTHING THAT DID NOT DECLARE. Being outside a tenant is not
 * the same as not having thought about it, and this only serves the first. Login
 * looking a user up by email is legitimate; a repository that forgot to wrap
 * itself is not, and both would otherwise arrive here identically.
 *
 * Tables under row level security return nothing in here, which is the intended
 * floor. The declaration is what makes the omission auditable.
 */
export async function withoutTenant<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const reason = untenantedReason();
  if (!reason) {
    throw new Error(
      'withoutTenant() outside runUntenanted(). Untenanted work must declare a reason, ' +
        'so that "what runs without a tenant" has a countable answer.',
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw fromDatabaseError(error);
  } finally {
    client.release();
  }
}

/**
 * Whether a tenant context is currently established. For assertions and health
 * reporting; not a substitute for the wrapper refusing.
 */
/**
 * Act as a particular user for the rest of this transaction.
 *
 * THE IDENTITY-PLANE POLICIES ARE KEYED ON `app_user_id()`, and three paths
 * discover the user rather than being told it: signing in resolves an address,
 * resolving a session resolves a token, consuming a reset resolves a link. Each
 * of those goes through a `SECURITY DEFINER` function that ignores the policy —
 * and everything they do *afterwards* is an ordinary write that the policy must
 * govern. This is the line between the two.
 *
 * `SET LOCAL`, VIA `set_config(..., true)`. A plain `SET` would outlive the
 * transaction on a pooled connection and hand the next request this user's
 * identity, which is the worst possible way to leak one.
 *
 * CALLING THIS IS NOT A PRIVILEGE. It sets which single user's rows are
 * reachable; it cannot widen anything, and setting it to somebody else's id
 * grants no access to anything the caller did not already have to know the id
 * of. What it prevents is a write silently touching zero rows.
 */
export async function actAsUser(db: PoolClient, userId: string): Promise<void> {
  await db.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
}

export function hasTenant(): boolean {
  return currentTenant() !== undefined;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
