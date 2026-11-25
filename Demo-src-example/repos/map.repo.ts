import type { Executor } from '../infra/db.infra';
import type { MapElement } from '../engine/analysis/maps.analysis';
import type { MapAccess, MapRecord, MapShare, ThresholdOrigin } from '../models/map.model';
import { generateId } from '../utils/tokens.util';

/**
 * §6 — maps, their shares, and the three tables that hold what a map has
 * learned.
 *
 * SQL AND THE ROW-TO-MODEL MAPPING. Every judgement a map involves is somebody
 * else's: whether a missing row is a 404, whether the organisation's sharing
 * policy permits a grantee, and — the important one — whether the person
 * opening a map can reach what it points at. That last is §6.4 and it lives in
 * `engine/maps.resolveFor` fed by the service, deliberately, because a map that
 * resolved itself in here would resolve with whatever reach the caller happened
 * to have loaded.
 *
 * THE SHARE PREDICATES ARE NOT AN ACCESS CHECK IN A REPO, THEY ARE THE JOIN.
 * `listVisibleTo` and `findOpenable` below carry a `map_shares` join with
 * revocation and expiry in it. The service cannot lift that out: "which maps
 * has somebody been given" is a set that only exists as a query, and computing
 * it by reading every map and every share into memory to intersect them is the
 * same rule written slower. What the service keeps is what to DO about the
 * answer — the not-found, the policy refusal, and the re-resolution against the
 * opener that stops a share becoming an escalation.
 *
 * `MapElement` COMES FROM `engine/maps` AND THE IMPORT IS TYPE-ONLY. It is the
 * shape the engine's arithmetic consumes and there is one definition of it;
 * a second copy in the model would be two shapes waiting to disagree about what
 * a link is. Nothing is imported at runtime, so the engine's rule that it
 * reaches nothing is untouched.
 */

/* ── maps ────────────────────────────────────────────────────────────────── */

const COLUMNS = `
  id, organisation_id, owner_membership_id, name, active, forked_from,
  created_at, archived_at
`;

/**
 * The same list qualified for the reads that join `map_shares`.
 *
 * DERIVED FROM `COLUMNS` RATHER THAN WRITTEN BESIDE IT, so a column added to
 * one cannot go missing from the other. Both `SELECT DISTINCT`s below are over
 * columns of `m` alone with the primary key among them, so the duplicate rows a
 * share join produces are identical tuples and widening the list does not
 * change what `DISTINCT` collapses.
 */
const QUALIFIED = COLUMNS.split(',')
  .map((column) => `m.${column.trim()}`)
  .join(', ');

interface Row {
  id: string;
  organisation_id: string;
  owner_membership_id: string;
  name: string;
  active: boolean;
  forked_from: string | null;
  created_at: Date;
  archived_at: Date | null;
}

function map(row: Row): MapRecord {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    ownerMembershipId: row.owner_membership_id,
    name: row.name,
    active: row.active,
    forkedFrom: row.forked_from,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

export async function read(db: Executor, mapId: string): Promise<MapRecord | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM maps WHERE id = $1`, [mapId]);
  return rows[0] ? map(rows[0]) : null;
}

/**
 * The map this membership's work goes into.
 *
 * `ORDER BY active DESC` AND NOT `WHERE active`. A person who archived the map
 * that was their default has live maps and no active one, and a query that
 * insisted on the flag would make the next dismissal create a second map rather
 * than land in the one they are using. The ordering is what makes "the default,
 * or failing that the oldest" one statement.
 *
 * `archived_at IS NULL` IS HERE FOR CORRECTNESS, NOT ACCESS. Writing learning
 * into an archived map is writing it where nothing will read it.
 */
export async function activeFor(db: Executor, membershipId: string): Promise<MapRecord | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM maps
      WHERE owner_membership_id = $1 AND archived_at IS NULL
      ORDER BY active DESC, created_at
      LIMIT 1`,
    [membershipId],
  );

  return rows[0] ? map(rows[0]) : null;
}

