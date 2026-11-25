import type { Executor } from '../infra/db.infra';

/** Simulation §5 — the question, kept, so two answers are comparable. */

export type SimulationMode = 'deterministic' | 'probabilistic';

export interface Scenario {
  id: string;
  ownerId: string;
  name: string;
  failedConceptId: string;
  failedEntityRefs: string[];
  mode: SimulationMode;
  maxHops: number;
  maxPerHop: number;
  /* §4.3 — the window a probability is a probability OF. Null in deterministic
     mode, which returns everything reached with its accumulated delay and makes
     no claim that needs one. */
  horizonHours: number | null;
  /* §4.2 — "Iteration count is bounded and stated." */
  iterations: number | null;
  graphVersion: string;
  createdAt: Date;
}

type Row = {
  id: string;
  owner_id: string;
  name: string;
  failed_concept_id: string;
  failed_entity_refs: string[];
  mode: SimulationMode;
  max_hops: number;
  max_per_hop: number;
  horizon_hours: string | null;
  iterations: number | null;
  graph_version: string;
  created_at: Date;
};

const COLUMNS = `id, owner_id, name, failed_concept_id, failed_entity_refs, mode,
                 max_hops, max_per_hop, horizon_hours, iterations, graph_version, created_at`;

const map = (row: Row): Scenario => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  failedConceptId: row.failed_concept_id,
  failedEntityRefs: row.failed_entity_refs,
  mode: row.mode,
  maxHops: row.max_hops,
  maxPerHop: row.max_per_hop,
  horizonHours: row.horizon_hours === null ? null : Number(row.horizon_hours),
  iterations: row.iterations,
  graphVersion: row.graph_version,
  createdAt: row.created_at,
});

export async function create(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    ownerId: string;
    name: string;
    failedConceptId: string;
    failedEntityRefs: readonly string[];
    mode: SimulationMode;
    maxHops: number;
    maxPerHop: number;
    horizonHours: number | null;
    iterations: number | null;
    graphVersion: string;
  },
): Promise<Scenario> {
  const { rows } = await db.query<Row>(
    `INSERT INTO scenarios
       (id, organisation_id, owner_id, name, failed_concept_id, failed_entity_refs,
        mode, max_hops, max_per_hop, horizon_hours, iterations, graph_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.organisationId,
      input.ownerId,
      input.name,
      input.failedConceptId,
      input.failedEntityRefs,
      input.mode,
      input.maxHops,
      input.maxPerHop,
      input.horizonHours,
      input.iterations,
      input.graphVersion,
    ],
  );
  return map(rows[0]!);
}

export async function read(db: Executor, id: string): Promise<Scenario | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM scenarios WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}

/**
 * The scenarios this person can ask, owned or shared.
 *
 * ONE QUERY RATHER THAN TWO LISTS. A caller handed "yours" and "shared with
 * you" separately has to merge them to render one screen, and whichever of them
 * forgets is a scenario somebody was given and never saw.
 */
export async function mine(db: Executor, membershipId: string): Promise<Scenario[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM scenarios s
      WHERE s.deleted_at IS NULL
        AND (s.owner_id = $1
             OR EXISTS (SELECT 1 FROM scenario_shares sh
                         WHERE sh.scenario_id = s.id
                           AND sh.membership_id = $1
                           AND sh.revoked_at IS NULL))
      ORDER BY s.created_at DESC`,
    [membershipId],
  );
  return rows.map(map);
}

/**
 * §7 — may this person ask this question.
 *
 * NOT "may they see the answer". §7's marking rule is applied to the runner, so
 * a shared scenario run by somebody with less clearance stops earlier and
 * reports it. The share widens who can ask; it cannot widen what comes back.
 */
export async function readable(
  db: Executor,
  id: string,
  membershipId: string,
): Promise<Scenario | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM scenarios s
      WHERE s.id = $1 AND s.deleted_at IS NULL
        AND (s.owner_id = $2
             OR EXISTS (SELECT 1 FROM scenario_shares sh
                         WHERE sh.scenario_id = s.id
                           AND sh.membership_id = $2
                           AND sh.revoked_at IS NULL))`,
    [id, membershipId],
  );
  return rows[0] ? map(rows[0]) : null;
}

export interface ScenarioShare {
  id: string;
  membershipId: string;
  grantedBy: string;
  grantedAt: Date;
}

export async function share(
  db: Executor,
  input: { id: string; organisationId: string; scenarioId: string; membershipId: string; grantedBy: string },
): Promise<ScenarioShare | null> {
  const { rows } = await db.query<{
    id: string;
    membership_id: string;
    granted_by: string;
    granted_at: Date;
  }>(
    `INSERT INTO scenario_shares (id, organisation_id, scenario_id, membership_id, granted_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id, membership_id, granted_by, granted_at`,
    [input.id, input.organisationId, input.scenarioId, input.membershipId, input.grantedBy],
  );
  return rows[0]
    ? {
        id: rows[0].id,
        membershipId: rows[0].membership_id,
        grantedBy: rows[0].granted_by,
        grantedAt: rows[0].granted_at,
      }
    : null;
}

export async function revokeShare(
  db: Executor,
  input: { scenarioId: string; membershipId: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE scenario_shares SET revoked_at = now()
      WHERE scenario_id = $1 AND membership_id = $2 AND revoked_at IS NULL`,
    [input.scenarioId, input.membershipId],
  );
  return (rowCount ?? 0) > 0;
}

export async function sharesOf(db: Executor, scenarioId: string): Promise<ScenarioShare[]> {
  const { rows } = await db.query<{
    id: string;
    membership_id: string;
    granted_by: string;
    granted_at: Date;
  }>(
    `SELECT id, membership_id, granted_by, granted_at FROM scenario_shares
      WHERE scenario_id = $1 AND revoked_at IS NULL ORDER BY granted_at`,
    [scenarioId],
  );
  return rows.map((row) => ({
    id: row.id,
    membershipId: row.membership_id,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
  }));
}

export async function remove(db: Executor, id: string, ownerId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE scenarios SET deleted_at = now()
      WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
    [id, ownerId],
  );
  return (rowCount ?? 0) > 0;
}
