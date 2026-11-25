import type { Executor } from '../infra/db.infra';
import { generateId } from '../utils/tokens.util';
import type {
  DismissalRate,
  Disposition,
  Finding,
  FindingFact,
  FindingForReader,
  HistorySource,
  Lineage,
  NamedFinding,
  RankableFinding,
} from '../models/finding.model';

/**
 * Findings, and what people decided about them.
 *
 * THREE LAYERS READ THIS TABLE and they read it differently: §3 lists a
 * person's undecided findings, §4 counts which conditions co-occur, §5 hands a
 * summary to a model. One file, so the projections are beside each other and
 * the upsert that writes them has one home.
 *
 * THE DISPOSITION JOINS ARE NOT PERMISSION CHECKS, which is the distinction
 * `repos/README.md` draws about WHERE clauses. §6.6 makes a disposition
 * personal: joining on the reader's own membership is what makes the row mean
 * "this person has decided about it" rather than "somebody has", and a query
 * without that predicate would answer a different question, not a broader one.
 *
 * NUMERIC ARRIVES AS A STRING from pg, and the counts from `count(*)` arrive as
 * strings too. Coercing them here, once, is what stops two call sites
 * disagreeing about whether a deviation is a number.
 */

const COLUMNS = `
  id, organisation_id, detector, concept_id, entity_ref, measure,
  observed, expected, deviation, population, population_n, evidence, lineage,
  confidence, detected_at, occurred_at, history_source
`;

interface Row {
  id: string;
  organisation_id: string;
  detector: string;
  concept_id: string;
  entity_ref: string;
  measure: string;
  observed: string | null;
  expected: string | null;
  deviation: string | null;
  population: Record<string, unknown> | null;
  population_n: number;
  evidence: unknown;
  lineage: Lineage[] | null;
  confidence: string | null;
  detected_at: Date;
  occurred_at: Date | null;
  history_source: HistorySource | null;
}

function map(row: Row): Finding {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    detector: row.detector,
    conceptId: row.concept_id,
    entityRef: row.entity_ref,
    measure: row.measure,
    observed: row.observed === null ? null : Number(row.observed),
    expected: row.expected === null ? null : Number(row.expected),
    deviation: row.deviation === null ? null : Number(row.deviation),
    population: row.population ?? {},
    populationN: row.population_n,
    evidence: row.evidence,
    lineage: row.lineage ?? [],
    confidence: row.confidence === null ? null : Number(row.confidence),
    detectedAt: row.detected_at,
    occurredAt: row.occurred_at,
    historySource: row.history_source,
  };
}

/** The columns a finding shares with the concept it is about. */
interface NamedRow {
  id: string;
  detector: string;
  concept_id: string;
  concept_name: string;
  entity_ref: string;
  measure: string;
  observed: string | null;
  expected: string | null;
  deviation: string | null;
  population_n: number;
}

function mapNamed(row: NamedRow): NamedFinding {
  return {
    id: row.id,
    detector: row.detector,
    conceptId: row.concept_id,
    conceptName: row.concept_name,
    entityRef: row.entity_ref,
    measure: row.measure,
    observed: row.observed === null ? null : Number(row.observed),
    expected: row.expected === null ? null : Number(row.expected),
    deviation: row.deviation === null ? null : Number(row.deviation),
    populationN: row.population_n,
  };
}