/**
 * The map created on first use. Returns its id, whoever created it.
 *
 * AN UPSERT BECAUSE TWO OF SOMEBODY'S FIRST ACTIONS ARRIVE AT ONCE. The caller
 * looks for a live map before calling this, and that read-then-write is not
 * atomic: a double-clicked dismissal, or a dismissal and a detector run
 * recording a threshold, both see no map and both insert. Plain inserts leave
 * the second raising a raw constraint violation on a path the person did not
 * ask about — and it is every new user's second action. `ON CONFLICT` makes the
 * loser wait for the winner's row and read its id back, so two racing callers
 * end with one map and the same answer.
 *
 * `maps_name_unique` IS THE ARBITER, NOT `maps_one_active`. The second is
 * partial, so inferring it means repeating `WHERE active AND archived_at IS
 * NULL` in the statement — and worse, it only recognises rows that are still
 * live and still flagged, which is the wrong key: what makes a second default
 * impossible is the NAME, unique per owner across archived rows too. Conflicting
 * on it matches this person's default map in whatever state it is in.
 *
 * WHICH IS WHY THE UPDATE REVIVES IT. Reaching here at all means the owner has
 * no live map — `activeFor` returns any of them, active or not — so an archived
 * `Default` is the only map they have, and handing its id back untouched would
 * write learning somewhere nothing will ever read. It is not resurrected over a
 * map they are using: if one existed, this statement never ran.
 */
export async function insertDefault(
  db: Executor,
  input: { organisationId: string; ownerMembershipId: string },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO maps (id, organisation_id, owner_membership_id, name, active)
     VALUES ($1, $2, $3, 'Default', true)
     ON CONFLICT ON CONSTRAINT maps_name_unique
     DO UPDATE SET active = true, archived_at = NULL
     RETURNING id`,
    [generateId(), input.organisationId, input.ownerMembershipId],
  );

  const row = rows[0];
  if (!row) {
    /* `DO UPDATE` returns a row on both paths; no row means the statement did
       something this mapping cannot account for. */
    throw new Error(`Default map for ${input.ownerMembershipId} returned no row from upsert`);
  }

  return row.id;
}

export async function insert(
  db: Executor,
  input: {
    organisationId: string;
    ownerMembershipId: string;
    name: string;
    forkedFrom: string | null;
  },
): Promise<string> {
  const id = generateId();

  await db.query(
    `INSERT INTO maps (id, organisation_id, owner_membership_id, name, forked_from)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, input.organisationId, input.ownerMembershipId, input.name, input.forkedFrom],
  );

  return id;
}

/**
 * Mine, plus what was shared with me.
 *
 * THE THREE GRANTEES ARE `connection_grants`', because it is the same question
 * and two answers to it in one database is how a permission bug hides: a
 * membership by name, a scope this person belongs to, or the whole
 * organisation.
 */
export async function listVisibleTo(db: Executor, membershipId: string): Promise<MapRecord[]> {
  const { rows } = await db.query<Row>(
    `SELECT DISTINCT ${QUALIFIED}
       FROM maps m
  LEFT JOIN map_shares s
             ON s.map_id = m.id
            AND s.revoked_at IS NULL
            AND (s.expires_at IS NULL OR s.expires_at > now())
      WHERE m.archived_at IS NULL
        AND (
          m.owner_membership_id = $1
          OR s.organisation_wide
          OR s.membership_id = $1
          OR EXISTS (
            SELECT 1
              FROM scope_memberships sm
              JOIN scopes mine ON mine.id = sm.scope_id
             WHERE sm.membership_id = $1 AND mine.id = s.scope_id
          )
        )
      ORDER BY m.created_at`,
    [membershipId],
  );

  return rows.map(map);
}

