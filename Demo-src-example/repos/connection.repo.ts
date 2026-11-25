import type { Executor } from '../infra/db.infra';
import type { Sealed } from '../utils/envelope.util';
import { generateId } from '../utils/tokens.util';
import type {
  AvailableConnector,
  ConnectableManifest,
  ConnectionHalt,
  ConnectionOverview,
  ConnectionStatus,
  CredentialProvenance,
  CredentialRights,
  CredentialSharing,
  ManifestVersion,
  ProbeRun,
} from '../models/connection.model';

/**
 * Connections, their sealed credentials, and the manifest rows a connection is
 * read through.
 *
 * SQL AND THE ROW-TO-MODEL MAPPING. Nothing decides anything here: whether a
 * missing manifest is a 404, whether a halt may be cleared, and whether the
 * asker is allowed to see a connection at all are all judgements, and they live
 * in `services/connection.service.ts`.
 *
 * IT READS `connector_manifests` AND `probe_runs` AND OWNS NEITHER. Every
 * statement below that touches them is anchored to a connection — the manifest a
 * connection was made against, the lineage that manifest belongs to, the runs
 * recorded against the connection. The rows are somebody else's; the questions
 * are this domain's.
 *
 * THE `superseded_at IS NULL` AND `status <> 'revoked'` PREDICATES ARE NOT
 * PERMISSION CHECKS. A superseded manifest is not one somebody is being kept
 * away from — it is one no new connection may be made against, and a revoked
 * connection is one that no longer names a live system. Both queries would be
 * wrong rather than merely over-permissive without them. Which of the rows that
 * come back a given person may READ is decided by row level security and by the
 * service, never here.
 */

/* ── Connecting ─────────────────────────────────────────────────────────── */

interface ManifestRow {
  id: string;
  provider: string | null;
  sharing: string | null;
}

/**
 * `provider` AND `sharing` ARE SETTLED ONCE, HERE. Both are read out of a
 * `jsonb` document where the field may be absent, and a null handed on is a null
 * every caller has to decide the meaning of. The safe reading of a missing
 * `credentialSharing` is `shareable`, which is what the manifest schema's own
 * default says; the readable stand-in for a missing provider is `unknown`, which
 * is what the `connections.provider` NOT NULL column has to be given.
 */
function mapManifest(row: ManifestRow): ConnectableManifest {
  return {
    id: row.id,
    provider: row.provider ?? 'unknown',
    credentialSharing: (row.sharing === 'per_user' ? 'per_user' : 'shareable') as CredentialSharing,
  };
}

/**
 * The live manifest a new connection would be made against.
 *
 * READ THROUGH RLS. A manifest belonging to another tenant does not come back,
 * and a prebuilt one (`organisation_id` null) is visible to everybody by 013's
 * `FOR SELECT` policy — so both cases work without a branch here.
 */
export async function findConnectableManifest(
  db: Executor,
  manifestId: string,
): Promise<ConnectableManifest | null> {
  const { rows } = await db.query<ManifestRow>(
    `SELECT id,
            document->'identity'->>'provider' AS provider,
            document->>'credentialSharing' AS sharing
       FROM connector_manifests
      WHERE id = $1 AND superseded_at IS NULL`,
    [manifestId],
  );

  const row = rows[0];
  return row ? mapManifest(row) : null;
}

/**
 * Create a connection. Returns its id.
 *
 * `draft`, AND WRITES OFF, ARE NOT STATED. Both are the table's defaults and
 * both are enforced by triggers — naming them here would be a second copy that
 * could disagree. A connection becomes usable by being probed, not by being
 * made.
 *
 * THE DUPLICATE NAME IS LEFT TO ESCAPE AS `23505`. A repo that caught it would
 * turn "somebody already used this name" into a null the caller reads as
 * "nothing happened"; the service turns the constraint into the sentence.
 */