/** One finding. The service decides what a missing one means to the caller. */
export async function read(db: Executor, findingId: string): Promise<Finding | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM findings WHERE id = $1`,
    [findingId],
  );

  const row = rows[0];
  return row ? map(row) : null;
}

/**
 * THE SAME FACT, FOUND AGAIN, IS THE SAME ROW. A detector re-running over
 * unchanged data must not produce a second finding: yesterday's dismissal would
 * stop applying and the list would grow every time anybody asked a question.
 * The figures move, `detected_at` moves, the id does not.
 *
 * THE PLACEHOLDERS ARE OUT OF ORDER AND THAT IS DELIBERATE HERE — the statement
 * is moved from the service exactly as it ran, `$12` for the detector and all.
 * Renumbering it is a separate change from moving it, and this file exists so
 * that the next person can make it against something they can read.
 */
export async function upsert(
  db: Executor,
  input: {
    organisationId: string;
    detector: string;
    conceptId: string;
    entityRef: string;
    measure: string;
    observed: number;
    expected: number;
    deviation: number;
    populationN: number;
    population: Record<string, unknown>;
    lineage: Lineage[];
    /** §4.1 — when it happened, for the detectors that read a timestamp. */
    occurredAt?: string | null;
    /** §3 — which of source, Silo or both supplied the history. */
    historySource?: HistorySource | null;
    /**
     * §5 — which run raised it, so a second SOURCE PAIR is not a second RUN.
     *
     * The disagreement detector compares every pair of contributing sources and
     * upserts the same finding once per pair, so a three-system concept raised
     * the same fact three times in one run and `raised_count` read it as three
     * runs of persistence on a brand new finding.
     */
    runId: string;
  },
): Promise<{ id: string; raisedCount: number }> {
  const { rows } = await db.query<{ id: string; raised_count: number }>(
    `INSERT INTO findings
       (id, organisation_id, detector, concept_id, entity_ref, measure,
        observed, expected, deviation, population, population_n, lineage,
        occurred_at, history_source, last_run_id)
     VALUES ($1, $2, $12, $3, $4, $5, $6, $7, $8, $9, $10, $11, $13, $14, $15)
     ON CONFLICT (organisation_id, detector, concept_id, entity_ref, measure)
     DO UPDATE SET observed = EXCLUDED.observed,
                   expected = EXCLUDED.expected,
                   deviation = EXCLUDED.deviation,
                   population = EXCLUDED.population,
                   population_n = EXCLUDED.population_n,
                   lineage = EXCLUDED.lineage,
                   occurred_at = EXCLUDED.occurred_at,
                   history_source = EXCLUDED.history_source,
                   detected_at = now(),
                   /*
                    * Section 5 - HOW MANY RUNS HAVE RAISED THIS SAME FACT. Counted
                    * here because this is the only place that knows a raise
                    * happened; detected_at alone cannot say, since it is
                    * overwritten by the raise it would have to be compared to.
                    *
                    * first_detected_at IS DELIBERATELY NOT IN THIS LIST. It is
                    * when the finding was first true, and an upsert that moved
                    * it would make every question about how long something has
                    * been wrong answer "since this morning".
                    */
                   /*
                    * ONLY WHEN THE RUN IS A DIFFERENT ONE. Comparing three
                    * source pairs is three upserts and one raise; counting them
                    * separately scored a first sighting as persistent.
                    * IS DISTINCT FROM rather than a plain inequality, so a row
                    * written before 054 with a null run still counts its next.
                    */
                   raised_count = findings.raised_count
                     + CASE
                         WHEN findings.last_run_id IS DISTINCT FROM EXCLUDED.last_run_id
                         THEN 1 ELSE 0
                       END,
                   last_run_id = EXCLUDED.last_run_id
     RETURNING id, raised_count`,
    [
      generateId(),
      input.organisationId,
      input.conceptId,
      input.entityRef,
      input.measure,
      input.observed,
      input.expected,
      input.deviation,
      JSON.stringify(input.population),
      input.populationN,
      JSON.stringify(input.lineage),
      input.detector,
      input.occurredAt ?? null,
      input.historySource ?? null,
      input.runId,
    ],
  );

  return { id: rows[0]!.id, raisedCount: Number(rows[0]!.raised_count) };
}

/**
 * §5 — what a finding scored, and the components it scored from.
 *
 * THE COMPONENTS GO WITH IT, ALWAYS. A score of 0.74 is not an explanation, and
 * somebody asking why one finding sits above another is owed the numbers rather
 * than the number — the same rule §5.2 applies to a ranking's rationale.
 *
 * WRITTEN BY ID, in one statement, because a run scores every finding it raised
 * and doing that one round trip at a time is the shape that makes a hundred
 * findings a hundred queries.
 */
export async function recordScores(
  db: Executor,
  scores: ReadonlyArray<{ findingId: string; score: number; components: Record<string, number> }>,
): Promise<number> {
  if (scores.length === 0) return 0;

  const { rowCount } = await db.query(
    `UPDATE findings AS f
        SET score = s.score, score_components = s.components
       FROM jsonb_to_recordset($1::jsonb)
         AS s(finding_id uuid, score numeric, components jsonb)
      WHERE f.id = s.finding_id`,
    [
      JSON.stringify(
        scores.map((one) => ({
          finding_id: one.findingId,
          score: one.score,
          components: one.components,
        })),
      ),
    ],
  );

  return rowCount ?? 0;
}

/**
 * The findings one person has in front of them.
 *
 * `includeDecided` IS PART OF THE QUESTION, NOT A PERMISSION. Somebody asking
 * what they have already judged wants those rows back; the predicate decides
 * which question is being answered, and the join on their own membership is
 * what keeps the answer theirs (§6.6).
 */
export async function forReader(
  db: Executor,
  input: { membershipId: string; includeDecided: boolean },
): Promise<FindingForReader[]> {
  const { rows } = await db.query<
    NamedRow & {
      lineage: unknown;
      detected_at: Date;
      disposition: Disposition | null;
      score: string | null;
      score_components: Record<string, number> | null;
      first_detected_at: Date;
      raised_count: number;
    }
  >(
    /*
     * ORDERED BY SCORE, WHICH IS AN IMPROVEMENT ON WHAT WAS HERE AND NOT THE
     * LAST WORD. It used to order by raw deviation, which put a disagreement's
     * percentage difference directly against an outlier's z-score — two
     * different arithmetics over two different populations, ranked as though
     * they were one number.
     *
     * A score is normalised WITHIN its own detector's run, so 0.9 means the
     * same thing whichever detector produced it: near the top of what that
     * detector found. That makes it a defensible default ordering. It is still
     * only an ordering aid — §5's ranking stage is what reads the whole set and
     * EXPLAINS an order, and this is what somebody sees before they ask for one.
     *
     * Deviation remains the tiebreak so findings raised before scoring existed
     * keep the order they have always had rather than falling to the bottom.
     */
    `SELECT f.id, f.detector, f.concept_id, c.name AS concept_name,
            f.entity_ref, f.measure, f.observed, f.expected, f.deviation,
            f.population_n, f.lineage, f.detected_at, d.disposition,
            f.score, f.score_components, f.first_detected_at, f.raised_count
       FROM findings f
       JOIN concepts c ON c.id = f.concept_id
       LEFT JOIN finding_dispositions d
         ON d.finding_id = f.id AND d.membership_id = $1
      WHERE ($2 OR d.disposition IS NULL)
      ORDER BY f.score DESC NULLS LAST,
               f.deviation DESC NULLS LAST,
               f.detected_at DESC
      LIMIT 200`,
    [input.membershipId, input.includeDecided],
  );

  return rows.map((row) => ({
    ...mapNamed(row),
    lineage: row.lineage,
    detectedAt: row.detected_at,
    disposition: row.disposition,
    /* numeric arrives as a string; parsed here so a caller never compares
       "0.9" against "0.85" as text and gets it backwards. */
    score: row.score === null ? null : Number(row.score),
    scoreComponents: row.score_components,
    firstDetectedAt: row.first_detected_at,
    raisedCount: Number(row.raised_count),
  }));
}

/**
 * What the ranking layer reads.
 *
 * DECIDED FINDINGS ARE LEFT OUT, and that is the question rather than an access
 * rule: §6.6 silences a finding for the person who judged it, ranking is that
 * person's view, and ordering for them again what they have already dealt with
 * would crowd out the ones they have not seen.
 */
export async function forRanking(
  db: Executor,
  input: { membershipId: string; conceptIds: string[] | null; limit: number },
): Promise<RankableFinding[]> {
  const { rows } = await db.query<
    NamedRow & { confidence: string | null; occurred_at: Date | null }
  >(
    `SELECT f.id, f.detector, f.concept_id, c.name AS concept_name, f.measure,
            f.entity_ref, f.observed, f.expected, f.deviation, f.population_n,
            f.confidence, f.occurred_at
       FROM findings f
       JOIN concepts c ON c.id = f.concept_id
  LEFT JOIN finding_dispositions d
            ON d.finding_id = f.id AND d.membership_id = $2
      WHERE d.id IS NULL
        AND ($1::uuid[] IS NULL OR f.concept_id = ANY($1))
      ORDER BY f.deviation DESC NULLS LAST, f.detected_at DESC
      LIMIT $3`,
    [input.conceptIds, input.membershipId, input.limit],
  );

  return rows.map((row) => ({
    ...mapNamed(row),
    confidence: row.confidence === null ? null : Number(row.confidence),
    occurredAt: row.occurred_at,
  }));
}

/**
 * Every finding §4 can associate, across the organisation or a narrowing.
 *
 * NO DISPOSITION JOIN, DELIBERATELY. An association is a count over entities,
 * not a view of anybody's queue — filtering it by one person's dismissals would
 * make "78 of 94" mean something different depending on who asked.
 */
export async function facts(
  db: Executor,
  input: { conceptIds: string[] | null },
): Promise<FindingFact[]> {
  const { rows } = await db.query<{
    id: string;
    detector: string;
    concept_id: string;
    measure: string;
    entity_ref: string;
    occurred_at: Date | null;
    population_n: number;
    lineage: Array<{ connectionId: string }> | null;
  }>(
    /*
     * `lineage` CARRIES THE CONNECTION THE ENTITY WAS READ FROM, and §4's
     * one-hop join needs it: a link names an object in a particular system, and
     * matching it against a finding means knowing which system that finding's
     * entity lives in. The finding row records it nowhere else.
     */
    `SELECT id, detector, concept_id, measure, entity_ref, occurred_at, population_n, lineage
       FROM findings
      WHERE ($1::uuid[] IS NULL OR concept_id = ANY($1))`,
    [input.conceptIds],
  );

  return rows.map((row) => ({
    id: row.id,
    detector: row.detector,
    conceptId: row.concept_id,
    measure: row.measure,
    entityRef: row.entity_ref,
    populationN: row.population_n,
    occurredAt: row.occurred_at,
    /* The system the entity was read from, for §4's one-hop join. */
    connectionId: row.lineage?.[0]?.connectionId ?? null,
  }));
}

/**
 * §5.5 — which conditions this organisation keeps setting aside.
 *
 * COUNTED OVER EVERYBODY'S DISPOSITIONS, unlike every other read in this file.
 * A rate is a fact about the organisation; one person's dismissals are a fact
 * about them, and it is the first that is worth telling the model.
 */
export async function dismissalRates(db: Executor): Promise<DismissalRate[]> {
  const { rows } = await db.query<{
    detector: string;
    concept_id: string;
    measure: string;
    raised: string;
    dismissed: string;
  }>(
    `SELECT f.detector, f.concept_id, f.measure,
            count(*) AS raised,
            count(*) FILTER (WHERE d.disposition = 'dismissed') AS dismissed
       FROM findings f
       LEFT JOIN finding_dispositions d ON d.finding_id = f.id
      GROUP BY f.detector, f.concept_id, f.measure
     HAVING count(*) FILTER (WHERE d.disposition = 'dismissed') > 0`,
  );

  return rows.map((row) => ({
    detector: row.detector,
    conceptId: row.concept_id,
    measure: row.measure,
    raised: Number(row.raised),
    dismissed: Number(row.dismissed),
  }));
}

/**
 * One person's standing decision about one finding.
 *
 * REPLACED RATHER THAN APPENDED. Changing your mind is not a second opinion —
 * `finding_dispositions_one_per_person` says so, and the conflict target here
 * is what makes a second decision land on the first instead of failing.
 */
export async function saveDisposition(
  db: Executor,
  input: {
    organisationId: string;
    findingId: string;
    membershipId: string;
    disposition: Disposition;
    reason: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO finding_dispositions
       (id, organisation_id, finding_id, membership_id, disposition, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (finding_id, membership_id)
     DO UPDATE SET disposition = EXCLUDED.disposition,
                   reason = EXCLUDED.reason,
                   decided_at = now()`,
    [
      generateId(),
      input.organisationId,
      input.findingId,
      input.membershipId,
      input.disposition,
      input.reason,
    ],
  );
}