/** Owned by this membership and still live. Null is the service's to interpret. */
export async function findOwned(
  db: Executor,
  input: { mapId: string; ownerMembershipId: string },
): Promise<MapRecord | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM maps
      WHERE id = $1 AND owner_membership_id = $2 AND archived_at IS NULL`,
    [input.mapId, input.ownerMembershipId],
  );

  return rows[0] ? map(rows[0]) : null;
}

/**
 * Mine, or shared with me at least this strongly.
 *
 * `$3 = 'use' OR s.access = 'copy'` READS BACKWARDS AND IS RIGHT. A `copy`
 * share satisfies both needs and a `use` share satisfies only `use`, so asking
 * for `use` places no condition on the access level while asking for `copy`
 * insists on it. It sits in the join rather than the `WHERE` so that a share
 * too weak for what was asked leaves the owner branch below still able to
 * match.
 */
export async function findOpenable(
  db: Executor,
  input: { mapId: string; membershipId: string; need: MapAccess },
): Promise<MapRecord | null> {
  const { rows } = await db.query<Row>(
    `SELECT DISTINCT ${QUALIFIED}
       FROM maps m
  LEFT JOIN map_shares s
             ON s.map_id = m.id
            AND s.revoked_at IS NULL
            AND (s.expires_at IS NULL OR s.expires_at > now())
            AND ($3 = 'use' OR s.access = 'copy')
      WHERE m.id = $1
        AND m.archived_at IS NULL
        AND (
          m.owner_membership_id = $2
          OR s.organisation_wide
          OR s.membership_id = $2
          OR EXISTS (
            SELECT 1 FROM scope_memberships sm
              JOIN scopes mine ON mine.id = sm.scope_id
             WHERE sm.membership_id = $2 AND mine.id = s.scope_id
          )
        )`,
    [input.mapId, input.membershipId, input.need],
  );

  return rows[0] ? map(rows[0]) : null;
}

/**
 * Clear whichever map was the default.
 *
 * SEPARATE FROM `activate`, AND BOTH ARE NEEDED. `maps_one_active` is a partial
 * unique index, so setting a second map active without clearing the first
 * raises a constraint violation rather than moving the flag. The caller runs
 * the two in one transaction.
 */
export async function deactivateAll(db: Executor, ownerMembershipId: string): Promise<void> {
  await db.query(`UPDATE maps SET active = false WHERE owner_membership_id = $1 AND active`, [
    ownerMembershipId,
  ]);
}

export async function activate(db: Executor, mapId: string): Promise<void> {
  await db.query(`UPDATE maps SET active = true WHERE id = $1`, [mapId]);
}

export async function archive(db: Executor, mapId: string): Promise<void> {
  await db.query(`UPDATE maps SET archived_at = now(), active = false WHERE id = $1`, [mapId]);
}

/**
 * Copy one map's contents into another, filtered to what somebody can reach.
 *
 * THE `ANY` PREDICATES ARE THE WHOLE POINT OF THE FUNCTION AND ARE NOT AN
 * ACCESS CHECK LIVING IN A REPO. The caller decides whose reach this is; what
 * arrives here is already an answer, and the statements simply refuse to write
 * rows that point outside it. A fork that carried the rest would be §6.4's
 * escalation written down and made permanent.
 *
 * FOUR STATEMENTS AND NOT ONE, because they are four tables. They are together
 * in one function because a fork that copied links but not thresholds is a map
 * that has forgotten half of what it knew, and the caller running three of four
 * is the way that happens.
 */
export async function copyInto(
  db: Executor,
  input: {
    fromMapId: string;
    toMapId: string;
    conceptIds: string[];
    connectionIds: string[];
  },
): Promise<void> {
  const { fromMapId, toMapId, conceptIds, connectionIds } = input;

  await db.query(
    `INSERT INTO map_links
       (id, organisation_id, map_id, concept_a, concept_b, strength, usefulness_count)
     SELECT gen_random_uuid(), organisation_id, $2, concept_a, concept_b,
            strength, usefulness_count
       FROM map_links
      WHERE map_id = $1 AND concept_a = ANY($3) AND concept_b = ANY($3)`,
    [fromMapId, toMapId, conceptIds],
  );

  await db.query(
    `INSERT INTO map_detector_weights
       (id, organisation_id, map_id, concept_id, detector, weight, signal_count, noise_count)
     SELECT gen_random_uuid(), organisation_id, $2, concept_id, detector,
            weight, signal_count, noise_count
       FROM map_detector_weights
      WHERE map_id = $1 AND concept_id = ANY($3)`,
    [fromMapId, toMapId, conceptIds],
  );

  await db.query(
    `INSERT INTO thresholds
       (id, organisation_id, map_id, concept_id, detector, value, origin, run_count)
     SELECT gen_random_uuid(), organisation_id, $2, concept_id, detector,
            value, origin, run_count
       FROM thresholds
      WHERE map_id = $1 AND concept_id = ANY($3)`,
    [fromMapId, toMapId, conceptIds],
  );

  await db.query(
    `INSERT INTO map_connector_relevance
       (id, organisation_id, map_id, query_pattern_hash, connection_id, hit_count)
     SELECT gen_random_uuid(), organisation_id, $2, query_pattern_hash,
            connection_id, hit_count
       FROM map_connector_relevance
      WHERE map_id = $1 AND connection_id = ANY($3)`,
    [fromMapId, toMapId, connectionIds],
  );
}

/* ── §6.3 and §6.4 Sharing ───────────────────────────────────────────────── */

/**
 * The organisation's sharing policy.
 *
 * RETURNED RAW, AS `string`. What to do when there is no row, and what an
 * unrecognised value ought to mean, are both answers about the caller — and
 * `isSharingPolicy` in the model is the check the service uses to ask. Coercing
 * it here would make the fallback the same everywhere whether or not that is
 * right, which is the thing `repos/README.md` forbids.
 *
 * IT LIVES IN THIS FILE BECAUSE IT HAS ONE READER. Migration 036 put the column
 * on `organisations` for saved views to share later; until they exist, the
 * `organisation` model has nothing to say about it and this is the only
 * statement that reads it.
 */
export async function sharingPolicyOf(
  db: Executor,
  organisationId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ sharing_policy: string }>(
    `SELECT sharing_policy FROM organisations WHERE id = $1`,
    [organisationId],
  );

  return rows[0]?.sharing_policy ?? null;
}

const SHARE_COLUMNS = `
  id, organisation_id, map_id, membership_id, scope_id, organisation_wide,
  access, shared_by, shared_at, expires_at, revoked_at
