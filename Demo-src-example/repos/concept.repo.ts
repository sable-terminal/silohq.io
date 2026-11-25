import type { Executor } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';
import type {
  Concept,
  ConceptChange,
  ConceptRelationship,
  ConceptOrigin,
  ConceptProposal,
  ConceptRevision,
  ContributingObject,
  ProposalDecision,
} from '../models/concept.model';

/**
 * Concepts, their contributing objects, proposals and unresolved pairs.
 *
 * SQL AND THE ROW-TO-MODEL MAPPING. Nothing decides anything here: whether
 * somebody may confirm a concept, whether two objects are enough to resolve
 * against each other, and whether a name is already taken are all judgements,
 * and they live in the service.
 *
 * THE `retired_at IS NULL` PREDICATES ARE NOT PERMISSION CHECKS. A retired
 * concept is not a concept somebody is being kept away from — it is one that no
 * longer describes anything, and a query returning it would be wrong rather
 * than merely over-permissive. That is the line `repos/README.md` draws.
 */

const CONCEPT_COLUMNS = `
  id, organisation_id, name, origin, proposal_id, confirmed_by, confirmed_at, retired_at
`;

interface ConceptRow {
  id: string;
  organisation_id: string;
  name: string;
  origin: ConceptOrigin;
  proposal_id: string | null;
  confirmed_by: string;
  confirmed_at: Date;
  retired_at: Date | null;
}

interface ObjectRow {
  concept_id: string;
  connection_id: string;
  object_name: string;
  identifier_field: string;
  match_keys: string[];
  field_map: Record<string, string>;
}

function mapObject(row: ObjectRow): ContributingObject {
  return {
    connectionId: row.connection_id,
    objectName: row.object_name,
    identifierField: row.identifier_field,
    matchKeys: row.match_keys,
    /* Defaulted in 055, so a row written before it reads as an empty map
       rather than as undefined reaching the planner. */
    fieldMap: row.field_map ?? {},
  };
}

function mapConcept(row: ConceptRow, objects: ContributingObject[]): Concept {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    name: row.name,
    origin: row.origin,
    proposalId: row.proposal_id,
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at,
    retiredAt: row.retired_at,
    objects,
  };
}

/* ── Concepts ────────────────────────────────────────────────────────────── */

/**
 * One concept with its objects.
 *
 * NULL RATHER THAN THROWING. A repo that threw `notFound` would be deciding
 * what a missing row means to a caller, and "no such concept" reads differently
 * on a read than it does midway through a confirmation.
 */
export async function read(db: Executor, conceptId: string): Promise<Concept | null> {
  const { rows } = await db.query<ConceptRow>(
    `SELECT ${CONCEPT_COLUMNS} FROM concepts WHERE id = $1`,
    [conceptId],
  );

  const row = rows[0];
  if (!row) return null;

  return mapConcept(row, await objectsOf(db, conceptId));
}

async function objectsOf(db: Executor, conceptId: string): Promise<ContributingObject[]> {
  const { rows } = await db.query<ObjectRow>(
    `SELECT concept_id, connection_id, object_name, identifier_field, match_keys, field_map
       FROM concept_objects WHERE concept_id = $1 ORDER BY object_name`,
    [conceptId],
  );

  return rows.map(mapObject);
}

/**
 * Every live concept, objects included.
 *
 * ONE QUERY FOR THE OBJECTS, NOT ONE PER CONCEPT. The previous version read
 * each concept in its own round trip inside a `Promise.all`, which is N+1
 * requests against a pool of ten for a list that is usually one screen.
 */
export async function listLive(db: Executor): Promise<Concept[]> {
  const concepts = await db.query<ConceptRow>(
    `SELECT ${CONCEPT_COLUMNS} FROM concepts WHERE retired_at IS NULL ORDER BY name`,
  );

  if (concepts.rows.length === 0) return [];

  const objects = await db.query<ObjectRow>(
    `SELECT co.concept_id, co.connection_id, co.object_name, co.identifier_field, co.match_keys, co.field_map
       FROM concept_objects co
       JOIN concepts c ON c.id = co.concept_id
      WHERE c.retired_at IS NULL
      ORDER BY co.object_name`,
  );

  const byConcept = new Map<string, ContributingObject[]>();
  for (const row of objects.rows) {
    byConcept.set(row.concept_id, [...(byConcept.get(row.concept_id) ?? []), mapObject(row)]);
  }

  return concepts.rows.map((row) => mapConcept(row, byConcept.get(row.id) ?? []));
}