/* ── Outbound links ──────────────────────────────────────────────────────── */

export interface FindingLink {
  connectionId: string;
  fromObject: string;
  field: string;
  value: string;
  targetObject: string;
  targetField: string;
}

/**
 * Replace the links captured for one finding.
 *
 * REPLACE, BECAUSE A FINDING IS UPSERTED. The same fact found again is the same
 * row (`findings_unique`), and the row it was found on may have been repointed
 * since — a supplier code corrected, an order re-parented. Merging would leave
 * the old key beside the new one and relate the finding to both.
 *
 * THE VALUE GOES IN UNTOUCHED. No trim, no fold: normalisation is the
 * resolver's rule, applied at read time, and a value normalised here could not
 * be re-normalised differently when that rule changes.
 */
export async function replaceLinks(
  db: Executor,
  input: { organisationId: string; findingId: string; links: readonly FindingLink[] },
): Promise<number> {
  await db.query(`DELETE FROM finding_links WHERE finding_id = $1`, [input.findingId]);

  if (input.links.length === 0) return 0;

  const { rowCount } = await db.query(
    `INSERT INTO finding_links
       (id, organisation_id, finding_id, connection_id, from_object, field,
        value, target_object, target_field)
     SELECT gen_random_uuid(), $1, $2, l.connection_id, l.from_object, l.field,
            l.value, l.target_object, l.target_field
       FROM jsonb_to_recordset($3::jsonb)
         AS l(connection_id uuid, from_object text, field text,
              value text, target_object text, target_field text)
     ON CONFLICT (finding_id, connection_id, field) DO NOTHING`,
    [
      input.organisationId,
      input.findingId,
      JSON.stringify(
        input.links.map((link) => ({
          connection_id: link.connectionId,
          from_object: link.fromObject,
          field: link.field,
          value: link.value,
          target_object: link.targetObject,
          target_field: link.targetField,
        })),
      ),
    ],
  );

  return rowCount ?? 0;
}

