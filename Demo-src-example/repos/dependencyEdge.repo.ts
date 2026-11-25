import type { Executor } from '../infra/db.infra';

/**
 * Simulation §8 — the graph of what waits on what.
 *
 * A PROPOSAL AND A CONFIRMED EDGE ARE ONE ROW IN TWO STATES, not two tables.
 * §2.3 makes confirming a decision on an existing proposal — "proposals arrive
 * filled in" and a person decides — so the row somebody confirms is the row the
 * machine proposed, and its history stays on it.
 */

export type EdgeKind = 'hard' | 'soft' | 'resource';
export type EdgeSource = 'structure' | 'history' | 'stated';
export type TimeUnit = 'hours' | 'days' | 'weeks';

export interface DependencyEdge {
  id: string;
  fromConceptId: string;
  toConceptId: string;
  kind: EdgeKind | null;
  leadTimeValue: number | null;
  leadTimeUnit: TimeUnit | null;
  bufferValue: number | null;
  bufferUnit: TimeUnit | null;
  /* §3.2 — what proceeding degraded costs. Required on a soft edge, refused on
     every other kind, which the schema enforces. */
  degradedCost: string | null;
  /* §2.1 — how much the upstream thing serves per unit of time. Required on a
     resource edge, refused on every other kind. */
  capacityValue: number | null;
  capacityUnit: TimeUnit | null;
  /**
   * §2.2 — "Every edge records its source, and it travels with every result the
   * edge contributed to."
   *
   * IT DESCRIBES THE LEAD TIME. §2.1 lists a source under the lead time and
   * again under the buffer, and this is one column for both — which is exact
   * rather than sloppy, because a buffer can only ever be stated. Nothing
   * observes how long a downstream thing runs on hand: `transitions` records
   * when a field changed, not what stock was behind it. So an edge reading
   * `history` means its lead time was measured and its buffer, if it has one,
   * was still somebody's number.
   */
  source: EdgeSource;
  evidenceRef: string | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  retiredAt: Date | null;
  version: number;
  proposedAt: Date;
}

type Row = {
  id: string;
  from_concept_id: string;
  to_concept_id: string;
  kind: EdgeKind | null;
  lead_time_value: string | null;
  lead_time_unit: TimeUnit | null;
  buffer_value: string | null;
  buffer_unit: TimeUnit | null;
  degraded_cost: string | null;
  capacity_value: string | null;
  capacity_unit: TimeUnit | null;
  source: EdgeSource;
  evidence_ref: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  retired_at: Date | null;
  version: number;
  proposed_at: Date;
};

const COLUMNS = `id, from_concept_id, to_concept_id, kind, lead_time_value, lead_time_unit,
                 buffer_value, buffer_unit, degraded_cost, capacity_value, capacity_unit,
                 source, evidence_ref,
                 confirmed_by, confirmed_at,
                 retired_at, version, proposed_at`;

const map = (row: Row): DependencyEdge => ({
  id: row.id,
  fromConceptId: row.from_concept_id,
  toConceptId: row.to_concept_id,
  kind: row.kind,
  leadTimeValue: row.lead_time_value === null ? null : Number(row.lead_time_value),
  leadTimeUnit: row.lead_time_unit,
  bufferValue: row.buffer_value === null ? null : Number(row.buffer_value),
  bufferUnit: row.buffer_unit,
  degradedCost: row.degraded_cost,
  capacityValue: row.capacity_value === null ? null : Number(row.capacity_value),
  capacityUnit: row.capacity_unit,
  source: row.source,
  evidenceRef: row.evidence_ref,
  confirmedBy: row.confirmed_by,
  confirmedAt: row.confirmed_at,
  retiredAt: row.retired_at,
  version: row.version,
  proposedAt: row.proposed_at,
});

/**
 * §2.2 — propose a candidate edge from the ontology.
 *
 * AN EDGE THAT ALREADY EXISTS IS LEFT ALONE, and that is the whole reason this
 * is a conditional insert rather than a plain one. Derivation runs again
 * whenever the ontology grows, and overwriting a confirmed edge with a fresh
 * structural proposal would silently un-decide somebody's decision — §2.3 says
 * a confirmation "holds until changed", by a person.
 *
 * A RETIRED EDGE COUNTS AS EXISTING, which the unique index alone would not
 * catch: it covers live rows only, so a retired pair is free to insert into.
 * But retiring is a person saying this dependency is not real, and §2.3's
 * "holds until changed" covers that decision exactly as much as it covers a
 * confirmation. Re-proposing it every time the ontology grows would put a
 * decided question back in somebody's queue forever. The `ON CONFLICT` stays as
 * the backstop for two derivations racing.
 */