`;

interface ShareRow {
  id: string;
  organisation_id: string;
  map_id: string;
  membership_id: string | null;
  scope_id: string | null;
  organisation_wide: boolean;
  access: MapAccess;
  shared_by: string;
  shared_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

function mapShare(row: ShareRow): MapShare {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    mapId: row.map_id,
    membershipId: row.membership_id,
    scopeId: row.scope_id,
    organisationWide: row.organisation_wide,
    access: row.access,
    sharedBy: row.shared_by,
    sharedAt: row.shared_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Share a map, or re-share one already shared with the same grantee.
 *
 * THE `DO UPDATE` CANNOT FIRE AND THE STATEMENT IS MOVED UNCHANGED. Two of
 * `membership_id`, `scope_id` and `organisation_wide` are always NULL or false
 * — `map_shares_one_grantee` says exactly one is set — and a unique constraint
 * treats NULLs as distinct, so `map_shares_unique_grantee` never matches an
 * existing row and every re-share inserts a duplicate instead of updating.
 * Fixing it is a schema change (`NULLS NOT DISTINCT`, or a generated grantee
 * key) and belongs in its own pass; changing the statement here while somebody
 * else changes the table is how the two end up disagreeing.
 */
export async function upsertShare(
  db: Executor,
  input: {
    organisationId: string;
    mapId: string;
    membershipId: string | null;
    scopeId: string | null;
    organisationWide: boolean;
    access: MapAccess;
    sharedBy: string;
    expiresAt: string | null;
  },
): Promise<string> {
  /*
   * UPDATE THEN INSERT, NOT AN UPSERT, because there is no single conflict
   * target to name. 045 replaced one unique constraint over all four grantee
   * columns with three PARTIAL indexes — one per grantee type, live rows only —
   * since NULLs are not equal to each other and the old constraint therefore
   * matched nothing. `ON CONFLICT` can infer a partial index only when the
   * statement repeats its predicate, which would mean three near-identical
   * statements branching on which grantee this is.
   *
   * The race is closed by the indexes rather than by the order of these two:
   * two concurrent shares to the same colleague both miss the UPDATE, both
   * INSERT, and the second is refused by `map_shares_one_per_member`.
   */
  const { rows: updated } = await db.query<{ id: string }>(
    `UPDATE map_shares
        SET access = $5, expires_at = $6, shared_by = $4, shared_at = now()
      WHERE map_id = $1
        AND revoked_at IS NULL
        AND membership_id IS NOT DISTINCT FROM $2
        AND scope_id IS NOT DISTINCT FROM $3
        AND organisation_wide = $7
      RETURNING id`,
    [
      input.mapId,
      input.membershipId,
      input.scopeId,
      input.sharedBy,
      input.access,
      input.expiresAt,
      input.organisationWide,
    ],
  );

  /* `IS NOT DISTINCT FROM` above is what the old `=` could not do: it treats
     two NULLs as equal, which is the whole of why the constraint never fired. */
  if (updated[0]) return updated[0].id;

  const id = generateId();

  await db.query(
    `INSERT INTO map_shares
       (id, organisation_id, map_id, membership_id, scope_id, organisation_wide,
        access, shared_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      input.organisationId,
      input.mapId,
      input.membershipId,
      input.scopeId,
      input.organisationWide,
      input.access,
      input.sharedBy,
      input.expiresAt,
    ],
  );

  return id;
}