/**
 * Every link captured for a set of findings.
 *
 * FOR THE READ-TIME JOIN. §4's association layer asks which findings reach
 * which, and answering it means having both the links and the findings they
 * could reach — neither of which is resolvable without the other.
 */
export async function linksFor(
  db: Executor,
  findingIds: readonly string[],
): Promise<Array<FindingLink & { findingId: string }>> {
  if (findingIds.length === 0) return [];

  const { rows } = await db.query<{
    finding_id: string;
    connection_id: string;
    from_object: string;
    field: string;
    value: string;
    target_object: string;
    target_field: string;
  }>(
    `SELECT finding_id, connection_id, from_object, field, value, target_object, target_field
       FROM finding_links
      WHERE finding_id = ANY($1)
      ORDER BY finding_id, field`,
    [[...findingIds]],
  );

  return rows.map((row) => ({
    findingId: row.finding_id,
    connectionId: row.connection_id,
    fromObject: row.from_object,
    field: row.field,
    value: row.value,
    targetObject: row.target_object,
    targetField: row.target_field,
  }));
}

/**
 * Automations §3 — findings a scheduled check should react to.
 *
 * ── "APPEARS", NOT "EXISTS", AND THE `since` IS WHAT MAKES THAT TRUE ───────
 *
 * §3 describes the condition as "tell me when this kind of problem appears".
 * Matching every finding that currently exists would instead mean "tell me,
 * every fifteen minutes, that this problem is still here" — which is the same
 * email forever and the fastest way to teach somebody to filter it.
 *
 * So this asks what was RAISED since a moment. `detected_at` moves when a
 * detector re-raises an existing row (the unique constraint keeps one row and
 * moves the timestamp), which is also what makes §3's "a finding recurred"
 * work: a recurrence is a new `detected_at` on a row whose `raised_count` has
 * gone past one.
 *
 * ── THE OWNER'S OWN DISMISSALS ARE RESPECTED, AND ONLY THEIRS ─────────────
 *
 * A disposition is per membership — §3.4's whole design is that one person
 * calling something noise is not everybody's ruling. So this excludes what the
 * automation's OWNER has set aside, and a colleague's dismissal silences
 * nothing. Joining without the membership would let anybody in the
 * organisation quietly switch off somebody else's scheduled check.
 *
 * `dismissed` AND `not_relevant`, NOT `confirmed`. Confirming a finding is
 * agreeing it is real, which is no reason to stop being told about it.
 */