export async function insert(
  db: Executor,
  input: {
    organisationId: string;
    manifestId: string;
    name: string;
    provider: string;
    owningScopeId: string | null;
    createdBy: string;
  },
): Promise<string> {
  const connectionId = generateId();

  await db.query(
    `INSERT INTO connections
       (id, organisation_id, manifest_id, name, provider, owning_scope_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      connectionId,
      input.organisationId,
      input.manifestId,
      input.name,
      input.provider,
      input.owningScopeId,
      input.createdBy,
    ],
  );

  return connectionId;
}

/* ── Credentials ────────────────────────────────────────────────────────── */

/**
 * Drop the token credentials this connection holds for any OTHER strategy.
 *
 * THE UNIQUE INDEX DOES NOT SAY ONE TOKEN PER CONNECTION. It is per
 * `(connection, strategy, purpose)`, so switching a connection from `basic` to
 * `api_key_header` would leave both rows behind — and `connector.repo`'s reader,
 * which selects by purpose and keys on the connection, would silently use
 * whichever Postgres returned last. A manifest lists the strategies a system
 * ACCEPTS; a connection uses exactly one of them.
 */
export async function removeOtherTokenCredentials(
  db: Executor,
  input: { connectionId: string; strategy: string },
): Promise<void> {
  await db.query(
    `DELETE FROM connection_credentials
      WHERE connection_id = $1 AND purpose = 'token' AND auth_strategy <> $2`,
    [input.connectionId, input.strategy],
  );
}

/**
 * Store the sealed secret a connection authenticates with.
 *
 * IT TAKES THE SEALED FORM AND NEVER THE PLAINTEXT. Sealing needs the key
 * wrapper and belongs to the service; a repo that took a secret would be a
 * second place the cleartext exists, held in a variable owned by whoever called
 * it.
 *
 * THE UPSERT RESETS `refresh_failure_count`. Re-entering a credential is the act
 * that answers a run of refresh failures, and leaving the count where it was
 * would keep the engine refusing to use a credential that has just been fixed.
 */
export async function upsertTokenCredential(
  db: Executor,
  input: {
    connectionId: string;
    strategy: string;
    sealed: Sealed;
    lastFour: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO connection_credentials
       (id, connection_id, auth_strategy, purpose, sealed, wrapped_key, key_reference, last_four)
     VALUES ($1, $2, $3, 'token', $4, $5, $6, $7)
     ON CONFLICT (connection_id, auth_strategy, purpose)
     DO UPDATE SET sealed = EXCLUDED.sealed,
                   wrapped_key = EXCLUDED.wrapped_key,
                   key_reference = EXCLUDED.key_reference,
                   last_four = EXCLUDED.last_four,
                   refreshed_at = now(),
                   refresh_failure_count = 0`,
    [
      generateId(),
      input.connectionId,
      input.strategy,
      input.sealed.ciphertext,
      input.sealed.wrappedKey,
      input.sealed.keyReference,
      input.lastFour,
    ],
  );
}

/* ── Reading the record ─────────────────────────────────────────────────── */

interface OverviewRow {
  id: string;
  name: string;
  provider: string;
  status: ConnectionStatus;
  writes_enabled: boolean;
  halted_reason: string | null;
  last_healthy_at: Date | null;
  credential_acts_as: string | null;
  credential_rights: CredentialRights;
  last_four: string | null;
  notes: string | null;
  parameters: Record<string, string> | null;
  manifest_id: string;
  manifest_version: number | null;
  pinned_origins: string[] | null;
  credential_expires_at: Date | null;
  expiry_source: 'certificate' | 'token' | 'declared' | null;
  reach_scopes: string[] | null;
  /** `count(*)` is `bigint`, which arrives as a string. Coerced once, below. */
  reach_people: string;
  reach_principals: string;
}

function mapOverview(row: OverviewRow): ConnectionOverview {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    status: row.status,
    writesEnabled: row.writes_enabled,
    haltedReason: row.halted_reason,
    lastHealthyAt: row.last_healthy_at,
    credentialActsAs: row.credential_acts_as,
    credentialRights: row.credential_rights,
    credentialLastFour: row.last_four,
    notes: row.notes,
    parameters: row.parameters ?? {},
    manifestId: row.manifest_id,
    manifestVersion: row.manifest_version,
    pinnedOrigins: row.pinned_origins,
    credentialExpiresAt: row.credential_expires_at,
    credentialExpirySource: row.expiry_source,
    reach: {
      scopes: row.reach_scopes ?? [],
      people: Number(row.reach_people ?? 0),
      principals: Number(row.reach_principals ?? 0),
    },
  };
}

/**
 * Every connection in the tenant, with its credential hint and its reach.
 *
 * WHO CAN REACH IT, SUMMARISED IN THE LIST. "Which of these is open to the whole
 * of Engineering" is a question asked of the SET of connections, and answering
 * it one connection at a time means opening every row to find out. The lateral
 * costs one pass over a small table per connection and saves that entirely.
 *
 * LIVE GRANTS ONLY IN THE REACH. A revoked or expired grant is somebody who USED
 * to be able to reach this, and putting them in the same count is how a review
 * concludes that access was never removed.
 *
 * IT RETURNS EVERY NON-REVOKED CONNECTION AND THE SERVICE FILTERS. Which of
 * these the asker holds a grant on is a permission decision, and one made here
 * would apply only to callers who happened to use this function.
 */