/** Live concepts by that name. The service decides what a clash means. */
export async function findLiveByName(db: Executor, name: string): Promise<Concept | null> {
  const { rows } = await db.query<ConceptRow>(
    `SELECT ${CONCEPT_COLUMNS} FROM concepts WHERE name = $1 AND retired_at IS NULL`,
    [name],
  );

  const row = rows[0];
  return row ? mapConcept(row, await objectsOf(db, row.id)) : null;
}

export async function insertConcept(
  db: Executor,
  input: {
    organisationId: string;
    name: string;
    origin: ConceptOrigin;
    proposalId: string | null;
    confirmedBy: string;
    objects: ContributingObject[];
  },
): Promise<Concept> {
  const conceptId = generateId();

  await db.query(
    `INSERT INTO concepts (id, organisation_id, name, proposal_id, origin, confirmed_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      conceptId,
      input.organisationId,
      input.name,
      input.proposalId,
      input.origin,
      input.confirmedBy,
    ],
  );

  await insertObjects(db, {
    conceptId,
    organisationId: input.organisationId,
    objects: input.objects,
    addedBy: input.confirmedBy,
  });

  const created = await read(db, conceptId);
  if (!created) throw new Error(`Concept ${conceptId} vanished between write and read`);
  return created;
}

/**
 * Write a concept's contributing objects in one statement.
 *
 * `jsonb_to_recordset`, NOT PARALLEL ARRAYS, AND THE REASON IS A BUG I SHIPPED
 * TODAY. The first version passed four arrays to `unnest`, the last of them
 * `text[][]` for the match keys — and Postgres FLATTENS a multidimensional
 * array. Two objects with two keys each came out as four scalar rows, two of
 * them with a null connection, and `match_keys` arrived as `text` where the
 * column wants `text[]`. Every confirmation would have failed at runtime.
 *
 * Nothing caught it because the database-backed suites skip without
 * `TEST_APP_DATABASE_URL`, which is the same reason a fourteen-parameter insert
 * against twelve placeholders shipped last week. A statement whose shape cannot
 * be checked by the type system has to be checked against Postgres.
 *
 * `jsonb_array_elements_text` PRESERVES ORDER, which §2.5 depends on: match
 * keys are ordered because the first that matches decides.
 */
async function insertObjects(
  db: Executor,
  input: {
    conceptId: string;
    organisationId: string;
    objects: ContributingObject[];
    addedBy: string;
  },
): Promise<void> {
  if (input.objects.length === 0) return;

  await db.query(
    `INSERT INTO concept_objects
       (id, concept_id, organisation_id, connection_id, object_name,
        identifier_field, match_keys, added_by, field_map)
     SELECT gen_random_uuid(), $1, $2, o.connection_id, o.object_name, o.identifier_field,
            ARRAY(SELECT jsonb_array_elements_text(o.match_keys)), $3, o.field_map
       FROM jsonb_to_recordset($4::jsonb)
         AS o(connection_id uuid, object_name text, identifier_field text,
              match_keys jsonb, field_map jsonb)
     ON CONFLICT (concept_id, connection_id)
     /*
      * A CONNECTION THAT STAYED IS UPDATED, NOT REPLACED. The row keeps its id,
      * so the field authorities that reference it survive a correction that had
      * nothing to do with them.
      */
     DO UPDATE SET object_name = EXCLUDED.object_name,
                   identifier_field = EXCLUDED.identifier_field,
                   match_keys = EXCLUDED.match_keys,
                   field_map = EXCLUDED.field_map`,
    [
      input.conceptId,
      input.organisationId,
      input.addedBy,
      JSON.stringify(
        input.objects.map((object) => ({
          connection_id: object.connectionId,
          object_name: object.objectName.trim(),
          identifier_field: object.identifierField.trim(),
          match_keys: object.matchKeys.map((key) => key.trim()),
          field_map: object.fieldMap ?? {},
        })),
      ),
    ],
  );
}

/**
 * Every live concept's objects, flat.
 *
 * FOR THE LAYERS THAT WALK CONCEPTS RATHER THAN READ ONE. Derivation needs to
 * know what is already confirmed, associations need concept-to-concept edges
 * and maps need to know what a person can reach — all of which want the whole
 * set once, not a concept at a time.
 */
export async function liveContributions(
  db: Executor,
): Promise<Array<ContributingObject & { conceptId: string }>> {
  const { rows } = await db.query<ObjectRow>(
    `SELECT co.concept_id, co.connection_id, co.object_name, co.identifier_field, co.match_keys, co.field_map
       FROM concept_objects co
       JOIN concepts c ON c.id = co.concept_id
      WHERE c.retired_at IS NULL`,
  );

  return rows.map((row) => ({ ...mapObject(row), conceptId: row.concept_id }));
}

/* ── Proposals ───────────────────────────────────────────────────────────── */

const PROPOSAL_COLUMNS = `
  id, organisation_id, proposed_name, contributing, evidence, confidence,
  decision, reviewed_by, reviewed_at, concept_id, proposed_at
`;

interface ProposalRow {
  id: string;
  organisation_id: string;
  proposed_name: string;
  contributing: ContributingObject[] | null;
  evidence: Record<string, unknown> | null;
  /** `numeric` arrives as a string; the coercion belongs here, once. */
  confidence: string | null;
  decision: ProposalDecision | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  concept_id: string | null;
  proposed_at: Date;
}

function mapProposal(row: ProposalRow): ConceptProposal {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    proposedName: row.proposed_name,
    contributing: row.contributing ?? [],
    evidence: row.evidence ?? {},
    confidence: row.confidence === null ? null : Number(row.confidence),
    decision: row.decision,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    conceptId: row.concept_id,
    proposedAt: row.proposed_at,
  };
}

export async function readProposal(db: Executor, id: string): Promise<ConceptProposal | null> {
  const { rows } = await db.query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM concept_proposals WHERE id = $1`,
    [id],
  );

  const row = rows[0];
  return row ? mapProposal(row) : null;
}

