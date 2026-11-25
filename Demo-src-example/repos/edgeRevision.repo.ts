import type { Executor } from '../infra/db.infra';
import type { EdgeKind, TimeUnit } from './dependencyEdge.repo';

/**
 * Simulation §8 — "edge_revisions — edge, previous state, new state, reason,
 * revised by, revised at."
 *
 * The row §5 rests on: "An edge confirmed differently since means the two
 * results are not comparable, and the product says so rather than letting
 * someone compare them."
 */

export type EdgeChange = 'confirmed' | 'revised' | 'retired';

/**
 * The substantive state of an edge — what a revision replaces.
 *
 * NO IDENTIFIERS AND NO ENTITIES. A kind, two durations and whether it was
 * live. Which edge it was is the `edge_id` column, and who decided is
 * `revised_by`; duplicating either into the snapshot would make two places to
 * look and one of them eventually wrong.
 */
export interface EdgeState {
  kind: EdgeKind | null;
  leadTimeValue: number | null;
  leadTimeUnit: TimeUnit | null;
  bufferValue: number | null;
  bufferUnit: TimeUnit | null;
  degradedCost: string | null;
  capacityValue: number | null;
  capacityUnit: TimeUnit | null;
  retired: boolean;
}

export interface EdgeRevision {
  id: string;
  edgeId: string;
  change: EdgeChange;
  previousState: EdgeState | null;
  newState: EdgeState;
  reason: string | null;
  revisedBy: string;
  revisedAt: Date;
}

type Row = {
  id: string;
  edge_id: string;
  change: EdgeChange;
  previous_state: EdgeState | null;
  new_state: EdgeState;
  reason: string | null;
  revised_by: string;
  revised_at: Date;
};

const map = (row: Row): EdgeRevision => ({
  id: row.id,
  edgeId: row.edge_id,
  change: row.change,
  previousState: row.previous_state,
  newState: row.new_state,
  reason: row.reason,
  revisedBy: row.revised_by,
  revisedAt: row.revised_at,
});

export async function record(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    edgeId: string;
    change: EdgeChange;
    previousState: EdgeState | null;
    newState: EdgeState;
    reason: string | null;
    revisedBy: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO edge_revisions
       (id, organisation_id, edge_id, change, previous_state, new_state, reason, revised_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.organisationId,
      input.edgeId,
      input.change,
      input.previousState === null ? null : JSON.stringify(input.previousState),
      JSON.stringify(input.newState),
      input.reason,
      input.revisedBy,
    ],
  );
}

/** Newest first: what an edge says now, and what it said before. */
export async function forEdge(db: Executor, edgeId: string): Promise<EdgeRevision[]> {
  const { rows } = await db.query<Row>(
    `SELECT id, edge_id, change, previous_state, new_state, reason, revised_by, revised_at
       FROM edge_revisions
      WHERE edge_id = $1
      ORDER BY revised_at DESC, id`,
    [edgeId],
  );
  return rows.map(map);
}
