import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { denial, invalid, notFound, refusal } from '../utils/error.util';
import * as connectorRepo from '../repos/connector.repo';
import { fanout, assertComplete, type FanoutOutcome } from '../engine/execution/fanout.execution';
import type { Comparison, Query } from '../engine/execution/query.execution';
import { restrictQuery, stripRows } from '../engine/execution/restrict.execution';
import { executeRead } from '../engine/read/execute.read';
import { capabilitiesOf } from '../engine/read/capabilities.read';
import { foreignKeysOf } from '../engine/transports/sql/catalogue.sql';
import { runWrite, type Mutation, type MutationResult } from '../engine/write/run.write';
import { withConnection } from './connectorRuntime.service';
import { hiddenFields } from './fieldPolicy.service';
import type { CatalogueKey } from '../engine/mutation/blast.mutation';
import type { Actor } from './scope.service';


/**
 * Asking connected systems a question.
 *
 * ── The whole shape, in one place ───────────────────────────────────────────
 *
 *   load        manifests out of the database, one query for all of them
 *   authorise   which of them this caller may actually reach
 *   open        each credential through the mediator, as late as possible
 *   fan out     every source at once
 *
 * NOTHING HERE NAMES A PROVIDER. The manifests are rows; the engine reads them.
 * Adding Salesforce is inserting a document.
 */

export interface AskInput {
  actor: Actor;
  /** Empty means every active connection the caller may reach. */
  connectionIds?: string[];
  query: Query;
}

/**
 * ── THE ENFORCEMENT POINT THAT IS NOT HERE YET ──────────────────────────────
 *
 * A COMPILE STAGE BELONGS IMMEDIATELY BEFORE THIS, and it is the thing that
 * makes a shared service credential safe. The organisation registers a source
 * once with a service account, users never see a credential, and Silo's own
 * permission model is the only reason a junior user does not read salary fields
 * through a credential that can reach them. Field policies ARE that model.
 *
 * IT MUST RUN BEFORE THE MANIFEST IS BUILT. `planPushdown` is already too late:
 * by then the field is in the plan. Post-filtering the rows is the failure mode
 * — it looks identical to whoever asked, and it means the denied value crossed
 * the network into this process, which for a defence customer is a different
 * security posture entirely. The claim is that a field somebody may not see
 * never reaches the query.
 *
 * WHERE THE PIECES LIVE: auth owns the policy — the `field_policies` table and
 * the resolver answering "which fields may this membership see on this
 * connection", beside markings and clearances. The compiler owns the
 * enforcement. Connectors own neither: a manifest says what fields exist and
 * never who may see them, so a connector is identical in a permissive
 * organisation and a locked-down one.
 *
 * `markingCheck.util` and `effectivePermissions.util` already exist and nothing
 * on this path calls them, because there is no compiler to call them from. That
 * is a dependency waiting, not a bug — but until it lands, a shared credential
 * with broad rights is exactly the hole it looks like.
 */