export async function propose(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    fromConceptId: string;
    toConceptId: string;
    source: EdgeSource;
    evidenceRef: string | null;
  },
): Promise<DependencyEdge | null> {
  const { rows } = await db.query<Row>(
    `INSERT INTO dependency_edges
       (id, organisation_id, from_concept_id, to_concept_id, source, evidence_ref)
     SELECT $1, $2, $3, $4, $5, $6
      WHERE NOT EXISTS (
        SELECT 1 FROM dependency_edges
         WHERE from_concept_id = $3 AND to_concept_id = $4
      )
     ON CONFLICT DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.id, input.organisationId, input.fromConceptId, input.toConceptId, input.source, input.evidenceRef],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** Everything live, proposals and confirmed alike. The graph screen's list. */
export async function list(db: Executor): Promise<DependencyEdge[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM dependency_edges
      WHERE retired_at IS NULL
      /* Unconfirmed first: they are the work, and §11 says the graph is only
         as good as how much of it somebody has been through. */
      ORDER BY (confirmed_at IS NOT NULL), proposed_at`,
  );
  return rows.map(map);
}

/**
 * §2.2 — an edge a person asserted outright.
 *
 * "Stated by a person. Where no history exists, someone supplies the lead time
 * and the kind."
 *
 * CONFIRMED THE MOMENT IT IS WRITTEN, and that is not a shortcut around §2.3.
 * "No edge is live until a person confirms it" asks for a person's judgement
 * behind every live edge; here the person supplied the judgement and the values
 * in one act, and asking them to confirm their own typing a second time would
 * be ceremony rather than a check.
 *
 * THIS IS THE PATH §1 EXISTS FOR. "Foreign keys state that an invoice points at
 * an order. They do not state that the order waits on the supplier." Structural
 * derivation can only ever propose edges the ontology already implies, so
 * without this the graph could not hold the dependency the spec opens by
 * describing.
 */
export async function state(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    fromConceptId: string;
    toConceptId: string;
    kind: EdgeKind;
    leadTimeValue: number;
    leadTimeUnit: TimeUnit;
    bufferValue: number | null;
    bufferUnit: TimeUnit | null;
    degradedCost: string | null;
    capacityValue: number | null;
    capacityUnit: TimeUnit | null;
    membershipId: string;
  },
): Promise<DependencyEdge> {
  const { rows } = await db.query<Row>(
    `INSERT INTO dependency_edges
       (id, organisation_id, from_concept_id, to_concept_id, kind,
        lead_time_value, lead_time_unit, buffer_value, buffer_unit, degraded_cost,
        capacity_value, capacity_unit, source, confirmed_by, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'stated', $13, now())
     RETURNING ${COLUMNS}`,
    [
      input.id,
      input.organisationId,
      input.fromConceptId,
      input.toConceptId,
      input.kind,
      input.leadTimeValue,
      input.leadTimeUnit,
      input.bufferValue,
      input.bufferUnit,
      input.degradedCost,
      input.capacityValue,
      input.capacityUnit,
      input.membershipId,
    ],
  );
  return map(rows[0]!);
}

/**
 * §2.3 — a person decides, and the edge goes live.
 *
 * THE VERSION DOES NOT MOVE HERE, deliberately. §5 records a graph version on
 * every result so two runs can be told apart, and that version is computed over
 * the CONFIRMED set — an edge entering it changes the graph whatever its own
 * version says. `version` exists to distinguish two states of an edge that was
 * already live, which is what `revise` and `retire` produce.
 *
 * ONLY A LIVE PROPOSAL, enforced in the WHERE rather than checked first.
 * Confirming twice concurrently would otherwise write the second person's
 * judgement over the first with no revision row between them.
 */
export async function confirm(
  db: Executor,
  input: {
    id: string;
    kind: EdgeKind;
    leadTimeValue: number;
    leadTimeUnit: TimeUnit;
    bufferValue: number | null;
    bufferUnit: TimeUnit | null;
    degradedCost: string | null;
    capacityValue: number | null;
    capacityUnit: TimeUnit | null;
    membershipId: string;
  },
): Promise<DependencyEdge | null> {
  const { rows } = await db.query<Row>(
    `UPDATE dependency_edges
        SET kind = $2, lead_time_value = $3, lead_time_unit = $4,
            buffer_value = $5, buffer_unit = $6, degraded_cost = $7,
            capacity_value = $8, capacity_unit = $9,
            confirmed_by = $10, confirmed_at = now()
      WHERE id = $1 AND confirmed_at IS NULL AND retired_at IS NULL
      RETURNING ${COLUMNS}`,
    [
      input.id,
      input.kind,
      input.leadTimeValue,
      input.leadTimeUnit,
      input.bufferValue,
      input.bufferUnit,
      input.degradedCost,
      input.capacityValue,
      input.capacityUnit,
      input.membershipId,
    ],
  );
  return rows[0] ? map(rows[0]) : null;
}