export async function openProposals(db: Executor): Promise<ConceptProposal[]> {
  const { rows } = await db.query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM concept_proposals
      WHERE reviewed_at IS NULL
      ORDER BY confidence DESC NULLS LAST, proposed_name`,
  );

  return rows.map(mapProposal);
}

/**
 * What a person has said is NOT one thing, as the objects it would have spanned.
 *
 * A proposal somebody rejected, and a concept Silo learned that somebody then
 * retired. Either is a person's answer to "are these the same", and Silo does
 * not go on to decide the same question again for itself.
 */
export async function declined(db: Executor): Promise<ContributingObject[][]> {
  const { rows } = await db.query<{ contributing: ContributingObject[] | null }>(
    `SELECT p.contributing
       FROM concept_proposals p
       LEFT JOIN concepts c ON c.id = p.concept_id
      WHERE p.decision = 'rejected'
         OR (p.decision = 'learned' AND c.retired_at IS NOT NULL)`,
  );

  return rows.map((row) => row.contributing ?? []);
}

export async function insertProposal(
  db: Executor,
  input: {
    organisationId: string;
    proposedName: string;
    contributing: ContributingObject[];
    evidence: Record<string, unknown>;
    confidence: number;
  },
): Promise<string> {
  const id = generateId();

  await db.query(
    `INSERT INTO concept_proposals
       (id, organisation_id, proposed_name, contributing, evidence, confidence)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      input.organisationId,
      input.proposedName,
      JSON.stringify(input.contributing),
      JSON.stringify(input.evidence),
      input.confidence,
    ],
  );

  return id;
}