export async function ask(input: AskInput): Promise<FanoutOutcome> {
  return runWithTenant(
    { organisationId: input.actor.organisationId, membershipId: input.actor.membershipId },
    async () => {
      /*
       * LOADED AND AUTHORISED INSIDE ONE TRANSACTION, then released before the
       * fan-out. Holding a database connection open across six network calls to
       * third parties is how a pool of ten runs out under four concurrent
       * questions.
       */
      const { connections, credentials, hiddenByConnection } = await withTransaction(async (db) => {
        const loaded = input.connectionIds?.length
          ? await connectorRepo.load(db, input.connectionIds)
          : await connectorRepo.loadActive(db);

        /*
         * WHETHER THE CALLER NAMED THEM CHANGES WHAT A MISSING GRANT MEANS.
         * Named and refused is a denial; asked implicitly and filtered out is
         * simply not one of your sources.
         */
        const reachable = await authorised(db, input.actor, loaded, {
          named: Boolean(input.connectionIds?.length),
        });

        return {
          connections: reachable,
          credentials: await connectorRepo.credentialsFor(
            db,
            reachable.map((c) => c.connectionId),
          ),
          hiddenByConnection: await hiddenFields(
            db,
            input.actor,
            reachable.map((c) => c.connectionId),
          ),
        };
      });

      if (connections.length === 0) {
        throw refusal({
          message: 'No connected system can answer that. Nothing is connected, or none is granted to you.',
          code: 'refusal.no_sources',
        });
      }

      /*
       * A HALTED CONNECTION IS EXCLUDED LOUDLY, NOT SILENTLY. §8 halts on a
       * field that changed meaning or an object that vanished, precisely because
       * continuing would answer wrongly — so quietly leaving it out of a
       * multi-source total reintroduces the error the halt existed to prevent.
       */
      const halted = connections.filter((c) => c.status === 'halted');
      if (halted.length > 0) {
        throw refusal({
          message:
            `${halted.map((c) => c.name).join(', ')} ${halted.length === 1 ? 'is' : 'are'} halted ` +
            `because the source changed in a way that needs review. Answering without ${halted.length === 1 ? 'it' : 'them'} would be incomplete.`,
          code: 'refusal.connection_halted',
          detail: { halted: halted.map((c) => c.name) },
        });
      }

      /*
       * FIELD POLICY, BEFORE ANY QUERY IS SENT. A field hidden from this reader
       * is not asked for, and a query that filters or sorts on one is refused as
       * naming a field that does not exist — because to them it does not. Decided
       * here, ahead of the fan-out, so it is refused as that and not reported as
       * a source that failed. What a source that cannot select fields sends anyway
       * is removed from every row before it leaves the fan-out.
       */
      const queries = new Map<string, Query>();
      for (const connection of connections) {
        const hidden = hiddenByConnection.get(connection.connectionId);
        const object = connection.manifest.objects.find((one) => one.name === input.query.object);
        if (!hidden || hidden.size === 0 || !object) continue;

        const restricted = restrictQuery(object, input.query, hidden);
        if (!restricted.ok) {
          throw invalid({
            message: `${connection.name} has no field called ${restricted.field}.`,
            code: 'invalid.unknown_field',
          });
        }
        queries.set(connection.connectionId, restricted.query);
      }

      return fanout(
        connections.map((connection) => ({
          connectionId: connection.connectionId,
          name: connection.name,
          /*
           * THE CREDENTIAL IS OPENED INSIDE THE CALLBACK, per source, and the
           * plaintext never leaves it. `withSecret` hands the value to a
           * function rather than returning it — so the secret's lifetime is one
           * query, and it is not sitting in a variable this file owns while five
           * other sources are still in flight.
           */
          run: async () => {
            const hidden = hiddenByConnection.get(connection.connectionId) ?? new Set<string>();
            const query = queries.get(connection.connectionId) ?? input.query;

            /*
             * THE CREDENTIAL IS OPENED INSIDE THE RUNTIME'S CALLBACK, per source,
             * and the plaintext never leaves it — OAuth through its refresh, every
             * other secret through the mediator, a local store with none at all.
             */
            const result = await withConnection({
              actor: input.actor,
              connection,
              credential: credentials.get(connection.connectionId),
              use: async (open) => executeRead(await open(query.object), query),
            });

            return hidden.size > 0 ? { ...result, rows: stripRows(result.rows, hidden) } : result;
          },
        })),
      );
    },
  );
}

/**
 * Ask, and refuse anything short of a complete answer.
 *
 * THE DEFAULT FOR ANYTHING THAT PRODUCES A FIGURE. A total computed from five of
 * six systems is not a smaller total, it is a wrong one, and it looks exactly
 * like a right one. `ask` returns both halves for a caller that genuinely wants
 * to show which sources are down; this is what everything else should use.
 */
export async function askComplete(input: AskInput) {
  return assertComplete(await ask(input));
}

/**
 * Write records to a connected system, through a gate checked once.
 *
 * ── The governed path is the only caller ───────────────────────────────────
 *
 * Mutations §1: reading and writing run through one governed path. This used to
 * sit behind `POST /connections/:id/records`, which wrote on request with no
 * prior state, no approval and no audit of the write. Execution calls it now,
 * for a change that has been previewed and approved, and nothing else does.
 *
 * ── The gates, again, at the moment of writing ─────────────────────────────
 *
 * The connection has to be reachable by the person the change is written for,
 * the grant has to say they may write and not merely read, the connection must
 * not be halted, and `writes_enabled` has to have been earned by a verification
 * cycle rather than assumed. A change approved yesterday is written under the
 * grants that hold today.
 *
 * ── One credential for a batch ─────────────────────────────────────────────
 *
 * `use` is handed a `write` for each record. The credential is opened once for
 * the batch rather than per record — a thousand unwraps is a thousand calls to
 * the key service — and the caller keeps batches short so it is not held open
 * for the length of a large change. OAuth goes through the refresh, as reads do.
 */