export async function overview(db: Executor): Promise<ConnectionOverview[]> {
  const { rows } = await db.query<OverviewRow>(
    `SELECT c.id, c.name, c.provider, c.status, c.writes_enabled, c.halted_reason,
            c.last_healthy_at, c.credential_acts_as, c.credential_rights, cc.last_four,
            cc.credential_expires_at, cc.expiry_source,
            c.notes, c.parameters, c.manifest_id,
            (m.document->'identity'->>'version')::int AS manifest_version,
            (SELECT array_agg(p.value ORDER BY p.value) FROM connection_pins p WHERE p.connection_id = c.id AND p.kind = 'origin') AS pinned_origins,
            reach.scopes AS reach_scopes,
            reach.people AS reach_people,
            reach.principals AS reach_principals
       FROM connections c
       JOIN connector_manifests m ON m.id = c.manifest_id
       LEFT JOIN connection_credentials cc
         ON cc.connection_id = c.id AND cc.purpose = 'token'
       LEFT JOIN LATERAL (
         SELECT
           coalesce(
             array_agg(s.name ORDER BY s.name) FILTER (WHERE g.scope_id IS NOT NULL),
             ARRAY[]::text[]
           ) AS scopes,
           count(*) FILTER (WHERE g.membership_id IS NOT NULL) AS people,
           count(*) FILTER (WHERE g.principal_id IS NOT NULL)  AS principals
           FROM connection_grants g
           LEFT JOIN scopes s ON s.id = g.scope_id
          WHERE g.connection_id = c.id
            AND g.revoked_at IS NULL
            AND (g.expires_at IS NULL OR g.expires_at > now())
       ) reach ON TRUE
      WHERE c.status <> 'revoked'
      ORDER BY c.created_at DESC`,
  );

  return rows.map(mapOverview);
}

interface AvailableRow {
  manifest_id: string;
  connector_key: string;
  name: string | null;
  provider: string | null;
  sharing: string | null;
  version: number | null;
  mine: string | null;
  /** `count(*)` again: a string until it is coerced. */
  others: string;
}

/**
 * A CONNECTOR WITH NO NAME IN ITS DOCUMENT IS STILL A CONNECTOR SOMEBODY HAS TO
 * PICK FROM A LIST. Falling back to the key is what stops a blank row; deciding
 * that at each call site is how one screen shows a gap and another shows the
 * key.
 */
function mapAvailable(row: AvailableRow): AvailableConnector {
  return {
    manifestId: row.manifest_id,
    connectorKey: row.connector_key,
    name: row.name ?? row.connector_key,
    provider: row.provider ?? 'unknown',
    version: row.version,
    credentialSharing: (row.sharing === 'per_user'
      ? 'per_user'
      : 'shareable') as CredentialSharing,
    connectionId: row.mine,
    connectionsInUse: Number(row.others),
  };
}

/**
 * The latest manifest of every approved connector, and what this membership's
 * own access to each amounts to.
 *
 * `DISTINCT ON (connector_key)` PICKS THE LATEST OF EACH. Two versions of the
 * same connector are one entry on a list of things you can connect, and showing
 * both asks somebody to choose between a number they have no way to reason
 * about.
 *
 * `mine` IS A GRANT CHECK IN SQL AND IS NOT A POLICY DECISION. The question the
 * row answers is "is there a connection through this manifest that this person
 * can already query" — a fact about the estate that the model then reads as
 * `ready` or `needs_your_credential`. Without the predicate the query would
 * return somebody else's connection as this person's, which is wrong rather than
 * over-permissive.
 */