/**
 * §2.3 — "a lead time that was true in March may not be in September".
 *
 * THE VERSION MOVES, and §5 is the reason: "An edge confirmed differently since
 * means the two results are not comparable, and the product says so rather than
 * letting someone compare them." Without the bump, two runs over a silently
 * corrected edge look like the same graph and invite exactly that comparison.
 *
 * DIRECTION IS NOT REVISABLE. An edge pointing the other way is a different
 * assertion about the operation, not a correction to this one, and it belongs
 * in its own row with its own confirmation.
 */
export async function revise(
  db: Executor,
  input: {
    id: string;
    kind: EdgeKind;
    leadTimeValue: number;
    leadTimeUnit: TimeUnit;
    bufferValue: number | null;
    bufferUnit: TimeUnit | null;
    degradedCost: string | null;
    capacityValue: number | null;
    capacityUnit: TimeUnit | null;
    membershipId: string;
  },
): Promise<DependencyEdge | null> {
  const { rows } = await db.query<Row>(
    `UPDATE dependency_edges
        SET kind = $2, lead_time_value = $3, lead_time_unit = $4,
            buffer_value = $5, buffer_unit = $6, degraded_cost = $7,
            capacity_value = $8, capacity_unit = $9,
            confirmed_by = $10, confirmed_at = now(), version = version + 1
      WHERE id = $1 AND confirmed_at IS NOT NULL AND retired_at IS NULL
      RETURNING ${COLUMNS}`,
    [
      input.id,
      input.kind,
      input.leadTimeValue,
      input.leadTimeUnit,
      input.bufferValue,
      input.bufferUnit,
      input.degradedCost,
      input.capacityValue,
      input.capacityUnit,
      input.membershipId,
    ],
  );
  return rows[0] ? map(rows[0]) : null;
}

/**
 * §7 — the third verb `graph.confirm` covers.
 *
 * RETIRED, NEVER DELETED. §5 compares two runs and says whether a difference
 * was "data moving or the graph changing"; a deleted edge makes the second
 * unanswerable, and the results that cited it lose their path.
 */
export async function retire(db: Executor, id: string): Promise<DependencyEdge | null> {
  const { rows } = await db.query<Row>(
    `UPDATE dependency_edges
        SET retired_at = now(), version = version + 1
      WHERE id = $1 AND retired_at IS NULL
      RETURNING ${COLUMNS}`,
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function read(db: Executor, id: string): Promise<DependencyEdge | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM dependency_edges WHERE id = $1 AND retired_at IS NULL`,
    [id],
  );
  return rows[0] ? map(rows[0]) : null;
}

/**
 * §3 — what the walk reads: confirmed, not retired.
 *
 * PROPOSALS ARE ABSENT BY CONSTRUCTION rather than filtered by the caller. A
 * walk that received them and was trusted to skip them is one refactor away
 * from a simulation resting on edges nobody agreed to. §2.3 still requires that
 * a crossed proposal be REPORTED, which is what `proposals` is for.
 */
export async function confirmed(db: Executor): Promise<DependencyEdge[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM dependency_edges
      WHERE confirmed_at IS NOT NULL AND retired_at IS NULL`,
  );
  return rows.map(map);
}

/**
 * §2.3 — "An unconfirmed edge is reported, not ignored."
 *
 * Read separately from the confirmed set so the two can never be concatenated
 * by accident: these have no kind and no lead time, and the only thing a walk
 * may do with one is stop and name it.
 */
export async function proposals(db: Executor): Promise<DependencyEdge[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM dependency_edges
      WHERE confirmed_at IS NULL AND retired_at IS NULL`,
  );
  return rows.map(map);
}

/**
 * §2.2 — fill a proposal's lead time in from what history says.
 *
 * ── A PROPOSAL ONLY, AND THE WHERE CLAUSE IS THE GUARANTEE ────────────────
 *
 * §2.3 — "the decision holds until changed", by a person. A sweep that could
 * move a confirmed lead time would change what every future simulation
 * concludes on a schedule, which is the opposite of that sentence, and it would
 * do it without the revision row §5 needs to say two results are not
 * comparable. So `confirmed_at IS NULL` is in the statement rather than in a
 * check the caller is trusted to have made.
 *
 * THE SOURCE BECOMES `history`, AND THAT IS HALF THE VALUE. §2.2 — "A
 * simulation resting on stated lead times is a different claim from one resting
 * on four hundred observations, and the output must say which." An edge that
 * gained a measured lead time and kept saying `structure` would carry the wrong
 * claim into every result it contributed to.
 */
export async function proposeLeadTime(
  db: Executor,
  input: { id: string; leadTimeValue: number; leadTimeUnit: TimeUnit },
): Promise<DependencyEdge | null> {
  const { rows } = await db.query<Row>(
    `UPDATE dependency_edges
        SET lead_time_value = $2, lead_time_unit = $3, source = 'history'
      WHERE id = $1 AND confirmed_at IS NULL AND retired_at IS NULL
      RETURNING ${COLUMNS}`,
    [input.id, input.leadTimeValue, input.leadTimeUnit],
  );
  return rows[0] ? map(rows[0]) : null;
}
