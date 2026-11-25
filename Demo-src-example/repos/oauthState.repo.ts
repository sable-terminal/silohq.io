import type { Executor } from '../infra/db.infra';
import type { Sealed } from '../utils/envelope.util';
import type { Manifest } from '../schemas/manifest.schema';
import { loadManifest } from '../engine/compat/load.compat';
import type {
  PendingOAuthFlow,
  StoredOAuthClient,
  StoredOAuthToken,
} from '../models/oauthState.model';
import { generateId } from '../utils/tokens.util';

/**
 * The OAuth flow's rows: the pending browser round trip, the two sealed
 * credentials a connection ends up holding, and the fields on `connections` that
 * a completed handshake settles.
 *
 * SQL AND THE ROW-TO-MODEL MAPPING. Nothing decides anything here. Whether a
 * consumed state is an expiry or a replay, whether a connection with no token
 * may be used, and whether a provider granting fewer scopes than were asked for
 * is fatal are all judgements, and they live in
 * `services/connectorOAuth.service.ts`.
 *
 * IT WRITES `connections` AND `connection_credentials` AND OWNS NEITHER, the way
 * `connection.repo` reads `connector_manifests` and owns that. Every statement
 * below is anchored to one connection and belongs to one moment in the OAuth
 * flow — the handshake that verified it, the instance the provider said it
 * reached, the token that was just rotated. The rows are somebody else's; the
 * questions are this flow's.
 *
 * NOTHING HERE OPENS A SEALED VALUE. Credentials go in and come out sealed;
 * unwrapping needs the key wrapper and the mediator's audit trail, both of which
 * belong to the service.
 */

/* ── The pending round trip ─────────────────────────────────────────────── */

/**
 * Record a flow that is about to leave for the provider.
 *
 * ONLY THE DIGEST OF THE STATE. The state travels in a URL, through the
 * provider, and lands in access logs on both sides; storing its hash costs
 * nothing and means a leaked log is not a leaked flow.
 *
 * THE TEN MINUTES ARE COMPUTED BY POSTGRES, not here. An expiry written from
 * this process's clock is compared against the database's, and the two disagree
 * by however far the hosts have drifted.
 */
export async function insertPending(
  db: Executor,
  input: {
    stateHash: string;
    connectionId: string;
    organisationId: string;
    initiatedBy: string;
    codeVerifier: string | null;
    requestedScopes: string[];
  },
): Promise<void> {
  await db.query(
    `INSERT INTO oauth_pending_states
       (state_hash, connection_id, organisation_id, initiated_by, code_verifier,
        requested_scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes')`,
    [
      input.stateHash,
      input.connectionId,
      input.organisationId,
      input.initiatedBy,
      input.codeVerifier,
      input.requestedScopes,
    ],
  );
}

interface PendingRow {
  connection_id: string;
  organisation_id: string;
  initiated_by: string;
  code_verifier: string | null;
  requested_scopes: string[];
}

function mapPending(row: PendingRow): PendingOAuthFlow {
  return {
    connectionId: row.connection_id,
    organisationId: row.organisation_id,
    initiatedBy: row.initiated_by,
    codeVerifier: row.code_verifier,
    requestedScopes: row.requested_scopes,
  };
}

/**
 * Claim a pending flow, once.
 *
 * THE CHECK AND THE MARK ARE ONE STATEMENT, which is why this goes through
 * `consume_oauth_state` rather than a select and an update: a read followed by a
 * write opens a window in which two concurrent callbacks both see an unconsumed
 * row and the second seals a token obtained by whoever replayed the link.
 *
 * `SECURITY DEFINER`, BECAUSE THE CALLBACK HAS NO TENANT. It arrives as a
 * browser navigation carrying only a state — discovering which organisation it
 * belongs to is the whole job, so a policy keyed on `app_org_id()` cannot serve
 * the query that establishes it. The caller runs this untenanted for that reason
 * and for no other.
 *
 * NULL RATHER THAN THROWING. Unknown, expired and already-used are one row's
 * absence here; whether the caller is told them apart is the service's decision
 * and it deliberately does not.
 */