export async function available(
  db: Executor,
  membershipId: string,
): Promise<AvailableConnector[]> {
  const { rows } = await db.query<AvailableRow>(
    `WITH latest AS (
       SELECT DISTINCT ON (connector_key) id, connector_key,
              document->'identity'->>'name'     AS name,
              document->'identity'->>'provider' AS provider,
              /*
               * THE TABLE'S COLUMN, NOT THE DOCUMENT'S FIELD. The CTE already
               * orders by version to pick the latest of each connector, and an
               * aliased JSON copy under the same name would quietly become
               * what that ORDER BY sorts on.
               */
              version,
              document->>'credentialSharing'    AS sharing
         FROM connector_manifests
        WHERE superseded_at IS NULL
        ORDER BY connector_key, version DESC
     )
     SELECT l.id AS manifest_id, l.connector_key, l.name, l.provider, l.sharing, l.version,
            (
              SELECT c.id FROM connections c
               WHERE c.manifest_id = l.id
                 AND c.status NOT IN ('revoked', 'halted')
                 AND EXISTS (
                   SELECT 1 FROM connection_grants g
                    WHERE g.connection_id = c.id
                      AND g.revoked_at IS NULL
                      AND (g.expires_at IS NULL OR g.expires_at > now())
                      AND g.can_read
                      AND (g.organisation_wide OR g.membership_id = $1)
                 )
               LIMIT 1
            ) AS mine,
            (
              SELECT count(*) FROM connections c
               WHERE c.manifest_id = l.id AND c.status NOT IN ('revoked', 'halted')
            ) AS others
       FROM latest l
      ORDER BY l.name`,
    [membershipId],
  );

  return rows.map(mapAvailable);
}

/** Enough of a connection to decide whether a halt can be cleared, and to say what it was. */
export async function readHalt(
  db: Executor,
  connectionId: string,
): Promise<ConnectionHalt | null> {
  const { rows } = await db.query<{ status: ConnectionStatus; halted_reason: string | null }>(
    `SELECT status, halted_reason FROM connections WHERE id = $1`,
    [connectionId],
  );

  const row = rows[0];
  return row ? { status: row.status, haltedReason: row.halted_reason } : null;
}

/**
 * Bring a connection back from a halt.
 *
 * IT DOES NOT CHECK THAT THE CONNECTION WAS HALTED. `WHERE status = 'halted'`
 * here would silently do nothing on a connection that is merely draft and hand
 * the caller the same success as a real resume — so the service reads the halt,
 * decides, and this writes what it decided.
 */
export async function resume(db: Executor, connectionId: string): Promise<void> {
  await db.query(
    `UPDATE connections
        SET status = 'active', halted_reason = NULL, last_healthy_at = now()
      WHERE id = $1`,
    [connectionId],
  );
}

/**
 * Record what the credential is at the source and how far it reaches. 028.
 *
 * `COALESCE` SO AN OMITTED FIELD IS NOT AN ERASURE. Somebody recording only the
 * rights is not saying the principal's name is now unknown, and a plain
 * assignment would read it that way.
 */
export async function recordProvenance(
  db: Executor,
  input: { connectionId: string; actsAs: string | null; rights: CredentialRights | null },
): Promise<CredentialProvenance | null> {
  const { rows } = await db.query<{
    credential_acts_as: string | null;
    credential_rights: CredentialRights;
  }>(
    `UPDATE connections
        SET credential_acts_as = COALESCE($2, credential_acts_as),
            credential_rights = COALESCE($3, credential_rights)
      WHERE id = $1
      RETURNING credential_acts_as, credential_rights`,
    [input.connectionId, input.actsAs, input.rights],
  );

  const row = rows[0];
  return row ? { actsAs: row.credential_acts_as, rights: row.credential_rights } : null;
}

/**
 * Retire a connection. False when there was no live one to retire.
 *
 * `status <> 'revoked'` IS HERE BECAUSE A SECOND RETIREMENT IS NOT ONE. Without
 * it the statement succeeds every time and the caller cannot tell a retirement
 * from a repeat — and the audit trail gains an event for something that did not
 * happen.
 *
 * NOT A DELETE. Probe runs, heal proposals and the audit trail all reference
 * this connection, and answers already given cite the manifest it used.
 */
