import type { Executor } from '../infra/db.infra';
import type { AllowedHost } from '../engine/relay/frame.relay';

/**
 * Agents, and the hosts each may reach for each connection.
 *
 * SQL, AND THE MAPPING BETWEEN A ROW AND A MODEL. Who may create or revoke an
 * agent is the service's; what crosses the channel is the relay's.
 */

export interface StoredAgent {
  id: string;
  name: string;
  lastFour: string | null;
  version: string | null;
  hostname: string | null;
  lastSeenAt: Date | null;
  enrolledAt: Date | null;
  enrolmentExpiresAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

type Row = {
  id: string;
  name: string;
  last_four: string | null;
  version: string | null;
  hostname: string | null;
  last_seen_at: Date | null;
  enrolled_at: Date | null;
  enrolment_expires_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
};

const COLUMNS = 'id, name, last_four, version, hostname, last_seen_at, enrolled_at, enrolment_expires_at, created_at, revoked_at';

const map = (row: Row): StoredAgent => ({
  id: row.id,
  name: row.name,
  lastFour: row.last_four,
  version: row.version,
  hostname: row.hostname,
  lastSeenAt: row.last_seen_at,
  enrolledAt: row.enrolled_at,
  enrolmentExpiresAt: row.enrolment_expires_at,
  createdAt: row.created_at,
  revokedAt: row.revoked_at,
});

export async function create(
  db: Executor,
  input: { id: string; organisationId: string; name: string; enrolmentHash: string; enrolmentExpiresAt: Date; createdBy: string },
): Promise<StoredAgent> {
  const { rows } = await db.query<Row>(
    `INSERT INTO agents (id, organisation_id, name, enrolment_hash, enrolment_expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [input.id, input.organisationId, input.name, input.enrolmentHash, input.enrolmentExpiresAt, input.createdBy],
  );
  return map(rows[0]!);
}

export async function list(db: Executor): Promise<StoredAgent[]> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM agents ORDER BY revoked_at IS NOT NULL, created_at`);
  return rows.map(map);
}

export async function find(db: Executor, id: string): Promise<StoredAgent | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM agents WHERE id = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

/** An agent's public key, for sealing a job to it. Null when it is revoked or never enrolled. */
export async function publicKeyOf(db: Executor, id: string): Promise<string | null> {
  const { rows } = await db.query<{ public_key: string | null }>(
    `SELECT public_key FROM agents WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  return rows[0]?.public_key ?? null;
}

export async function revoke(db: Executor, id: string, by: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE agents SET revoked_at = now(), revoked_by = $2, enrolment_hash = NULL WHERE id = $1 AND revoked_at IS NULL`,
    [id, by],
  );
  return (rowCount ?? 0) > 0;
}

/* ── Before any organisation is known ───────────────────────────────────── */

export async function byToken(
  db: Executor,
  tokenHash: string,
): Promise<{ id: string; organisationId: string; name: string; publicKey: string } | null> {
  const { rows } = await db.query<{ id: string; organisation_id: string; name: string; public_key: string }>(
    `SELECT * FROM agent_by_token($1)`,
    [tokenHash],
  );
  const row = rows[0];
  return row ? { id: row.id, organisationId: row.organisation_id, name: row.name, publicKey: row.public_key } : null;
}

export async function enrol(
  db: Executor,
  input: { enrolmentHash: string; tokenHash: string; lastFour: string; publicKey: string; version: string; hostname: string },
): Promise<{ id: string; organisationId: string; name: string } | null> {
  const { rows } = await db.query<{ id: string; organisation_id: string; name: string }>(
    `SELECT * FROM enrol_agent($1, $2, $3, $4, $5, $6)`,
    [input.enrolmentHash, input.tokenHash, input.lastFour, input.publicKey, input.version.slice(0, 64), input.hostname.slice(0, 255)],
  );
  const row = rows[0];
  return row ? { id: row.id, organisationId: row.organisation_id, name: row.name } : null;
}

/* ── Inside the agent's organisation ────────────────────────────────────── */

export async function noteSeen(db: Executor, id: string, seen: { version?: string; hostname?: string }): Promise<void> {
  await db.query(
    `UPDATE agents SET last_seen_at = now(),
            version = COALESCE($2, version),
            hostname = COALESCE($3, hostname)
      WHERE id = $1`,
    [id, seen.version?.slice(0, 64) ?? null, seen.hostname?.slice(0, 255) ?? null],
  );
}

type HostRow = { connection_id: string; host: string; port_from: number; port_to: number };
const mapHost = (row: HostRow): AllowedHost => ({ connectionId: row.connection_id, host: row.host, portFrom: row.port_from, portTo: row.port_to });

/** Every host every connection has confirmed for this agent: what the agent is told. */
export async function hostsForAgent(db: Executor, agentId: string): Promise<AllowedHost[]> {
  const { rows } = await db.query<HostRow>(
    `SELECT h.connection_id, h.host, h.port_from, h.port_to
       FROM connection_agent_hosts h
       JOIN connections c ON c.id = h.connection_id AND c.agent_id = h.agent_id
      WHERE h.agent_id = $1
      ORDER BY h.connection_id, h.host, h.port_from`,
    [agentId],
  );
  return rows.map(mapHost);
}

export async function hostsForConnection(db: Executor, connectionId: string, agentId: string): Promise<AllowedHost[]> {
  const { rows } = await db.query<HostRow>(
    `SELECT connection_id, host, port_from, port_to FROM connection_agent_hosts
      WHERE connection_id = $1 AND agent_id = $2
      ORDER BY host, port_from`,
    [connectionId, agentId],
  );
  return rows.map(mapHost);
}

/**
 * Which agent a connection goes through, and exactly what it may reach — set
 * together, because a confirmed list for one agent means nothing for another.
 */
export async function assign(
  db: Executor,
  input: {
    organisationId: string;
    connectionId: string;
    agentId: string | null;
    hosts: Array<{ id: string; host: string; portFrom: number; portTo: number }>;
    confirmedBy: string;
  },
): Promise<void> {
  await db.query(`UPDATE connections SET agent_id = $2 WHERE id = $1`, [input.connectionId, input.agentId]);
  await db.query(`DELETE FROM connection_agent_hosts WHERE connection_id = $1`, [input.connectionId]);
  if (!input.agentId) return;
  for (const host of input.hosts) {
    await db.query(
      `INSERT INTO connection_agent_hosts (id, organisation_id, connection_id, agent_id, host, port_from, port_to, confirmed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [host.id, input.organisationId, input.connectionId, input.agentId, host.host.toLowerCase(), host.portFrom, host.portTo, input.confirmedBy],
    );
  }
}

/** The agent a connection goes through, if any. */
export async function agentOf(db: Executor, connectionId: string): Promise<string | null> {
  const { rows } = await db.query<{ agent_id: string | null }>(`SELECT agent_id FROM connections WHERE id = $1`, [connectionId]);
  return rows[0]?.agent_id ?? null;
}

/** Who confirmed this connection's route through its agent: the authority a tap runs on. */
export async function confirmedBy(db: Executor, connectionId: string): Promise<string | null> {
  const { rows } = await db.query<{ confirmed_by: string }>(
    `SELECT confirmed_by FROM connection_agent_hosts WHERE connection_id = $1 ORDER BY confirmed_at DESC LIMIT 1`,
    [connectionId],
  );
  return rows[0]?.confirmed_by ?? null;
}

/** Connections through this agent whose transport is a tap: what it should be listening to. */
export async function tapsFor(db: Executor, agentId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT c.id
       FROM connections c
       JOIN connector_manifests m ON m.id = c.manifest_id
      WHERE c.agent_id = $1
        AND c.status NOT IN ('halted', 'revoked')
        AND m.document->'transport'->>'kind' = 'queue_tap'`,
    [agentId],
  );
  return rows.map((r) => r.id);
}