export async function consumePending(
  db: Executor,
  stateHash: string,
): Promise<PendingOAuthFlow | null> {
  const { rows } = await db.query<PendingRow>(`SELECT * FROM consume_oauth_state($1)`, [stateHash]);

  const row = rows[0];
  return row ? mapPending(row) : null;
}

/* ── Credentials ────────────────────────────────────────────────────────── */

/**
 * `purpose = 'token'` IS LOAD-BEARING, NOT TIDINESS. Since 021 an OAuth
 * connection has two credential rows — the client secret used against the token
 * endpoint, and the token used against the system itself. A query that selected
 * on the connection alone would take whichever Postgres returned last and
 * authenticate with the wrong blob, producing 401s that change with row order.
 * The predicate is here because the statement would otherwise be wrong, never
 * because a caller should not see the other row.
 */
const TOKEN_COLUMNS = `sealed, wrapped_key, key_reference, expires_at`;

interface TokenRow {
  sealed: Buffer;
  wrapped_key: Buffer;
  key_reference: string;
  expires_at: Date | null;
}

function mapToken(row: TokenRow): StoredOAuthToken {
  return {
    sealed: {
      ciphertext: row.sealed,
      wrappedKey: row.wrapped_key,
      keyReference: row.key_reference,
    },
    expiresAt: row.expires_at,
  };
}

/** The sealed tokens a request is made with. Null means there are none to use. */
export async function readToken(
  db: Executor,
  connectionId: string,
): Promise<StoredOAuthToken | null> {
  const { rows } = await db.query<TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM connection_credentials
      WHERE connection_id = $1 AND purpose = 'token'`,
    [connectionId],
  );

  const row = rows[0];
  return row ? mapToken(row) : null;
}

/** The sealed OAuth application, §4.4.3 — ours or the customer's, the same row. */
export async function readClient(
  db: Executor,
  connectionId: string,
): Promise<StoredOAuthClient | null> {
  const { rows } = await db.query<{
    sealed: Buffer;
    wrapped_key: Buffer;
    key_reference: string;
  }>(
    `SELECT sealed, wrapped_key, key_reference FROM connection_credentials
      WHERE connection_id = $1 AND purpose = 'client'`,
    [connectionId],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    sealed: {
      ciphertext: row.sealed,
      wrappedKey: row.wrapped_key,
      keyReference: row.key_reference,
    },
  };
}

/**
 * Write the tokens a handshake or a refresh produced.
 *
 * IT TAKES THE SEALED FORM AND NEVER THE PLAINTEXT. Sealing needs the key
 * wrapper and belongs to the service; a repo that took a secret would be a
 * second place the cleartext exists, held in a variable owned by whoever called
 * it.
 *
 * THE UPSERT RESETS `refresh_failure_count`. A success is the thing that answers
 * a run of failures, and a connection that recovered would otherwise still look
 * like one about to be given up on.
 */
export async function upsertToken(
  db: Executor,
  input: {
    connectionId: string;
    strategy: string;
    sealed: Sealed;
    lastFour: string;
    grantedScopes: string[];
    expiresAt: Date | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO connection_credentials
       (id, connection_id, auth_strategy, purpose, sealed, wrapped_key, key_reference,
        last_four, granted_scopes, expires_at, refreshed_at)
     VALUES ($1, $2, $3, 'token', $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (connection_id, auth_strategy, purpose)
     DO UPDATE SET sealed = EXCLUDED.sealed,
                   wrapped_key = EXCLUDED.wrapped_key,
                   key_reference = EXCLUDED.key_reference,
                   last_four = EXCLUDED.last_four,
                   granted_scopes = EXCLUDED.granted_scopes,
                   expires_at = EXCLUDED.expires_at,
                   refreshed_at = now(),
                   -- A success clears the count, or a connection that recovered
                   -- still looks like one about to be given up on.
                   refresh_failure_count = 0`,
    [
      generateId(),
      input.connectionId,
      input.strategy,
      input.sealed.ciphertext,
      input.sealed.wrappedKey,
      input.sealed.keyReference,
      input.lastFour,
      input.grantedScopes,
      input.expiresAt,
    ],
  );
}

