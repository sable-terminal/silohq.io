import type { Executor } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';
import type {
  Condition,
  OutcomeDesignation,
  OutcomeDirection,
  StoredAssociation,
  StructuralDirection,
  TemporalOrder,
} from '../models/association.model';

/**
 * Associations, and the outcomes a customer has designated.
 *
 * ONE FILE BECAUSE MIGRATION 033 IS ONE MIGRATION, and the two tables answer
 * halves of the same question: what moves with what, and which of those things
 * anybody here has said they care about.
 *
 * `lift` AND `strength` ARE NUMERIC AND ARRIVE AS STRINGS. Coerced in `map`,
 * once — a lift compared as a string sorts "10" before "9", and the comparison
 * that goes wrong is the one nobody writes a test for.
 *
 * NOTHING HERE CAN EXPRESS CAUSATION, and that is the schema's guarantee
 * repeated in code: there is no column to read one out of and no field to map
 * one into. §4.2.
 */

const COLUMNS = `
  id, detector_a, concept_a, measure_a, detector_b, concept_b, measure_b,
  co_occurrence, sample_size, lift, strength, temporal_order, structural_direction
`;

interface Row {
  id: string;
  detector_a: string;
  concept_a: string;
  measure_a: string;
  detector_b: string;
  concept_b: string;
  measure_b: string;
  co_occurrence: number;
  sample_size: number;
  lift: string;
  strength: string;
  temporal_order: TemporalOrder;
  structural_direction: StructuralDirection;
}

function map(row: Row): StoredAssociation {
  return {
    id: row.id,
    a: { detector: row.detector_a, conceptId: row.concept_a, measure: row.measure_a },
    b: { detector: row.detector_b, conceptId: row.concept_b, measure: row.measure_b },
    coOccurrence: row.co_occurrence,
    sampleSize: row.sample_size,
    lift: Number(row.lift),
    strength: Number(row.strength),
    temporalOrder: row.temporal_order,
    structuralDirection: row.structural_direction,
  };
}

/** Everything computed, strongest first. */
export async function list(db: Executor): Promise<StoredAssociation[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM associations ORDER BY lift DESC, strength DESC`,
  );

  return rows.map(map);
}

/**
 * What §5 sends to the model alongside the findings.
 *
 * EITHER SIDE MATCHING IS THE POINT OF THE NARROWING. A ranking about one
 * concept still wants the associations reaching out of it — those are how a
 * finding on it relates to anything else, and requiring both sides inside the
 * narrowing would return only the associations somebody already knew to ask for.
 */
export async function forRanking(
  db: Executor,
  input: { conceptIds: string[] | null; limit: number },
): Promise<StoredAssociation[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS}
       FROM associations
      WHERE ($1::uuid[] IS NULL OR concept_a = ANY($1) OR concept_b = ANY($1))
      ORDER BY lift DESC
      LIMIT $2`,
    [input.conceptIds, input.limit],
  );

  return rows.map(map);
}

/**
 * Clear the associations a recomputation is about to replace.
 *
 * BOTH SIDES, NOT EITHER SIDE. Narrowing to a set of concepts reads only their
 * findings, so an association between one of them and a concept outside the set
 * cannot be recomputed — deleting on `OR` would destroy that row and never put
 * it back. The pairs with both sides inside the set are exactly what the
 * computation can produce, so they are exactly what it may replace.
 */
export async function deleteWithin(db: Executor, conceptIds: string[]): Promise<void> {
  await db.query(
    `DELETE FROM associations WHERE concept_a = ANY($1) AND concept_b = ANY($1)`,
    [conceptIds],
  );
}

/**
 * Write one computed association, replacing whatever stands for that pair.
 *
 * AN UPSERT BECAUSE `deleteWithin` CANNOT BE TRUSTED TO HAVE MATCHED. Two
 * people in one organisation pressing compute at the same time is one
 * transaction each: the first deletes, inserts and commits; the second took its
 * snapshot before that commit, so under READ COMMITTED its DELETE cannot see
 * the rows the first just wrote and removes none of them. A plain INSERT then
 * hits `associations_unique` and the second caller gets a 23505 for asking the
 * same question at the same moment — when both runs read the same findings and
 * therefore computed the same answer.
 *
 * THE CONSTRAINT IS WHAT IDENTIFIES THE FACT, so conflicting on it is the whole
 * fix: 033 made the pair unique precisely so one row means one statement about
 * one pair, and `findings` and `outcome_designations` already say "the same
 * thing, written again, is the same row" the same way. A per-organisation
 * advisory lock would also serialise the two, at the price of a second caller
 * holding a pool connection asleep for the whole of the first caller's compute
 * — a queue on the connection pool to prevent a collision the row itself can
 * absorb.
 *
 * `RETURNING id` RATHER THAN THE GENERATED ONE, because on a conflict the row
 * keeps the id it already had, and the caller reports that id to whoever asked.
 */
