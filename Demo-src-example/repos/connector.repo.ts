import type { Executor } from '../infra/db.infra';
import type { ManifestV2 } from '../schemas/manifest.schema';
import { CURRENT_SCHEMA_VERSION, loadManifest } from '../engine/compat/load.compat';
import { invalid } from '../utils/error.util';
import type { Sealed } from '../utils/envelope.util';

/**
 * Loading a connector out of the database.
 *
 * THE MANIFEST IS PARSED ON THE WAY OUT, NOT TRUSTED. It is `jsonb` written by
 * a route that may have been a model, by a schema version that may be older than
 * this process, or by a hand edit. §2 puts the boundary at the Zod schema, and a
 * boundary crossed only on the way in is not a boundary — the row outlives the
 * code that wrote it.
 */

export interface LoadedConnection {
  connectionId: string;
  name: string;
  provider: string;
  status: string;
  writesEnabled: boolean;
  manifestId: string;
  manifestVersion: number;
  manifest: ManifestV2;
  /** Which document version is stored. A version 1 document is compiled on every load. */
  schemaVersion: number;
  /** What compiling a version 1 document could not carry over, for the builder to show. */
  compileNotes: string[];
  /** The connection's parameters: not secret, bound as `params` in every expression. */
  parameters: Record<string, string>;
  /**
   * What the admin confirmed (MANIFEST-V2 §9.2): where the credential may go and
   * which statements may run. Null for a connection made before pinning, which
   * runs on what its document computes until an admin confirms.
   */
  pins: { origins: string[]; statements: string[] } | null;
}

interface Row {
  connection_id: string;
  name: string;
  provider: string;
  status: string;
  writes_enabled: boolean;
  manifest_id: string;
  version: number;
  schema_version: number;
  document: unknown;
  parameters?: Record<string, string> | null;
  pinned_origins?: string[] | null;
  pinned_statements?: string[] | null;
}

/**
 * THE CURRENT SCHEMA VERSION THIS PROCESS UNDERSTANDS.
 *
 * A manifest written by a newer deploy is refused rather than parsed leniently:
 * a document with a field this code does not know about is a document whose
 * meaning this code does not know, and executing it anyway is how a connector
 * silently does something other than what its author configured.
 */
export const SUPPORTED_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

function parse(row: Row): LoadedConnection {
  if (row.schema_version > SUPPORTED_SCHEMA_VERSION) {
    throw invalid({
      message:
        `Connector "${row.name}" was written by a newer version of Silo and cannot be run here.`,
      code: 'invalid.manifest_too_new',
      detail: { manifestId: row.manifest_id, schemaVersion: row.schema_version },
    });
  }

  /*
   * THE COLUMN AND THE DOCUMENT MUST AGREE.
   *
   * `schema_version` is stored twice on purpose: in the column, so a query can
   * find every manifest of a given shape without deserialising the whole table,
   * and inside the document, so a manifest exported, pasted into the builder or
   * handed to a model still carries its own version. Two copies of a fact drift,
   * and here the drift is silent — the column says 1, the check above passes,
   * and the document is a shape this code has never seen.
   */
  const declared = (row.document as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof declared === 'number' && declared !== row.schema_version) {
    throw invalid({
      message: `Connector "${row.name}" disagrees with itself about which manifest version it is.`,
      code: 'invalid.manifest_version_mismatch',
      detail: { column: row.schema_version, document: declared, manifestId: row.manifest_id },
    });
  }

  const parsed = loadManifest(row.document, row.schema_version);

  if (!parsed.ok) {
    /*
     * REFUSED, NOT REPAIRED. §5 says a draft failing validation is rejected
     * rather than fixed up, and the same has to hold on read — a manifest the
     * engine "mostly" understands executes a query nobody wrote.
     */
    throw invalid({
      message: `Connector "${row.name}" is not a valid manifest and cannot be run.`,
      code: 'invalid.manifest_stored',
      detail: {
        manifestId: row.manifest_id,
        issues: parsed.issues,
      },
    });
  }

  return {
    connectionId: row.connection_id,
    name: row.name,
    provider: row.provider,
    status: row.status,
    writesEnabled: row.writes_enabled,
    manifestId: row.manifest_id,
    manifestVersion: row.version,
    manifest: parsed.manifest,
    schemaVersion: row.schema_version,
    compileNotes: parsed.notes,
    parameters: row.parameters ?? {},
    pins:
      row.pinned_origins || row.pinned_statements
        ? { origins: row.pinned_origins ?? [], statements: row.pinned_statements ?? [] }
        : null,
  };
}