/**
 * A share that has not been revoked.
 *
 * `revoked_at IS NULL` IS IN THE `WHERE` BECAUSE REVOKING A REVOKED SHARE IS
 * NOT AN ACTION. It is not hiding the row from anybody — the service reads this
 * to decide whether there is anything left to do, and a second revocation that
 * quietly succeeded would move `revoked_at` forward and rewrite when access
 * actually ended.
 */
export async function findLiveShare(db: Executor, shareId: string): Promise<MapShare | null> {
  const { rows } = await db.query<ShareRow>(
    `SELECT ${SHARE_COLUMNS} FROM map_shares WHERE id = $1 AND revoked_at IS NULL`,
    [shareId],
  );

  return rows[0] ? mapShare(rows[0]) : null;
}

export async function revokeShare(db: Executor, shareId: string): Promise<void> {
  await db.query(`UPDATE map_shares SET revoked_at = now() WHERE id = $1`, [shareId]);
}

/* ── §6.1 What a map holds ───────────────────────────────────────────────── */

/**
 * Everything in a map, as references and nothing else.
 *
 * FOUR QUERIES AND NO JOIN. The four tables share only `map_id`, so joining
 * them multiplies rows for no gain, and what the caller wants is one flat list
 * to hand to `resolveFor`.
 *
 * ONLY THE REFERENCE COLUMNS ARE SELECTED. The weights, strengths and counts
 * are not read here because nothing downstream of this function uses them —
 * `resolveFor` asks only whether the opener can reach what an element points
 * at.
 */