/**
 * Record a decision on a proposal.
 *
 * IT DOES NOT CHECK WHETHER ONE WAS ALREADY MADE. `WHERE reviewed_at IS NULL`
 * here would silently do nothing on a second decision and return the same
 * success as the first — so the service reads the proposal, decides, and this
 * writes what it decided.
 */
export async function decideProposal(
  db: Executor,
  input: {
    id: string;
    decision: ProposalDecision;
    reviewedBy: string;
    conceptId: string | null;
  },
): Promise<void> {
  await db.query(
    `UPDATE concept_proposals
        SET decision = $2, reviewed_by = $3, reviewed_at = now(), concept_id = $4
      WHERE id = $1`,
    [input.id, input.decision, input.reviewedBy, input.conceptId],
  );
}

/* ── Lifecycle ───────────────────────────────────────────────────────────── */

/**
 * Rename a live concept.
 *
 * `WHERE retired_at IS NULL` IS NOT A PERMISSION CHECK. Renaming a retired
 * concept would produce a row that disagrees with every revision recorded
 * against it, and `concepts_name_live` would let it happen because a retired
 * name is outside the partial index. The predicate is here because the
 * statement would otherwise be wrong.
 */
export async function rename(db: Executor, conceptId: string, name: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE concepts SET name = $2 WHERE id = $1 AND retired_at IS NULL`,
    [conceptId, name],
  );
  return Boolean(rowCount);
}

export async function retire(db: Executor, conceptId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE concepts SET retired_at = now() WHERE id = $1 AND retired_at IS NULL`,
    [conceptId],
  );
  return Boolean(rowCount);
}

/**
 * Replace a concept's contributing objects wholesale.
 *
 * DELETE THEN INSERT, IN ONE TRANSACTION, RATHER THAN A DIFF. A diff has to
 * decide what "the same object" means across a change of connection or object
 * name, and gets it wrong precisely when somebody is repointing a concept at a
 * renamed table — which is the common correction. The revision row is what
 * preserves the old set, so nothing is lost by replacing it.
 */
export async function replaceObjects(
  db: Executor,
  input: {
    conceptId: string;
    organisationId: string;
    objects: ContributingObject[];
    addedBy: string;
  },
): Promise<void> {
  /*
   * ── ONLY THE CONNECTIONS THAT ACTUALLY LEFT ──────────────────────────────
   *
   * This used to delete every row and reinsert, which looks equivalent and is
   * not: `field_authorities` references `concept_objects (concept_id,
   * connection_id)` with ON DELETE CASCADE, so wiping the set wiped every
   * authority the organisation had declared for the concept — including for
   * systems the correction did not touch.
   *
   * Somebody changing a match key would silently lose the statement of which
   * system is right about every field, with nothing recording that it happened
   * and every later answer quietly reverting to `disputed`.
   *
   * CASCADING FOR A CONNECTION GENUINELY REMOVED IS CORRECT and 053 says so: an
   * authority naming a system that no longer contributes is a rule that can
   * never fire. The bug was cascading for the ones that stayed.
   */
  await db.query(
    `DELETE FROM concept_objects
      WHERE concept_id = $1 AND NOT (connection_id = ANY($2::uuid[]))`,
    [input.conceptId, input.objects.map((object) => object.connectionId)],
  );

  await insertObjects(db, input);
}

/* ── Revisions ───────────────────────────────────────────────────────────── */

export async function recordRevision(
  db: Executor,
  input: {
    organisationId: string;
    conceptId: string;
    change: ConceptChange;
    previousState: Record<string, unknown>;
    newState: Record<string, unknown>;
    reason: string | null;
    changedBy: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO concept_revisions
       (id, organisation_id, concept_id, change, previous_state, new_state, reason, changed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      generateId(),
      input.organisationId,
      input.conceptId,
      input.change,
      JSON.stringify(input.previousState),
      JSON.stringify(input.newState),
      input.reason,
      input.changedBy,
    ],
  );
}