export async function revoke(db: Executor, connectionId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE connections SET status = 'revoked' WHERE id = $1 AND status <> 'revoked'`,
    [connectionId],
  );

  return Boolean(rowCount);
}

/** §7's verification and maintenance runs against one connection, newest first. */
export async function probeRuns(db: Executor, connectionId: string): Promise<ProbeRun[]> {
  const { rows } = await db.query<{
    id: string;
    stage: string;
    status: string;
    findings: Record<string, unknown>;
    errors: unknown[];
    read_only: boolean;
    started_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT id, stage, status, findings, errors, read_only, started_at, completed_at
       FROM probe_runs WHERE connection_id = $1
      ORDER BY started_at DESC LIMIT 100`,
    [connectionId],
  );

  return rows.map((row) => ({
    id: row.id,
    stage: row.stage,
    status: row.status,
    findings: row.findings,
    errors: row.errors,
    readOnly: row.read_only,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

/**
 * Every version of the connector a connection reads through, newest first.
 *
 * THE LINEAGE IS `connector_key` PLUS OWNER, NOT `connector_key` ALONE. A
 * customer's own build of `salesforce` and the prebuilt one share a key and are
 * different connectors; `IS NOT DISTINCT FROM` is what makes the prebuilt
 * lineage (`organisation_id` null) match itself rather than nothing, which plain
 * equality against NULL would.
 */
export async function manifestLineage(
  db: Executor,
  manifestId: string,
): Promise<ManifestVersion[]> {
  const { rows } = await db.query<{
    id: string;
    version: number;
    source_route: string;
    created_at: Date;
    superseded_at: Date | null;
  }>(
    `SELECT m.id, m.version, m.source_route, m.created_at, m.superseded_at
       FROM connector_manifests m
      WHERE m.connector_key = (SELECT connector_key FROM connector_manifests WHERE id = $1)
        AND m.organisation_id IS NOT DISTINCT FROM
            (SELECT organisation_id FROM connector_manifests WHERE id = $1)
      ORDER BY m.version DESC`,
    [manifestId],
  );

  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    sourceRoute: row.source_route,
    createdAt: row.created_at,
    supersededAt: row.superseded_at,
  }));
}

/**
 * A connector version's stored document, for the connect form. Read through
 * row level security: another tenant's does not come back, a prebuilt one does.
 */
export async function manifestDocument(
  db: Executor,
  manifestId: string,
): Promise<{ document: unknown; schemaVersion: number } | null> {
  const { rows } = await db.query<{ document: unknown; schema_version: number }>(
    `SELECT document, schema_version FROM connector_manifests WHERE id = $1`,
    [manifestId],
  );
  const row = rows[0];
  return row ? { document: row.document, schemaVersion: row.schema_version } : null;
}

/** A connection's parameters, replaced whole — they are checked together against the manifest. */
export async function setParameters(db: Executor, connectionId: string, parameters: Record<string, string>): Promise<boolean> {
  const { rowCount } = await db.query(`UPDATE connections SET parameters = $2::jsonb WHERE id = $1`, [
    connectionId,
    JSON.stringify(parameters),
  ]);
  return (rowCount ?? 0) > 0;
}

/* ── Pins: what the admin confirmed (MANIFEST-V2 §9.2) ──────────────────── */