export async function elementsOf(db: Executor, mapId: string): Promise<MapElement[]> {
  const links = await db.query<{ concept_a: string; concept_b: string }>(
    `SELECT concept_a, concept_b FROM map_links WHERE map_id = $1`,
    [mapId],
  );
  const weights = await db.query<{ concept_id: string; detector: string }>(
    `SELECT concept_id, detector FROM map_detector_weights WHERE map_id = $1`,
    [mapId],
  );
  const thresholds = await db.query<{ concept_id: string; detector: string }>(
    `SELECT concept_id, detector FROM thresholds WHERE map_id = $1`,
    [mapId],
  );
  const relevance = await db.query<{ connection_id: string }>(
    `SELECT DISTINCT connection_id FROM map_connector_relevance WHERE map_id = $1`,
    [mapId],
  );

  return [
    ...links.rows.map(
      (row): MapElement => ({ kind: 'link', conceptIds: [row.concept_a, row.concept_b] }),
    ),
    ...weights.rows.map(
      (row): MapElement => ({ kind: 'weight', conceptId: row.concept_id, detector: row.detector }),
    ),
    ...thresholds.rows.map(
      (row): MapElement => ({
        kind: 'threshold',
        conceptId: row.concept_id,
        detector: row.detector,
      }),
    ),
    ...relevance.rows.map(
      (row): MapElement => ({ kind: 'relevance', connectionId: row.connection_id }),
    ),
  ];
}

/* ── §6.6 Feedback ───────────────────────────────────────────────────────── */

/**
 * Add one to whichever count a disposition moved, and return both.
 *
 * THE COUNTS COME BACK BECAUSE THE WEIGHT IS COMPUTED FROM THEM. The arithmetic
 * is `engine/maps.weightOf`, outside the database where it can be tested; doing
 * it in the `DO UPDATE` would bury §6.6's formula in a statement and leave two
 * versions of it the first time anything else needs the same number.
 *
 * `signal` AND `noise` ARE THE INCREMENTS, and the conflict clause adds
 * `EXCLUDED`'s rather than assigning it, so the insert and the update apply the
 * same +1 to the same column.
 */
export async function bumpDetectorCounts(
  db: Executor,
  input: {
    organisationId: string;
    mapId: string;
    conceptId: string;
    detector: string;
    signal: number;
    noise: number;
  },
): Promise<{ signalCount: number; noiseCount: number }> {
  const { rows } = await db.query<{ signal_count: number; noise_count: number }>(
    `INSERT INTO map_detector_weights
       (id, organisation_id, map_id, concept_id, detector, signal_count, noise_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (map_id, concept_id, detector)
     DO UPDATE SET signal_count = map_detector_weights.signal_count + EXCLUDED.signal_count,
                   noise_count  = map_detector_weights.noise_count + EXCLUDED.noise_count,
                   last_adjusted_at = now()
     RETURNING signal_count, noise_count`,
    [
      generateId(),
      input.organisationId,
      input.mapId,
      input.conceptId,
      input.detector,
      input.signal,
      input.noise,
    ],
  );

  const row = rows[0];
  if (!row) {
    /* An upsert with `DO UPDATE` returns a row on both paths; no row means the
       statement did something this mapping cannot account for. */
    throw new Error(
      `Detector weight for ${input.conceptId}/${input.detector} returned no row from upsert`,
    );
  }

  return { signalCount: row.signal_count, noiseCount: row.noise_count };
}

/**
 * §5.5 — what this map has learned about each detector, for ranking to read.
 *
 * THE COUNTS COME WITH THE WEIGHT AND ARE NOT OPTIONAL. A weight of 0.4 from
 * two dispositions and a weight of 0.4 from two hundred are different claims,
 * and a reader given only the number cannot tell them apart — so §5's summary
 * carries both and the model is left to decide how much to believe it.
 */
export async function detectorWeights(
  db: Executor,
  mapId: string,
): Promise<
  Array<{ conceptId: string; detector: string; weight: number; signalCount: number; noiseCount: number }>
> {
  const { rows } = await db.query<{
    concept_id: string;
    detector: string;
    weight: string;
    signal_count: number;
    noise_count: number;
  }>(
    `SELECT concept_id, detector, weight, signal_count, noise_count
       FROM map_detector_weights
      WHERE map_id = $1
      ORDER BY concept_id, detector`,
    [mapId],
  );

  return rows.map((row) => ({
    conceptId: row.concept_id,
    detector: row.detector,
    /* numeric arrives as text; parsed so nothing above orders weights as
       strings and puts "0.9" below "0.85". */
    weight: Number(row.weight),
    signalCount: row.signal_count,
    noiseCount: row.noise_count,
  }));
}