/**
 * Count one refresh that did not work.
 *
 * IT DOES NOT DECIDE WHAT THE COUNT MEANS. The threshold at which a connection
 * is given up on is a rule, and a repo that applied it would apply it only to
 * callers who came through here.
 */
export async function countRefreshFailure(db: Executor, connectionId: string): Promise<void> {
  await db.query(
    `UPDATE connection_credentials
        SET refresh_failure_count = refresh_failure_count + 1
      WHERE connection_id = $1 AND purpose = 'token'`,
    [connectionId],
  );
}

/* ── The lock a refresh is serialised by ────────────────────────────────── */

/**
 * Hold the refresh lock for this connection until the transaction ends.
 *
 * KEYED ON THE CONNECTION, AND TRANSACTION-SCOPED. Two queries arriving as a
 * token expires both see it expiring, both refresh, and for a provider that
 * ROTATES the refresh token the second exchange invalidates the first — leaving
 * a stored token that no longer works and a connection locked out until somebody
 * reconnects it by hand. The second caller waits here, then re-reads the row the
 * first one wrote.
 *
 * `hashtext` BECAUSE ADVISORY LOCKS TAKE INTEGERS and a connection id is a uuid.
 * Collisions are possible and harmless: two unrelated connections would take
 * turns refreshing rather than corrupt each other.
 */
export async function lockForRefresh(db: Executor, connectionId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [connectionId]);
}

/* ── What a completed handshake settles on the connection ───────────────── */

/**
 * The manifest a connection was made against.
 *
 * THE DOCUMENT AS STORED. This is the read the OAuth engine makes to find the
 * strategy it is conducting, and it does not apply `connector.repo`'s schema
 * version refusals — a flow already in mid-air against a manifest this process
 * cannot parse is a different problem from a query refusing to start, and
 * changing which it is belongs to whoever fixes it.
 */
export async function manifestFor(
  db: Executor,
  connectionId: string,
): Promise<{ manifest: Manifest; parameters: Record<string, string> } | null> {
  const { rows } = await db.query<{ document: unknown; schema_version: number; parameters: Record<string, string> | null }>(
    `SELECT m.document, m.schema_version, c.parameters FROM connections c
       JOIN connector_manifests m ON m.id = c.manifest_id
      WHERE c.id = $1`,
    [connectionId],
  );
  const row = rows[0];
  if (!row) return null;
  /* A version 1 document is compiled, as every reader of a stored manifest does. */
  const loaded = loadManifest(row.document, row.schema_version);
  return loaded.ok ? { manifest: loaded.manifest, parameters: row.parameters ?? {} } : null;
}

/**
 * Mark the credential as working.
 *
 * `verified` MEANS THE CREDENTIAL WORKS, NOT THAT THE CONNECTION IS IN SERVICE.
 * §7 puts human confirmation after this, so `loadActive` excluding it is
 * correct — a connection nobody has looked at should not start answering
 * questions because a handshake succeeded.
 */
export async function markVerified(db: Executor, connectionId: string): Promise<void> {
  await db.query(
    `UPDATE connections SET status = 'verified', last_healthy_at = now() WHERE id = $1`,
    [connectionId],
  );
}

/**
 * Record which instance of the provider this connection reached.
 *
 * THE ID AND THE LABEL ARE THE SAME VALUE FOR NOW. Nothing has asked the
 * provider what the instance is CALLED yet, and a label left null would be shown
 * as a blank where an identifier is at least recognisable.
 */
export async function recordSourceInstance(
  db: Executor,
  connectionId: string,
  instance: string,
): Promise<void> {
  await db.query(
    `UPDATE connections
        SET source_instance_id = $2, source_instance_label = $2, source_resolved_at = now()
      WHERE id = $1`,
    [connectionId, instance],
  );
}