/** Replace what is pinned: the confirmation is whole, never merged. */
export async function replacePins(
  db: Executor,
  input: { organisationId: string; connectionId: string; origins: string[]; statements: string[]; confirmedBy: string },
): Promise<void> {
  await db.query(`DELETE FROM connection_pins WHERE connection_id = $1`, [input.connectionId]);
  const rows = [...input.origins.map((value) => ['origin', value] as const), ...input.statements.map((value) => ['statement', value] as const)];
  for (const [kind, value] of rows) {
    await db.query(
      `INSERT INTO connection_pins (id, organisation_id, connection_id, kind, value, confirmed_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [generateId(), input.organisationId, input.connectionId, kind, value, input.confirmedBy],
    );
  }
}

/* ── When a credential lapses ───────────────────────────────────────────── */

/** Who gave the credential, and when it stops working if that can be known. Resets any warning sent. */
export async function recordCredentialExpiry(
  db: Executor,
  input: { connectionId: string; strategy: string; sealedBy: string; expiresAt: Date | null; source: 'certificate' | 'token' | 'declared' | null },
): Promise<void> {
  await db.query(
    `UPDATE connection_credentials
        SET sealed_by = $3, credential_expires_at = $4, expiry_source = $5, expiry_stage = NULL
      WHERE connection_id = $1 AND auth_strategy = $2 AND purpose = 'token'`,
    [input.connectionId, input.strategy, input.sealedBy, input.expiresAt, input.source],
  );
}

export interface LapsingCredential {
  connectionId: string;
  organisationId: string;
  connectionName: string;
  strategy: string;
  expiresAt: Date;
  source: 'certificate' | 'token' | 'declared';
  stage: 'upcoming' | 'week' | 'imminent' | 'expired' | null;
  sealedBy: string | null;
  /** The connector's `setup.rotation`: how a new credential is got. */
  rotation: string | null;
}

/** Every credential lapsing within `days`, across organisations: the sweep's, run as the migrator. */
export async function lapsingCredentials(db: Executor, days: number): Promise<LapsingCredential[]> {
  const { rows } = await db.query<{
    connection_id: string;
    organisation_id: string;
    name: string;
    auth_strategy: string;
    credential_expires_at: Date;
    expiry_source: LapsingCredential['source'];
    expiry_stage: LapsingCredential['stage'];
    sealed_by: string | null;
    rotation: string | null;
  }>(
    `SELECT cc.connection_id, c.organisation_id, c.name, cc.auth_strategy, cc.credential_expires_at,
            cc.expiry_source, cc.expiry_stage, cc.sealed_by, m.document->'setup'->>'rotation' AS rotation
       FROM connection_credentials cc
       JOIN connections c ON c.id = cc.connection_id
       JOIN connector_manifests m ON m.id = c.manifest_id
      WHERE cc.purpose = 'token'
        AND cc.credential_expires_at IS NOT NULL
        AND cc.credential_expires_at < now() + make_interval(days => $1)
        AND c.status <> 'revoked'
      ORDER BY cc.credential_expires_at`,
    [days],
  );
  return rows.map((r) => ({
    connectionId: r.connection_id,
    organisationId: r.organisation_id,
    connectionName: r.name,
    strategy: r.auth_strategy,
    expiresAt: r.credential_expires_at,
    source: r.expiry_source,
    stage: r.expiry_stage,
    sealedBy: r.sealed_by,
    rotation: r.rotation,
  }));
}

export async function markExpiryStage(db: Executor, connectionId: string, strategy: string, stage: 'upcoming' | 'week' | 'imminent' | 'expired'): Promise<void> {
  await db.query(
    `UPDATE connection_credentials SET expiry_stage = $3 WHERE connection_id = $1 AND auth_strategy = $2 AND purpose = 'token'`,
    [connectionId, strategy, stage],
  );
}

/**
 * Who in an organisation may replace a connection's credential: live members
 * holding `connection.create` by a live role assignment.
 */
export async function credentialManagers(db: Executor, organisationId: string): Promise<string[]> {
  const { rows } = await db.query<{ membership_id: string }>(
    `SELECT DISTINCT ra.membership_id
       FROM role_assignments ra
       JOIN role_permissions rp ON rp.role_id = ra.role_id AND rp.permission_id = 'connection.create'
       JOIN memberships m ON m.id = ra.membership_id
      WHERE m.organisation_id = $1
        AND m.status = 'active'
        AND ra.revoked_at IS NULL
        AND (ra.expires_at IS NULL OR ra.expires_at > now())`,
    [organisationId],
  );
  return rows.map((r) => r.membership_id);
}

/** Writes off until they are verified again — after a version that writes differently is adopted. */
export async function disableWrites(db: Executor, connectionId: string): Promise<void> {
  await db.query(`UPDATE connections SET writes_enabled = false WHERE id = $1`, [connectionId]);
}

/* ── Prebuilt connectors kept current (MANIFEST-V2 §3.7) ────────────────── */

export async function autoAdoptEnabled(db: Executor, organisationId: string): Promise<boolean> {
  const { rows } = await db.query<{ auto_adopt_prebuilt: boolean }>(`SELECT auto_adopt_prebuilt FROM organisations WHERE id = $1`, [organisationId]);
  return rows[0]?.auto_adopt_prebuilt ?? false;
}

export async function setAutoAdopt(db: Executor, organisationId: string, on: boolean): Promise<void> {
  await db.query(`UPDATE organisations SET auto_adopt_prebuilt = $2 WHERE id = $1`, [organisationId, on]);
}

/** Live connections on a prebuilt connector whose lineage has a newer, current version. */
export async function prebuiltBehind(db: Executor): Promise<Array<{ connectionId: string; newestManifestId: string }>> {
  const { rows } = await db.query<{ connection_id: string; newest: string }>(
    `SELECT c.id AS connection_id, newest.id AS newest
       FROM connections c
       JOIN connector_manifests m ON m.id = c.manifest_id
       JOIN LATERAL (
         SELECT n.id, n.version FROM connector_manifests n
          WHERE n.connector_key = m.connector_key AND n.organisation_id IS NULL AND n.superseded_at IS NULL
          ORDER BY n.version DESC LIMIT 1
       ) newest ON true
      WHERE m.organisation_id IS NULL
        AND c.status IN ('active', 'verified')
        AND newest.version > m.version`,
  );
  return rows.map((r) => ({ connectionId: r.connection_id, newestManifestId: r.newest }));
}