export async function setDetectorWeight(
  db: Executor,
  input: { mapId: string; conceptId: string; detector: string; weight: number },
): Promise<void> {
  await db.query(
    `UPDATE map_detector_weights SET weight = $2
      WHERE map_id = $1 AND concept_id = $3 AND detector = $4`,
    [input.mapId, input.weight, input.conceptId, input.detector],
  );
}

/* ── §3.4 Thresholds ─────────────────────────────────────────────────────── */

/**
 * The threshold a map has been tuned to, if it has been tuned.
 *
 * `origin = 'tuned'` IS A CORRECTNESS PREDICATE, NOT A FILTER ON WHAT SOMEBODY
 * MAY SEE. §3.4 — a derived threshold is a first guess computed from the query,
 * and handing one back on a later run would freeze it against a population that
 * has since changed. The two origins are different kinds of number and only one
 * of them answers this question.
 *
 * `numeric` ARRIVES AS A STRING. The coercion is here, once.
 */
export async function tunedThresholdFor(
  db: Executor,
  input: { mapId: string; conceptId: string; detector: string },
): Promise<number | null> {
  const { rows } = await db.query<{ value: string }>(
    `SELECT value FROM thresholds
      WHERE map_id = $1 AND concept_id = $2 AND detector = $3 AND origin = 'tuned'`,
    [input.mapId, input.conceptId, input.detector],
  );

  return rows[0] ? Number(rows[0].value) : null;
}

/**
 * Record what a run used, or what the model tuned it to.
 *
 * THE `CASE` IS NOT A BUSINESS RULE ESCAPING INTO SQL, IT IS THE ONLY PLACE THE
 * COMPARISON CAN BE MADE. The existing origin is not known until the conflict
 * resolves, and reading it first to decide in the caller reintroduces the
 * read-then-write race the upsert exists to avoid. What it encodes is §3.4's
 * statement that a derived run never demotes a tuned threshold.
 */