export async function insert(
  db: Executor,
  input: {
    organisationId: string;
    a: Condition;
    b: Condition;
    coOccurrence: number;
    sampleSize: number;
    lift: number;
    strength: number;
    temporalOrder: TemporalOrder;
    structuralDirection: StructuralDirection;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO associations
       (id, organisation_id,
        detector_a, concept_a, measure_a,
        detector_b, concept_b, measure_b,
        co_occurrence, sample_size, lift, strength,
        temporal_order, structural_direction)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (organisation_id, detector_a, concept_a, measure_a,
                  detector_b, concept_b, measure_b)
     DO UPDATE SET co_occurrence = EXCLUDED.co_occurrence,
                   sample_size = EXCLUDED.sample_size,
                   lift = EXCLUDED.lift,
                   strength = EXCLUDED.strength,
                   temporal_order = EXCLUDED.temporal_order,
                   structural_direction = EXCLUDED.structural_direction,
                   computed_at = now()
     RETURNING id`,
    [
      generateId(),
      input.organisationId,
      input.a.detector,
      input.a.conceptId,
      input.a.measure,
      input.b.detector,
      input.b.conceptId,
      input.b.measure,
      input.coOccurrence,
      input.sampleSize,
      input.lift,
      input.strength,
      input.temporalOrder,
      input.structuralDirection,
    ],
  );

  return rows[0]!.id;
}

/* ── §4.3 Outcome designations ───────────────────────────────────────────── */

const DESIGNATION_COLUMNS = `
  id, organisation_id, concept_id, field_path, direction, label,
  designated_by, designated_at, retired_at
`;

interface DesignationRow {
  id: string;
  organisation_id: string;
  concept_id: string;
  field_path: string;
  direction: OutcomeDirection;
  label: string | null;
  designated_by: string;
  designated_at: Date;
  retired_at: Date | null;
}

function mapDesignation(row: DesignationRow): OutcomeDesignation {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    conceptId: row.concept_id,
    fieldPath: row.field_path,
    direction: row.direction,
    label: row.label,
    designatedBy: row.designated_by,
    designatedAt: row.designated_at,
    retiredAt: row.retired_at,
  };
}

/**
 * The designation standing against one field, retired or not.
 *
 * RETIRED ROWS COME BACK TOO, and they have to. `outcome_designations_unique`
 * covers them, so a retired row is still the row an insert will collide with —
 * a lookup that hid it would report "nothing designated" right up until the
 * write failed.
 */
export async function readDesignation(
  db: Executor,
  input: { conceptId: string; fieldPath: string },
): Promise<OutcomeDesignation | null> {
  const { rows } = await db.query<DesignationRow>(
    `SELECT ${DESIGNATION_COLUMNS} FROM outcome_designations
      WHERE concept_id = $1 AND field_path = $2`,
    [input.conceptId, input.fieldPath],
  );

  const row = rows[0];
  return row ? mapDesignation(row) : null;
}

/** The live designation on one field, if there is one. */
export async function liveDesignation(
  db: Executor,
  input: { conceptId: string; fieldPath: string },
): Promise<OutcomeDesignation | null> {
  const { rows } = await db.query<DesignationRow>(
    `SELECT ${DESIGNATION_COLUMNS} FROM outcome_designations
      WHERE concept_id = $1 AND field_path = $2 AND retired_at IS NULL`,
    [input.conceptId, input.fieldPath],
  );

  const row = rows[0];
  return row ? mapDesignation(row) : null;
}

/**
 * Every designation that still stands.
 *
 * `retired_at IS NULL` IS NOT AN ACCESS RULE. A retired designation is not one
 * somebody is being kept away from — it is one that no longer says anything
 * about what matters here, and ranking against it would order findings by a
 * statement the customer has withdrawn.
 */
export async function liveDesignations(db: Executor): Promise<OutcomeDesignation[]> {
  const { rows } = await db.query<DesignationRow>(
    `SELECT ${DESIGNATION_COLUMNS} FROM outcome_designations
      WHERE retired_at IS NULL
      ORDER BY designated_at DESC`,
  );

  return rows.map(mapDesignation);
}

/**
 * Write a designation, replacing whatever stood against that field.
 *
 * IT DOES NOT CHECK WHETHER ONE ALREADY STANDS. Re-declaring what is already
 * there is nearly always somebody who did not realise, and whether that is a
 * refusal or a no-op is a question about the caller — so the service reads
 * first, decides, and this writes what it decided.
 */
export async function upsertDesignation(
  db: Executor,
  input: {
    organisationId: string;
    conceptId: string;
    fieldPath: string;
    direction: OutcomeDirection;
    label: string | null;
    designatedBy: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO outcome_designations
       (id, organisation_id, concept_id, field_path, direction, label, designated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (organisation_id, concept_id, field_path)
     DO UPDATE SET direction = EXCLUDED.direction,
                   label = EXCLUDED.label,
                   designated_by = EXCLUDED.designated_by,
                   designated_at = now(),
                   retired_at = NULL`,
    [
      generateId(),
      input.organisationId,
      input.conceptId,
      input.fieldPath,
      input.direction,
      input.label,
      input.designatedBy,
    ],
  );
}

/**
 * Take a designation back.
 *
 * RETIRED, NEVER DELETED, and false rather than an error when nothing moved —
 * whether that is a 404 or a shrug is the service's question.
 */
export async function retireDesignation(db: Executor, designationId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE outcome_designations SET retired_at = now()
      WHERE id = $1 AND retired_at IS NULL`,
    [designationId],
  );

  return Boolean(rowCount);
}