export async function raisedSince(
  db: Executor,
  input: {
    /** Whose dismissals count. The automation's owner. */
    membershipId: string;
    since: Date | null;
    detector?: string | null;
    conceptId?: string | null;
    minimumScore?: number | null;
    minimumRaisedCount?: number | null;
  },
): Promise<Array<{ id: string; detector: string; conceptId: string; score: number | null; raisedCount: number }>> {
  const { rows } = await db.query<{
    id: string;
    detector: string;
    concept_id: string;
    score: string | null;
    raised_count: number;
  }>(
    `SELECT f.id, f.detector, f.concept_id, f.score, f.raised_count
       FROM findings f
       LEFT JOIN finding_dispositions d
              ON d.finding_id = f.id
             AND d.membership_id = $6
             AND d.disposition IN ('dismissed', 'not_relevant')
      WHERE ($1::timestamptz IS NULL OR f.detected_at > $1)
        AND ($2::text IS NULL OR f.detector = $2)
        AND ($3::uuid IS NULL OR f.concept_id = $3)
        AND ($4::numeric IS NULL OR f.score >= $4)
        AND ($5::integer IS NULL OR f.raised_count >= $5)
        AND d.id IS NULL
      ORDER BY f.score DESC NULLS LAST, f.detected_at DESC
      LIMIT 500`,
    [
      input.since,
      input.detector ?? null,
      input.conceptId ?? null,
      input.minimumScore ?? null,
      input.minimumRaisedCount ?? null,
      input.membershipId,
    ],
  );

  return rows.map((row) => ({
    id: row.id,
    detector: row.detector,
    conceptId: row.concept_id,
    score: row.score === null ? null : Number(row.score),
    raisedCount: row.raised_count,
  }));
}