export async function writeBatch<T>(input: {
  actor: Actor;
  connectionId: string;
  use: (write: (mutation: Mutation) => Promise<MutationResult>) => Promise<T>;
}): Promise<T> {
  const { actor, connectionId } = input;

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    async () => {
      const { connection, credential } = await withTransaction(async (db) => {
        const loaded = await connectorRepo.load(db, [connectionId]);
        const [found] = await authorised(db, actor, loaded, { named: true });

        if (!found) {
          throw notFound({ message: 'That connection does not exist.', code: 'missing.connection' });
        }

        const writable = await connectorRepo.isWritableBy(db, {
          connectionId,
          membershipId: actor.membershipId,
        });

        if (!writable) {
          throw denial({
            message: `You can read ${found.name} but not change it.`,
            code: 'denial.no_write_grant',
          });
        }

        if (found.status === 'halted') {
          throw refusal({
            message: `${found.name} is halted and cannot be changed until somebody looks at it.`,
            code: 'refusal.connection_halted',
          });
        }

        if (!found.writesEnabled) {
          throw refusal({
            message:
              `Writes are not enabled for ${found.name}. Verify the connector against a test ` +
              `record first.`,
            code: 'refusal.writes_disabled',
          });
        }

        const credentials = await connectorRepo.credentialsFor(db, [connectionId]);
        const stored = credentials.get(connectionId);
        if (!stored) {
          throw refusal({
            message: `${found.name} has no credential.`,
            code: 'refusal.no_credential',
          });
        }

        return { connection: found, credential: stored };
      });

      return withConnection({
        actor,
        connection,
        credential,
        use: (open) => input.use(async (mutation: Mutation) => runWrite(await open(mutation.object), mutation)),
      });
    },
  );
}

/**
 * Mutations §7 — a SQL source's foreign keys, with the rules its catalogue states.
 *
 * READ WITH THE CONNECTION'S OWN CREDENTIAL, UNDER THE SAME GATE AS A QUERY. The
 * catalogue is part of the customer's system, and somebody who cannot reach the
 * connection learns nothing about its schema through a preview.
 *
 * NULL WHERE THERE IS NO CATALOGUE TO ASK — every transport but SQL, and SQL
 * dialects this pool does not speak. The preview then says it does not know
 * what the source does with dependents, which is true, rather than nothing.
 */
export async function catalogueKeys(actor: Actor, connectionId: string): Promise<CatalogueKey[] | null> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    async () => {
      const found = await withTransaction(async (db) => {
        const loaded = await connectorRepo.load(db, [connectionId]);
        const [connection] = await authorised(db, actor, loaded, { named: true });
        if (!connection || connection.manifest.transport.kind !== 'sql') return null;

        const credentials = await connectorRepo.credentialsFor(db, [connectionId]);
        const credential = credentials.get(connectionId);
        return credential ? { connection, credential } : null;
      });

      if (!found) return null;
      const first = found.connection.manifest.objects[0];
      if (!first) return null;

      return withConnection({
        actor,
        connection: found.connection,
        credential: found.credential,
        use: async (open) => foreignKeysOf(await open(first.name)),
      });
    },
  );
}

/**
 * What can be asked, and of what.
 *
 * THE OBJECTS AND THE PUSHDOWN, NOT THE WHOLE MANIFEST. Somebody about to ask a
 * question needs to know which objects exist and which filters the source can
 * apply itself; the endpoints, the auth block and the pagination strategy are
 * the builder's business and are a description of the customer's estate besides.
 */
export async function queryableConnections(actor: Actor) {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    async () =>
      withTransaction(async (db) => {
        const loaded = await connectorRepo.loadActive(db);
        const reachable = await authorised(db, actor, loaded, { named: false });
        const hidden = await hiddenFields(db, actor, reachable.map((one) => one.connectionId));

        return reachable.map((connection) => ({
          connectionId: connection.connectionId,
          name: connection.name,
          provider: connection.provider,
          objects: connection.manifest.objects
            /*
             * §5: PARTIAL SUCCESS IS SUCCESS. An object discovery found but
             * mapping could not place is listed nowhere, because offering it and
             * refusing it is worse than not offering it.
             */
            .filter((object) => object.available)
            .map((object) => ({
              name: object.name,
              identifier: object.identifier,
              /* A field hidden from this reader is not in what they can ask about. */
              fields: object.fields
                .filter((field) => !hidden.get(connection.connectionId)?.has(field.name))
                .map((field) => ({ name: field.name, type: field.type })),
            })),
          pushdown: pushdownSummary(connection),
        }));
      }),
  );
}

/**
 * What a connection's source can do for a question, summed over its objects —
 * the shape the query builder reads. Each object's own is `capabilitiesOf`.
 */
function pushdownSummary(connection: connectorRepo.LoadedConnection) {
  const all = connection.manifest.objects.filter((o) => o.available).map((o) => capabilitiesOf(connection.manifest, o.name));
  return {
    filters: [...new Set(all.flatMap((c) => c.filters))] as Comparison[],
    sort: all.some((c) => c.sort),
    fieldSelection: all.some((c) => c.fieldSelection),
  };
}

