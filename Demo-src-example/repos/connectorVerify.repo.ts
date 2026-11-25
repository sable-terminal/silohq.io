import type { Executor } from '../infra/db.infra';
import type { Manifest } from '../schemas/manifest.schema';
import type { ConnectionTrustState, TrustTier } from '../models/connectorLifecycle.model';
import { generateId } from '../utils/tokens.util';

/**
 * The two tables a connector's life MOVES after it has been drafted: the
 * lineage in `connector_manifests`, and the lifecycle columns of `connections`
 * that §7's verification and §8's healing switch.
 *
 * WHY NOT `connector.repo`. That file LOADS a connection to execute against —
 * one `SELECT` and one parse, shared by every query in the product. Verifying,
 * promoting, halting and re-pointing a connection are writes nothing on the
 * query path performs, and keeping them out of the load path is what stops the
 * hot statement growing columns it does not need.
 *
 * NOTHING HERE DECIDES. Whether a tier may be promoted, whether a confirmation
 * is allowed on a halted connection and whether a failed undo leaves writes off
 * are all `connectorVerify.service`'s questions — this file only writes what it
 * was told. 014's trigger and `tier_rank` are the backstop under both.
 */

/* ── The connection's lifecycle state ───────────────────────────────────── */

/** What promotion has to look at. Null when there is no such connection. */
export async function trustState(
  db: Executor,
  connectionId: string,
): Promise<ConnectionTrustState | null> {
  const { rows } = await db.query<{
    trust_tier: string;
    writes_enabled: boolean;
    status: string;
  }>(`SELECT trust_tier, writes_enabled, status FROM connections WHERE id = $1`, [connectionId]);

  const row = rows[0];
  if (!row) return null;

  return { trustTier: row.trust_tier, writesEnabled: row.writes_enabled, status: row.status };
}

/** Move the tier. 014's trigger refuses a jump; the service refuses it by name first. */
export async function setTrustTier(
  db: Executor,
  connectionId: string,
  tier: TrustTier,
): Promise<void> {
  await db.query(`UPDATE connections SET trust_tier = $2 WHERE id = $1`, [connectionId, tier]);
}

/**
 * Somebody confirmed the objects and mappings: the connection goes into service.
 *
 * `status <> 'revoked'` IS IN THE WHERE BECAUSE THE WRITE WOULD OTHERWISE BE
 * WRONG, not because a caller should not see the row. Reviving a revoked
 * connection by confirming its mappings would put a withdrawn system back on
 * the query path without anybody deciding to.
 */
export async function activate(db: Executor, connectionId: string): Promise<void> {
  await db.query(
    `UPDATE connections SET status = 'active', last_healthy_at = now()
      WHERE id = $1 AND status <> 'revoked'`,
    [connectionId],
  );
}

/** §7.4 — the write, verify and undo cycle passed. */
export async function enableWrites(
  db: Executor,
  input: { connectionId: string; by: string | null },
): Promise<void> {
  await db.query(
    `UPDATE connections
        SET writes_enabled = true, writes_enabled_at = now(), writes_enabled_by = $2
      WHERE id = $1`,
    [input.connectionId, input.by],
  );
}

/** A re-check found nothing wrong. */
export async function markHealthy(db: Executor, connectionId: string): Promise<void> {
  await db.query(`UPDATE connections SET last_healthy_at = now() WHERE id = $1`, [connectionId]);
}

/**
 * Stop answering, and say why.
 *
 * THE REASON IS NOT OPTIONAL — 014's `connections_halt_explained` refuses a
 * halt without one, because a halt that does not say why is indistinguishable
 * from an outage and somebody re-enables it without fixing anything.
 */
export async function halt(db: Executor, connectionId: string, reason: string): Promise<void> {
  await db.query(`UPDATE connections SET status = 'halted', halted_reason = $2 WHERE id = $1`, [
    connectionId,
    reason,
  ]);
}

/** Point a connection at a newer manifest version. */
export async function pointAtManifest(
  db: Executor,
  connectionId: string,
  manifestId: string,
): Promise<void> {
  await db.query(`UPDATE connections SET manifest_id = $2 WHERE id = $1`, [
    connectionId,
    manifestId,
  ]);
}