export async function recordThreshold(
  db: Executor,
  input: {
    organisationId: string;
    mapId: string;
    conceptId: string;
    detector: string;
    value: number;
    origin: ThresholdOrigin;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO thresholds
       (id, organisation_id, map_id, concept_id, detector, value, origin, run_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
     ON CONFLICT (map_id, concept_id, detector)
     DO UPDATE SET value = EXCLUDED.value,
                   origin = CASE WHEN thresholds.origin = 'tuned' THEN 'tuned' ELSE EXCLUDED.origin END,
                   run_count = thresholds.run_count + 1,
                   last_adjusted_at = now()`,
    [
      generateId(),
      input.organisationId,
      input.mapId,
      input.conceptId,
      input.detector,
      input.value,
      input.origin,
    ],
  );
}

/**
 * §6.1 — which connections a question of this shape turned out to need.
 *
 * THE SHAPE IS HASHED, NEVER THE QUESTION. 036 is explicit: a customer's own
 * words routinely contain a supplier name, a person or an amount, and storing
 * them would put values in the learned layer. The hash is over the PLAN — the
 * concept, the fields and the operators — which is enough to recognise the same
 * shape again and carries nothing back.
 */
export async function recordConnectorUse(
  db: Executor,
  input: {
    organisationId: string;
    mapId: string;
    queryPatternHash: string;
    connectionIds: readonly string[];
  },
): Promise<number> {
  if (input.connectionIds.length === 0) return 0;

  const { rowCount } = await db.query(
    `INSERT INTO map_connector_relevance
       (id, organisation_id, map_id, query_pattern_hash, connection_id, hit_count)
     SELECT gen_random_uuid(), $1, $2, $3, c.connection_id, 1
       FROM unnest($4::uuid[]) AS c(connection_id)
     ON CONFLICT (map_id, query_pattern_hash, connection_id)
     DO UPDATE SET hit_count = map_connector_relevance.hit_count + 1,
                   last_used_at = now()`,
    [input.organisationId, input.mapId, input.queryPatternHash, [...input.connectionIds]],
  );

  return rowCount ?? 0;
}

/**
 * Which connections a question of this shape has needed before.
 *
 * THE READER THAT MAKES THE WRITER WORTH HAVING. Without it the table would be
 * the fourth write-only one in this schema, and the reachability check would
 * say so.
 */
export async function connectorRelevance(
  db: Executor,
  input: { mapId: string; queryPatternHash: string },
): Promise<Array<{ connectionId: string; hitCount: number }>> {
  const { rows } = await db.query<{ connection_id: string; hit_count: number }>(
    `SELECT connection_id, hit_count
       FROM map_connector_relevance
      WHERE map_id = $1 AND query_pattern_hash = $2
      ORDER BY hit_count DESC, connection_id`,
    [input.mapId, input.queryPatternHash],
  );

  return rows.map((row) => ({ connectionId: row.connection_id, hitCount: row.hit_count }));
}

/**
 * §6.1 — two concepts a question actually related.
 *
 * ── The trigger arrived with joins ─────────────────────────────────────────
 *
 * `map_links` had a reader and a copy-on-fork and NO WRITER, so the table was
 * permanently empty and forking a map copied nothing. Its blocker was never the
 * schema: a plan named ONE concept, so nothing in the product could say that a
 * question had genuinely crossed two.
 *
 * A join can. When one is answered, the two concepts it spanned were related in
 * anger by somebody with a real question — which is the only honest evidence
 * this table was ever waiting for.
 *
 * ── Smoothed the same way a detector weight is ─────────────────────────────
 *
 * `usefulness_count` counts, and `strength` is that count smoothed into a
 * bounded number: `n / (n + 3)`. One join makes a weak link rather than a
 * certain one, and it takes a pattern to approach 1 — the same argument
 * `weightOf` makes about a single irritated dismissal on a Friday.
 *
 * CANONICAL ORDER, ENFORCED BY A CHECK. One pair is one row whichever way round
 * the question asked, which is what makes the count mean anything.
 */
export async function reinforceLink(
  db: Executor,
  input: { organisationId: string; mapId: string; conceptA: string; conceptB: string },
): Promise<void> {
  /* The CHECK requires `concept_a < concept_b`; ordering here rather than
     letting the database refuse makes the caller's order irrelevant. */
  const [a, b] =
    input.conceptA < input.conceptB
      ? [input.conceptA, input.conceptB]
      : [input.conceptB, input.conceptA];

  if (a === b) return;

  await db.query(
    `INSERT INTO map_links
       (id, organisation_id, map_id, concept_a, concept_b, strength, usefulness_count)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, round(1.0 / 4.0, 3), 1)
     ON CONFLICT (map_id, concept_a, concept_b) DO UPDATE
        SET usefulness_count = map_links.usefulness_count + 1,
            strength = round(
              (map_links.usefulness_count + 1)::numeric / (map_links.usefulness_count + 1 + 3), 3),
            last_reinforced_at = now()`,
    [input.organisationId, input.mapId, a, b],
  );
}

/*
 * ── WHY map_links WAS EMPTY, AND WHAT CHANGED ─────────────────────────────
 *
 * Its writer is `reinforceLink`, which strengthens the link between two
 * concepts a question RELATED. Both tables used to be blocked on the same
 * thing — there was no compiler, so nothing knew which concepts or which
 * connections a question needed.
 *
 * The compiler exists now, and `map_connector_relevance` is written by it on
 * every answered question. `map_links` was not, because a plan named ONE
 * concept: nothing crossed two until joins were built. Joins are built, so
 * `reinforceLink` above has the trigger it was waiting for — a question that
 * genuinely related two concepts, asked by somebody who wanted the answer.
 *
 * `map_detector_weights` is in neither position: it is written by
 * `recordDisposition` and read by ranking.
 *
 * (This note lives here rather than in 036 because an applied migration is
 * immutable — the runner checksums them and refuses an edit.)
 */