/**
 * Which of these the caller may actually reach.
 *
 * DEFAULT DENY. §10: `connection_grants` — absence of a row is denial, so a
 * connection nobody has been granted is reachable by nobody, and a forgotten
 * grant is a person who cannot query rather than a system everybody can read.
 *
 * A SCOPE GRANT REACHES DESCENDANTS ONLY WHEN IT SAYS SO. The subtree test is
 * the same ltree containment every other grant uses, so a connection granted at
 * Engineering behaves the way a role granted at Engineering does.
 */
/**
 * One connection, loaded and grant-checked, for a caller that names it directly.
 *
 * THE BUILDER'S TEST PANEL GOES THROUGH THE SAME GATE AS A QUERY. Probing runs a
 * real request against a real system with a real credential and shows somebody
 * the rows that come back — so letting `connection.create` reach a connection
 * that `connection_grants` does not would make the builder a way around the
 * grant rather than a thing built on top of it.
 */
export async function readableConnection(
  actor: Actor,
  connectionId: string,
): Promise<connectorRepo.LoadedConnection> {
  return withTransaction(async (db) => {
    const loaded = await connectorRepo.load(db, [connectionId]);
    const [connection] = await authorised(db, actor, loaded, { named: true });

    if (!connection) {
      throw notFound({ message: 'That connection does not exist.', code: 'missing.connection' });
    }
    return connection;
  });
}

/**
 * Of these connections, the ones this actor may read.
 *
 * ONE COPY OF THE GRANT RULE, AND IT IS IN `connector.repo` NOW. Querying, the
 * builder's test panel, the connection list and the map layer all have to agree
 * about who can reach what; this stays as the one name they all call, because
 * turning an actor into the membership the predicate is keyed on — and a row set
 * into the `Set` every caller wants — is the service's half of the work.
 */
export async function readableIds(
  db: Parameters<Parameters<typeof withTransaction>[0]>[0],
  actor: Actor,
  connectionIds: string[],
): Promise<Set<string>> {
  return new Set(
    await connectorRepo.readableIds(db, { connectionIds, membershipId: actor.membershipId }),
  );
}

/**
 * One connection, loaded for somebody ADMINISTERING it rather than reading it.
 *
 * NO GRANT CHECK, DELIBERATELY, AND IT IS NOT A WEAKER VERSION OF
 * `readableConnection`. Managing who reaches a connection is a different act
 * from reading through it: an admin holding `connection.grant` should be able to
 * hand a finance system to the finance team without first giving themselves
 * access to finance data.
 *
 * IT ALSO CLOSES A TRAP. Requiring a read grant here means revoking the last
 * grant on a connection locks everybody out of managing it — including the
 * person who just revoked it, who now cannot grant it to anybody else. Row level
 * security still confines this to the caller's own organisation.
 */
export async function manageableConnection(
  actor: Actor,
  connectionId: string,
): Promise<connectorRepo.LoadedConnection> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    async () =>
      withTransaction(async (db) => {
        const [connection] = await connectorRepo.load(db, [connectionId]);

        if (!connection) {
          throw notFound({
            message: 'That connection does not exist.',
            code: 'missing.connection',
          });
        }
        return connection;
      }),
  );
}

async function authorised(
  db: Parameters<Parameters<typeof withTransaction>[0]>[0],
  actor: Actor,
  connections: connectorRepo.LoadedConnection[],
  options: { named: boolean },
): Promise<connectorRepo.LoadedConnection[]> {
  if (connections.length === 0) return [];

  const allowed = await readableIds(db, actor, connections.map((c) => c.connectionId));
  const reachable = connections.filter((c) => allowed.has(c.connectionId));

  /*
   * NAMING A SYSTEM YOU CANNOT REACH IS A DENIAL. Filtering it out silently
   * would tell somebody their question found nothing, when in fact they were
   * not allowed to ask it — and they would go looking for missing data rather
   * than asking for access.
   *
   * ASKING IMPLICITLY IS NOT. "Every system I can reach" is a question whose
   * answer legitimately excludes what you cannot; refusing there would make the
   * default query fail for anybody who is not an administrator.
   */
  if (options.named && reachable.length < connections.length) {
    const refused = connections.filter((c) => !allowed.has(c.connectionId));
    throw denial({
      message: `You do not have access to ${refused.map((c) => c.name).join(', ')}.`,
      code: 'denial.connection_not_granted',
      detail: { connectionIds: refused.map((c) => c.connectionId) },
    });
  }

  return reachable;
}