/** Which manifest a connection is currently on. */
export async function manifestIdOf(db: Executor, connectionId: string): Promise<string | null> {
  const { rows } = await db.query<{ manifest_id: string }>(
    `SELECT manifest_id FROM connections WHERE id = $1`,
    [connectionId],
  );

  return rows[0]?.manifest_id ?? null;
}

/* ── Manifest versions ──────────────────────────────────────────────────── */

/**
 * The connector a manifest is a version of.
 *
 * THE KEY ONLY, AND THE NEXT VERSION DELIBERATELY NOT WITH IT. This used to
 * return both, counting `MAX(version)` in the manifest's OWN organisation — and
 * a prebuilt manifest's `organisation_id` is null, so `m2.organisation_id =
 * m.organisation_id` was `NULL = NULL`, matched nothing, and answered 1 forever
 * while the caller wrote the row into the actor's tenant instead. Ten
 * connections on one prebuilt connector meant one successful heal and nine
 * duplicate-key failures on 013's `manifests_tenant_version`.
 *
 * Counting belongs to `nextVersion`, which is told which organisation it is
 * counting in, and which the caller may only trust while `lockLineage` is held.
 */
export async function connectorKeyOf(
  db: Executor,
  manifestId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ connector_key: string }>(
    `SELECT connector_key FROM connector_manifests WHERE id = $1`,
    [manifestId],
  );

  return rows[0]?.connector_key ?? null;
}

/**
 * Hold the lineage for the rest of the transaction.
 *
 * SERIALISED ON THE CONNECTOR, NOT ON THE ROWS. Two publishes racing would
 * otherwise both read the same highest version, both compute the same next one,
 * and one would fail on 013's unique index — a confusing error for a person who
 * pressed a button twice, when the honest outcome is version 4 followed by 5.
 *
 * A LOCK RATHER THAN `FOR UPDATE`, because there is nothing to lock: the rows
 * being counted are the ones that already exist, and the row that conflicts is
 * the one neither transaction has written yet. (Postgres also refuses `FOR
 * UPDATE` beside an aggregate outright.)
 */
export async function lockLineage(db: Executor, key: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
}

/** The next version number for a connector within one organisation. */
export async function nextVersion(
  db: Executor,
  input: { organisationId: string; connectorKey: string },
): Promise<number> {
  const { rows } = await db.query<{ next: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next
       FROM connector_manifests
      WHERE organisation_id = $1 AND connector_key = $2`,
    [input.organisationId, input.connectorKey],
  );

  return rows[0]?.next ?? 1;
}

/**
 * Write a new version. Returns its id.
 *
 * A NEW ROW, NEVER AN EDIT, and 013's trigger enforces that once a connection
 * points at the old one: answers cite the version that produced them, so a
 * repair that rewrote the document in place would make every past answer
 * unreconcilable with the connector that supposedly produced it.
 */
export async function insertVersion(
  db: Executor,
  input: {
    organisationId: string;
    connectorKey: string;
    version: number;
    /** A v2 manifest, or a v1 document kept as it was published — compiled on every load. */
    document: unknown;
    schemaVersion: number;
    sourceRoute: 'prebuilt' | 'ai' | 'visual';
    createdBy: string | null;
  },
): Promise<string> {
  const id = generateId();

  await db.query(
    `INSERT INTO connector_manifests
       (id, organisation_id, connector_key, version, document, schema_version,
        source_route, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.organisationId,
      input.connectorKey,
      input.version,
      JSON.stringify(input.document),
      input.schemaVersion,
      input.sourceRoute,
      input.createdBy,
    ],
  );

  return id;
}

/** Record that a newer version exists. 013 permits this; editing the document does not. */
export async function supersede(
  db: Executor,
  input: { manifestId: string; byManifestId: string },
): Promise<boolean> {
  /*
   * IT REPORTS WHETHER IT DID ANYTHING, because for a prebuilt manifest it does
   * not. Those rows belong to Silo and carry a SELECT-only policy, so a
   * customer forking one updates nothing — correctly, since a tenant must not
   * stamp a global row. The caller needs to be able to tell "marked" from
   * "silently declined", and a void return made the two identical.
   */
  const { rowCount } = await db.query(
    `UPDATE connector_manifests SET superseded_at = now(), superseded_by = $2 WHERE id = $1`,
    [input.manifestId, input.byManifestId],
  );
  return Boolean(rowCount);
}