export async function revisionsOf(db: Executor, conceptId: string): Promise<ConceptRevision[]> {
  const { rows } = await db.query<{
    id: string;
    concept_id: string;
    change: ConceptChange;
    previous_state: Record<string, unknown> | null;
    new_state: Record<string, unknown> | null;
    reason: string | null;
    changed_by: string;
    changed_at: Date;
  }>(
    `SELECT id, concept_id, change, previous_state, new_state, reason, changed_by, changed_at
       FROM concept_revisions WHERE concept_id = $1 ORDER BY changed_at DESC`,
    [conceptId],
  );

  return rows.map((row) => ({
    id: row.id,
    conceptId: row.concept_id,
    change: row.change,
    previousState: row.previous_state ?? {},
    newState: row.new_state ?? {},
    reason: row.reason,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
  }));
}

/* ── §4.1 Relationships ──────────────────────────────────────────────────── */

interface RelationshipRow {
  id: string;
  organisation_id: string;
  from_concept_id: string;
  to_concept_id: string;
  connection_id: string;
  from_object: string;
  from_field: string;
  to_object: string;
  to_field: string;
  origin: 'derived' | 'confirmed';
  confirmed_by: string | null;
  recorded_at: Date;
}

function mapRelationship(row: RelationshipRow): ConceptRelationship {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    fromConceptId: row.from_concept_id,
    toConceptId: row.to_concept_id,
    connectionId: row.connection_id,
    fromObject: row.from_object,
    fromField: row.from_field,
    toObject: row.to_object,
    toField: row.to_field,
    origin: row.origin,
    confirmedBy: row.confirmed_by,
    recordedAt: row.recorded_at,
  };
}

export async function relationships(db: Executor): Promise<ConceptRelationship[]> {
  const { rows } = await db.query<RelationshipRow>(
    `SELECT id, organisation_id, from_concept_id, to_concept_id, connection_id,
            from_object, from_field, to_object, to_field, origin, confirmed_by, recorded_at
       FROM concept_relationships
      ORDER BY from_concept_id, to_concept_id, connection_id, from_field`,
  );
  return rows.map(mapRelationship);
}

/**
 * Replace every DERIVED relationship with what the manifests currently declare.
 *
 * DERIVED ONLY. A relationship somebody confirmed by hand describes a source
 * whose schema states no constraint even though the link is real — most CSV and
 * REST sources — and re-deriving would delete it every time anybody confirmed a
 * concept. `origin` is what makes the two separable, which is most of why the
 * column exists.
 *
 * REPLACE RATHER THAN MERGE, because a correction that repoints a concept at a
 * different object must be able to REMOVE a relationship, and a merge can only
 * add. The set is small and bounded by the manifests.
 */
export async function replaceDerivedRelationships(
  db: Executor,
  organisationId: string,
  found: ReadonlyArray<{
    fromConceptId: string;
    toConceptId: string;
    connectionId: string;
    fromObject: string;
    fromField: string;
    toObject: string;
    toField: string;
  }>,
): Promise<number> {
  await db.query(`DELETE FROM concept_relationships WHERE origin = 'derived'`);

  if (found.length === 0) return 0;

  const { rowCount } = await db.query(
    `INSERT INTO concept_relationships
       (id, organisation_id, from_concept_id, to_concept_id, connection_id,
        from_object, from_field, to_object, to_field, origin)
     SELECT gen_random_uuid(), $1, r.from_concept_id, r.to_concept_id, r.connection_id,
            r.from_object, r.from_field, r.to_object, r.to_field, 'derived'
       FROM jsonb_to_recordset($2::jsonb)
         AS r(from_concept_id uuid, to_concept_id uuid, connection_id uuid,
              from_object text, from_field text, to_object text, to_field text)
     ON CONFLICT (from_concept_id, to_concept_id, connection_id, from_field) DO NOTHING`,
    [
      organisationId,
      JSON.stringify(
        found.map((one) => ({
          from_concept_id: one.fromConceptId,
          to_concept_id: one.toConceptId,
          connection_id: one.connectionId,
          from_object: one.fromObject,
          from_field: one.fromField,
          to_object: one.toObject,
          to_field: one.toField,
        })),
      ),
    ],
  );

  return rowCount ?? 0;
}