const SELECT = `
  SELECT c.id AS connection_id, c.name, c.provider, c.status, c.writes_enabled, c.parameters,
         m.id AS manifest_id, m.version, m.schema_version, m.document,
         (SELECT array_agg(p.value ORDER BY p.value) FROM connection_pins p WHERE p.connection_id = c.id AND p.kind = 'origin') AS pinned_origins,
         (SELECT array_agg(p.value ORDER BY p.value) FROM connection_pins p WHERE p.connection_id = c.id AND p.kind = 'statement') AS pinned_statements
    FROM connections c
    JOIN connector_manifests m ON m.id = c.manifest_id
`;

/**
 * Load several at once.
 *
 * ONE QUERY FOR N CONNECTIONS, NOT N QUERIES. A question reaching six systems
 * would otherwise open with six round trips to our own database before any of
 * the real work starts — and those six are serial in the obvious implementation,
 * which is latency added to every multi-source answer for no reason.
 */
export async function load(db: Executor, connectionIds: string[]): Promise<LoadedConnection[]> {
  if (connectionIds.length === 0) return [];

  const { rows } = await db.query<Row>(`${SELECT} WHERE c.id = ANY($1)`, [connectionIds]);
  return rows.map(parse);
}

/** Everything active in the tenant. What a question with no named source reaches. */
export async function loadActive(db: Executor): Promise<LoadedConnection[]> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE c.status = 'active' ORDER BY c.name`);
  return rows.map(parse);
}

/**
 * Claim the connections nobody has yet looked across (133).
 *
 * ONE STATEMENT, SO TWO CALLERS CANNOT BOTH WIN. Whoever's update finds the
 * column empty sets it and gets the id back; the other gets nothing and does
 * not look. Only among `ids` — the connections the caller can actually read —
 * so somebody who reaches two of five systems does not mark the other three as
 * looked at.
 */
export async function claimUnjoined(db: Executor, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<{ id: string }>(
    `UPDATE connections SET joined_at = now()
      WHERE id = ANY($1) AND status = 'active' AND joined_at IS NULL
      RETURNING id`,
    [[...ids]],
  );
  return rows.map((row) => row.id);
}

/** Give a claim back, when the looking it was for did not happen. */
export async function releaseJoin(db: Executor, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query(`UPDATE connections SET joined_at = NULL WHERE id = ANY($1)`, [[...ids]]);
}

export interface StoredCredential {
  connectionId: string;
  authStrategy: string;
  sealed: Sealed;
  grantedScopes: string[];
  expiresAt: Date | null;
}

/**
 * The sealed credentials for a set of connections.
 *
 * RETURNS THE SEALED FORM, NEVER PLAINTEXT. Opening one is the mediator's job
 * and happens as late as possible, inside the callback that uses it — a
 * repository that decrypted would put the value in a variable owned by whoever
 * called it.
 *
 * `purpose = 'token'` IS LOAD-BEARING, NOT TIDINESS. Since 021 an OAuth
 * connection has two credential rows: the client secret used against the token
 * endpoint, and the token used against the system itself. Both belong to the
 * same connection, and a map keyed on the connection would keep whichever the
 * database happened to return last — so a query could authenticate with the
 * client secret blob, producing 401s that look like a bad credential and change
 * with row order. This is the credential a REQUEST is made with; the other is
 * reached only through `withClient`.
 */
export async function credentialsFor(
  db: Executor,
  connectionIds: string[],
): Promise<Map<string, StoredCredential>> {
  if (connectionIds.length === 0) return new Map();

  const { rows } = await db.query<{
    connection_id: string;
    auth_strategy: string;
    sealed: Buffer;
    wrapped_key: Buffer;
    key_reference: string;
    granted_scopes: string[];
    expires_at: Date | null;
  }>(
    `SELECT connection_id, auth_strategy, sealed, wrapped_key, key_reference,
            granted_scopes, expires_at
       FROM connection_credentials
      WHERE connection_id = ANY($1) AND purpose = 'token'`,
    [connectionIds],
  );

  return new Map(
    rows.map((row) => [
      row.connection_id,
      {
        connectionId: row.connection_id,
        authStrategy: row.auth_strategy,
        sealed: {
          ciphertext: row.sealed,
          wrappedKey: row.wrapped_key,
          keyReference: row.key_reference,
        },
        grantedScopes: row.granted_scopes,
        expiresAt: row.expires_at,
      },
    ]),
  );
}


/* ── Grants ─────────────────────────────────────────────────────────────── */

/**
 * THE GRANT PREDICATE, WRITTEN ONCE PER VERB.
 *
 * §10: `connection_grants` is default deny — absence of a row is denial — and
 * the two statements below are the only places that shape is spelled out.
 * Querying, the builder's test panel, the connection list and the map layer all
 * have to agree about who can reach what, and four hand-written copies of a
 * predicate this size agree right up until one of them is edited.
 *
 * THESE RETURN ROWS AND DECIDE NOTHING. What a missing grant MEANS is the
 * service's question and it has two answers: naming a system you cannot reach is
 * a denial, while asking implicitly and being filtered out is simply not one of
 * your sources. A repo that threw would make those the same.
 *
 * A SCOPE GRANT REACHES DESCENDANTS ONLY WHEN IT SAYS SO. The subtree test is
 * the same ltree containment every other grant uses, so a connection granted at
 * Engineering behaves the way a role granted at Engineering does.
 */
export async function readableIds(
  db: Executor,
  input: { connectionIds: string[]; membershipId: string },
): Promise<string[]> {
  if (input.connectionIds.length === 0) return [];

  const { rows } = await db.query<{ connection_id: string }>(
    `SELECT DISTINCT g.connection_id
       FROM connection_grants g
      WHERE g.connection_id = ANY($1)
        AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > now())
        AND g.can_read
        AND (
          /*
           * THE ORDINARY CASE FIRST. An organisation registers a source once
           * with a service account and everybody uses it — that is what an
           * enterprise data platform does, and it is one row rather than one per
           * person.
           */
          g.organisation_wide
          OR g.membership_id = $2
          OR EXISTS (
            SELECT 1
              FROM scope_memberships sm
              JOIN scopes mine   ON mine.id = sm.scope_id
              JOIN scopes granted ON granted.id = g.scope_id
             WHERE sm.membership_id = $2
               AND (
                 mine.id = granted.id
                 OR (g.include_descendants AND mine.path <@ granted.path)
               )
          )
        )`,
    [input.connectionIds, input.membershipId],
  );

  return rows.map((row) => row.connection_id);
}

/**
 * Whether this membership holds a WRITE grant on one connection.
 *
 * `can_write` IS SEPARATE FROM `can_read` FOR THE OBVIOUS REASON. Most people
 * who should be able to ask a system a question should not be able to change it,
 * and a single flag would make those the same decision — so this is the same
 * shape as `readableIds` with the one column changed, and nothing else.
 */
export async function isWritableBy(
  db: Executor,
  input: { connectionId: string; membershipId: string },
): Promise<boolean> {
  const { rows } = await db.query<{ writable: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM connection_grants g
        WHERE g.connection_id = $1
          AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at > now())
          AND g.can_write
          AND (
            g.organisation_wide
            OR g.membership_id = $2
            OR EXISTS (
              SELECT 1 FROM scope_memberships sm
                JOIN scopes mine ON mine.id = sm.scope_id
                JOIN scopes granted ON granted.id = g.scope_id
               WHERE sm.membership_id = $2
                 AND (mine.id = granted.id
                      OR (g.include_descendants AND mine.path <@ granted.path))
            )
          )
     ) AS writable`,
    [input.connectionId, input.membershipId],
  );

  return Boolean(rows[0]?.writable);
}

/**
 * One manifest document, parsed with the same refusals `load` applies.
 *
 * FOR CALLERS THAT HAVE A DOCUMENT AND NOT A CONNECTION ROW — the inbound
 * intake, which finds its connection by an unguessable token before any tenant
 * is known. Sharing this rather than calling `manifestSchema.parse` directly is
 * what keeps the version checks from having two implementations, one of which
 * would eventually stop matching.
 */
export function parseDocument(document: unknown, schemaVersion: number): ManifestV2 {
  return parse({
    connection_id: '',
    name: 'inbound',
    provider: '',
    status: '',
    writes_enabled: false,
    manifest_id: '',
    version: 1,
    schema_version: schemaVersion,
    document,
  }).manifest;
}
