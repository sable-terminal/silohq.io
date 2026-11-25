import { withTransaction } from '../infra/db.infra';
import { hiddenFields, visibleObjects } from './fieldPolicy.service';
import { generateId } from '../utils/tokens.util';
import { runWithTenant } from '../utils/tenantContext.util';
import { invalid, notFound } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { childLogger } from '../config/logger.config';
import { askComplete } from './connector.service';
import { detectDisagreement, deriveTolerance } from '../engine/detectors/disagreement.detector';
import type { SourceRows } from '../engine/detectors/disagreement.detector';
import {
  detectAbsence,
  detectConcentration,
  detectDuplication,
  detectOutlier,
  detectReferentialBreak,
  detectSequenceViolation,
  deriveAbsenceTolerance,
  deriveConcentrationMultiple,
  deriveOutlierThreshold,
  type Outcome,
} from '../engine/detectors/federated.detector';
import { at, refOf, type Row } from '../engine/detectors/shared.detector';
import { linksFrom } from '../engine/ontology/links.ontology';
import type { ManifestObject } from '../schemas/manifest.schema';
import type { ContributingObject } from './concept.service';
import { recordDisposition, recordThreshold, thresholdFor } from './map.service';
import { assertCleared, authorityOf } from './authorisation.service';
import * as authzRepo from '../repos/authz.repo';
import { checkMarkings } from '../utils/markingCheck.util';
import * as conceptRepo from '../repos/concept.repo';
import * as associationRepo from '../repos/association.repo';
import { routesBetween } from '../engine/ontology/relate.ontology';
import { score } from '../engine/analysis/scoring.analysis';
import { DEFAULT_LIMITS } from '../utils/bounds.util';
import * as findingRepo from '../repos/finding.repo';
import { needsReason } from '../models/finding.model';
import * as resolutionRepo from '../repos/resolution.repo';
import {
  detectDrift,
  detectRecurrence,
  detectTimingDeviation,
  deriveBucketDays,
  deriveDriftThreshold,
  deriveRecurrenceThreshold,
  deriveTimingThreshold,
} from '../engine/detectors/history.detector';
import {
  baselineOf,
  capabilityOf,
  explain,
  requirementFor,
  resolve as resolveHistory,
  type HistoryDetector,
  type HistoryPlan,
  type SiloCoverage,
  type SourceCapability,
} from '../engine/detectors/historySource.detector';
import { env } from '../config/env.config';
import * as connectorRepo from '../repos/connector.repo';
import * as siloRepo from '../repos/silo.repo';
import * as siloService from './silo.service';
import type { Actor } from './scope.service';

const log = childLogger('recognition');

/**
 * §3 — running the detectors and keeping what they computed.
 *
 * THE DETECTOR IS A PURE FUNCTION AND THIS IS THE PART THAT IS NOT. Fetching
 * from two systems, deciding which rows are the same entity, writing findings
 * and asking a person about the pairs that would not resolve — all of that
 * lives here, so the arithmetic in `engine/detectors` stays testable without a
 * database and stays honest without a network.
 *
 * A PARTIAL ANSWER IS NOT A SMALLER ANSWER. `askComplete` rather than `ask`:
 * a disagreement computed from one of two systems is not a weaker finding, it
 * is a wrong one, and it looks exactly like a right one. If a source is down
 * the run refuses and says which.
 */

export type Measure = {
  /** What it is called on the concept. */
  name: string;
  /** Where to read it, per contributing connection. */
  byConnection: Record<string, string>;
};

/**
 * §3 — WHAT EACH DETECTOR SHOULD EXAMINE, said by the customer.
 *
 * DUPLICATION AND OUTLIER NEED NOTHING, because the concept already carries
 * what they read: the match keys are what identity means here, and the measure
 * is what the question is about. They run on every pass.
 *
 * THE OTHER FOUR NEED A DECLARATION, and that is §1 rather than an unfinished
 * feature. Nothing in this product knows that dispatch follows payment, or that
 * an order belongs to a customer, or which column is the one worth grouping on
 * — that is domain knowledge, and none ships. The customer says, and the
 * detector checks; a detector that guessed would be a sector template with
 * extra steps.
 *
 * WHAT IS NOT DECLARED IS REPORTED AS NOT CONFIGURED, never silently skipped.
 * §3.1 makes the same argument about the three that need Siloes: a short list
 * with no explanation reads as "nothing is wrong here", and the two reasons a
 * detector did not run are different facts a person needs told apart.
 */
export type Examine = {
  /** Fields whose emptiness is compared against each other. */
  absence?: { fields: string[] };
  /** A reference into another object of the same connection. */
  referentialBreak?: { referenceField: string; targetObject: string; targetKeyField: string };
  /** Steps, in the order they are supposed to happen. */
  sequence?: { stepFields: string[] };
  /** What to group by, and optionally what to weigh each row by. */
  concentration?: { groupField: string; weightField?: string };

  /*
   * §3 — THE THREE HISTORY DETECTORS, DECLARED THE SAME WAY AS THE REST. They
   * are not gated on storage; they are gated on whether the history they need
   * can be reached, and `engine/history` answers that from what the connections
   * declare. What stays the customer's to say is which fields carry the dates —
   * the same division §1 draws everywhere else.
   */

  /** Two timestamps and, optionally, what makes two instances comparable. */
  timing?: { startField: string; endField: string; classField?: string };
  /** A dated field, and what is being counted within it. */
  drift?: { dateField: string; subjectField?: string; label?: string };
  /** Whose recurrence, and when each occurrence happened. */
  recurrence?: { sourceField: string; dateField: string };
};

const NEEDS_DECLARING = [
  'absence',
  'referential_break',
  'sequence_violation',
  'concentration',
  'timing_deviation',
  'drift',
  'recurrence',
] as const;

export type RaisedFinding = {
  id: string;
  /**
   * §5 — how many runs have raised this same fact, this one included.
   *
   * A FINDING THAT KEEPS COMING BACK IS DIFFERENT FROM ONE THAT APPEARED ONCE,
   * and the difference is not that it is worse — it is that nobody has dealt
   * with it.
   */
  raisedCount: number;
  detector: string;
  conceptId: string;
  entityRef: string;
  measure: string;
  observed: number | null;
  expected: number | null;
  deviation: number | null;
  populationN: number;
  lineage: Array<{ connectionId: string; fieldPath: string; historySource?: string }>;
  detectedAt: string;
  /** Null wherever the detector had no event time — which is most of them. */
  occurredAt?: string | null;
  /** §3 — null for the seven that read a snapshot rather than a range. */
  historySource?: 'source' | 'silo' | 'both' | null;
};

/**
 * §3 — WHERE A HISTORY DETECTOR'S DATA COMES FROM, RESOLVED PER RUN.
 *
 * THE STORAGE GATE THAT USED TO LIVE HERE WAS WRONG. `unavailableDetectors`
 * returned timing deviation, drift and recurrence whenever Siloes were off, on
 * the reasoning that they need a baseline and a federated query has none. The
 * first half is right and the second does not follow: these detectors need
 * HISTORICAL DATA, not Silo storage, and the source system usually already
 * holds it. An order table with created and completed timestamps answers timing
 * deviation with nothing stored anywhere.
 *
 * What replaced it is a capability check — `engine/history.resolve` — which
 * looks at what the connections behind the concept actually declare, then at
 * what a Silo could add, and returns one of four plans. The gate said "turn on
 * storage" to customers whose ERP could have answered immediately.
 */

/**
 * §12 — what storage could contribute, for a concept, and what it captures.
 *
 * FOUR STATES, AND THE DIFFERENCE BETWEEN THEM IS WHAT THE CUSTOMER IS TOLD.
 * `compiled_out` is a property of the deployment and must not be offered as a
 * switch. `off` is an offer. `empty` is "on, and holding nothing yet".
 *
 * THE NOMINATED FIELDS AND THE WINDOW COME BACK TOO. A detector over a Silo
 * needs to know whether the field it was told to watch is captured at all, and
 * whether the window is long enough for its baseline ever to build.
 */
type CapturedFor = { siloId: string; fields: string[]; retentionDays: number };

async function siloCoverage(
  organisationId: string,
  conceptId: string,
): Promise<{ coverage: SiloCoverage; captured: CapturedFor | null }> {
  if (!env.SILOES_AVAILABLE) return { coverage: { state: 'compiled_out' }, captured: null };

  const held = await siloService.coverage(organisationId, conceptId);

  /* No Silo names this concept. From here that is the same offer as storage
     being off entirely, and the resolver phrases it that way. */
  if (!held) return { coverage: { state: 'off' }, captured: null };

  const captured = { siloId: held.siloId, fields: held.fields, retentionDays: held.retentionDays };

  if (held.transitions === 0 || held.since === null) {
    return { coverage: { state: 'empty' }, captured };
  }

  return {
    coverage: { state: 'covering', siloId: held.siloId, from: held.since.toISOString() },
    captured,
  };
}

/**
 * How many rows a history fetch may pull.
 *
 * HIGHER THAN A SNAPSHOT'S, BECAUSE A RANGE IS A DIFFERENT SHAPE OF QUESTION.
 * Six months of a busy table is the case that decides this: too low and drift
 * silently computes its baseline from a slice of the period it claims to cover,
 * which is worse than refusing, because the finding looks the same either way.
 */
const HISTORY_ROWS = 5000;

/**
 * What each contributing object declares about its own history.
 *
 * READ FROM THE MANIFESTS, NOT ASKED OF THE SOURCE. A capability check that
 * made a network call would cost a request per connection per run to learn
 * something the manifest already states — and would answer differently when a
 * system was briefly down, turning an outage into "this detector is
 * unavailable".
 */
async function historyCapabilities(
  actor: Actor,
  objects: ContributingObject[],
): Promise<{
  capabilities: SourceCapability[];
  /**
   * The manifest object per connection, which link capture reads for its
   * declared relationships.
   *
   * FROM THE SAME LOAD. The alternative is a second pass over every manifest
   * during the detector run, to answer a question the first pass already had
   * the data for.
   */
  manifestObjects: Map<string, ManifestObject>;
}> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const loaded = await connectorRepo.load(
          db,
          [...new Set(objects.map((object) => object.connectionId))],
        );

        const capabilities: SourceCapability[] = [];
        const manifestObjects = new Map<string, ManifestObject>();

        for (const object of objects) {
          const connection = loaded.find((one) => one.connectionId === object.connectionId);
          const manifestObject = connection?.manifest.objects.find(
            (one) => one.name === object.objectName,
          );

          /* An object the manifest no longer describes cannot be asked about
             its history either; the connection is halted or being rebuilt. */
          if (!manifestObject) continue;

          capabilities.push(capabilityOf(object.connectionId, manifestObject));
          manifestObjects.set(object.connectionId, manifestObject);
        }

        return { capabilities, manifestObjects };
      }),
  );
}

/** What a detector did, or why it did not. §3 — never silently omitted. */
export type DetectorOutcome =
  | { detector: string; status: 'ran'; historySource?: 'source' | 'silo' | 'both' }
  /** Runnable, and nobody said what to look at. */
  | { detector: string; status: 'not_configured' }
  /** The history exists and there is not enough of it yet. */
  | {
      detector: string;
      status: 'accumulating';
      haveInstances: number;
      needInstances: number;
      haveSpanDays: number;
      needSpanDays: number;
    }
  /** Nowhere holds what it needs, and the reason is specific. */
  | {
      detector: string;
      status: 'unavailable';
      reason: string;
      message: string;
      /** §3 — only where enabling storage would actually help. */
      offerStorage: boolean;
    };

/**
 * Run what can run, over one concept and one measure.
 *
 * EVERY PAIR, NOT EVERY SYSTEM AT ONCE. Three systems disagreeing is three
 * pairwise disagreements; flattening them into one finding loses which pair
 * differs, which is the only part anybody can act on.
 */
export async function run(
  actor: Actor,
  input: { conceptId: string; measure: Measure; limit?: number; examine?: Examine },
): Promise<{
  findings: RaisedFinding[];
  unresolved: number;
  compared: number;
  /** How many entities were examined, which §4's associations measure against. */
  populationN: number;
  /**
   * §3 — WHAT EVERY DETECTOR DID, OR WHY IT DID NOT. Ran, not configured, still
   * accumulating, or unavailable with a specific reason. This replaces a bare
   * `unavailable` list that named three detectors whenever Siloes were off, and
   * was wrong about all three whenever the source could have answered.
   */
  detectors: DetectorOutcome[];
}> {
  /*
   * §5 — ONE IDENTIFIER FOR THE WHOLE RUN. The disagreement detector compares
   * every pair of contributing sources and upserts the same finding once per
   * pair, so without this a three-system concept raised the same fact three
   * times and `raised_count` read a brand new finding as three runs old.
   */
  const runId = generateId();

  const objects = await load(actor, input.conceptId);

  const missing = objects.filter((o) => !input.measure.byConnection[o.connectionId]);
  if (missing.length > 0) {
    throw invalid({
      message: `Say where to read ${input.measure.name} in ${missing.map((m) => m.objectName).join(' and ')}.`,
      code: 'invalid.measure_unmapped',
    });
  }

  /*
   * FETCHED ONCE PER OBJECT, OUTSIDE THE TRANSACTION. Each of these is a real
   * request to somebody's own system; holding a database connection across them
   * is how a pool of ten runs out under four concurrent questions.
   */
  const examine = input.examine ?? {};

  /*
   * §3 — RESOLVE WHERE THE HISTORY LIVES BEFORE FETCHING ANY OF IT. The plan
   * decides whether a detector runs at all, and it is answered from what the
   * connections DECLARE rather than from what a query returns — so a detector
   * that cannot be answered costs no request to somebody's production system.
   */
  const { capabilities, manifestObjects } = await historyCapabilities(actor, objects);
  const plans = new Map<HistoryDetector, HistoryPlan>();

  /* RESOLVED ONCE, NOT PER DETECTOR. Coverage is a property of the concept, and
     three reads of the same count is three chances for them to disagree. */
  const { coverage, captured } = await siloCoverage(actor.organisationId, input.conceptId);

  for (const [detector, declared] of [
    ['timing_deviation', examine.timing],
    ['drift', examine.drift],
    ['recurrence', examine.recurrence],
  ] as const) {
    if (!declared) continue;
    plans.set(
      detector,
      resolveHistory({
        requirement: requirementFor(detector),
        sources: capabilities,
        silo: coverage,
      }),
    );
  }

  /** Per detector, per connection, the rows its history was read from. */
  const historyRows = new Map<string, Row[]>();
  const historyKey = (detector: string, connectionId: string) => `${detector}:${connectionId}`;

  const sources: SourceRows[] = [];
  /** Per connection, the rows of whatever object a reference points into. */
  const targets = new Map<string, Row[]>();

  for (const object of objects) {
    const answered = await askComplete({
      actor,
      connectionIds: [object.connectionId],
      query: {
        object: object.objectName,
        filters: [],
        sort: [],
        /*
         * ONLY THE FIELDS A DETECTOR READS. The identifier, the match keys, the
         * measure, and whatever the declarations above name. Asking for
         * everything would pull rows of customer data through this process to
         * look at one column of it — and the list growing with the declarations
         * is the point: a detector nobody configured costs nothing to fetch.
         */
        fields: [
          ...new Set([
            object.identifierField,
            ...object.matchKeys,
            input.measure.byConnection[object.connectionId]!,
            ...(examine.absence?.fields ?? []),
            ...(examine.referentialBreak ? [examine.referentialBreak.referenceField] : []),
            ...(examine.sequence?.stepFields ?? []),
            ...(examine.concentration
              ? [examine.concentration.groupField, examine.concentration.weightField].filter(
                  (field): field is string => Boolean(field),
                )
              : []),
          ]),
        ],
        limit: input.limit ?? 1000,
      },
    });

    sources.push({
      connectionId: object.connectionId,
      object,
      rows: answered[0]?.result?.rows ?? [],
    });

    /*
     * §3 — A REFERENCE INTO A SYSTEM THIS RUN DID NOT READ IS NOT BROKEN, it is
     * unchecked. Fetching the target is what makes the difference real rather
     * than a claim: reporting a permission boundary or a timed-out source as a
     * data quality problem is worse than reporting nothing.
     */
    if (examine.referentialBreak) {
      const into = await askComplete({
        actor,
        connectionIds: [object.connectionId],
        query: {
          object: examine.referentialBreak.targetObject,
          filters: [],
          sort: [],
          fields: [examine.referentialBreak.targetKeyField],
          limit: input.limit ?? 1000,
        },
      });

      targets.set(object.connectionId, into[0]?.result?.rows ?? []);
    }

    /*
     * ── History is its own fetch, deliberately ─────────────────────────────
     *
     * A SEPARATE QUERY BECAUSE IT IS A DIFFERENT QUESTION. The fetch above
     * reads a snapshot for the seven snapshot detectors; this one reads a
     * range. Adding a date filter to the shared fetch would silently narrow
     * duplication's and outlier's populations to the same window, changing
     * findings that have nothing to do with history.
     *
     * BOUNDED BY DATE, NOT ONLY BY LIMIT. Without the filter the source returns
     * whichever rows it likes first — frequently the oldest — and drift would
     * compute "the current period" from records two years old while reporting
     * it as this fortnight.
     */
    for (const [detector, declared] of [
      ['timing_deviation', examine.timing],
      ['drift', examine.drift],
      ['recurrence', examine.recurrence],
    ] as const) {
      if (!declared) continue;

      const plan = plans.get(detector);
      if (!plan || (plan.from !== 'source' && plan.from !== 'both')) continue;
      if (!plan.connections.includes(object.connectionId)) continue;

      const requirement = requirementFor(detector);
      const since = new Date(Date.now() - requirement.rangeDays * 86_400_000).toISOString();

      const dateField =
        detector === 'timing_deviation'
          ? examine.timing!.startField
          : detector === 'drift'
            ? examine.drift!.dateField
            : examine.recurrence!.dateField;

      const fields = [
        object.identifierField,
        dateField,
        ...(detector === 'timing_deviation'
          ? [examine.timing!.endField, examine.timing!.classField].filter(
              (field): field is string => Boolean(field),
            )
          : []),
        ...(detector === 'drift' && examine.drift!.subjectField
          ? [examine.drift!.subjectField]
          : []),
        ...(detector === 'recurrence' ? [examine.recurrence!.sourceField] : []),
      ];

      const answered = await askComplete({
        actor,
        connectionIds: [object.connectionId],
        query: {
          object: object.objectName,
          filters: [{ field: dateField, op: 'gte', value: since }],
          sort: [{ field: dateField, direction: 'desc' }],
          fields: [...new Set(fields)],
          /* A range needs more rows than a snapshot, and drift over six months
             of a busy table is the case that decides this number. */
          limit: HISTORY_ROWS,
        },
      });

      historyRows.set(
        historyKey(detector, object.connectionId),
        answered[0]?.result?.rows ?? [],
      );
    }
  }

  const raised: RaisedFinding[] = [];
  let unresolved = 0;
  let compared = 0;
  /* The biggest single source, which is the closest thing a federated pass has
     to "how many entities were examined". §4 measures lift against it. */
  let examined = 0;
  /** Per history detector: ran, still accumulating, or never reached. */
  const historyOutcomes = new Map<HistoryDetector, DetectorOutcome>();

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        /*
         * §4 — THE ROW'S OUTBOUND KEYS, CAPTURED WHILE IT IS IN HAND.
         *
         * Relating a finding about an invoice to one about its order needs to
         * know which order that invoice named, and the only free moment is now:
         * the fetch is already paid for and the row is in memory.
         *
         * BOTH PATHS GO THROUGH HERE. Disagreement is raised in the pairwise
         * loop and the other nine in the per-source loop, and a capture written
         * into one of them only — which is what I did first — silently gives
         * half the detectors links and half none.
         *
         * STORED RAW AND UNRESOLVED. Turning the key into a concept entity here
         * would couple detection to the resolver and make the result
         * unrepairable: a pair confirmed in September cannot fix a finding
         * written in March if the value it came from was replaced by an answer
         * that was wrong at the time.
         */
        const captureLinks = async (
          findingId: string,
          source: SourceRows,
          entityRef: string,
        ): Promise<void> => {
          const manifestObject = manifestObjects.get(source.connectionId);
          if (!manifestObject || manifestObject.relationships.length === 0) return;

          const row = source.rows.find(
            (candidate) => refOf(at(candidate, source.object.identifierField)) === entityRef,
          );
          if (!row) return;

          await findingRepo.replaceLinks(db, {
            organisationId: actor.organisationId,
            findingId,
            links: linksFrom({
              connectionId: source.connectionId,
              object: manifestObject,
              row,
            }),
          });
        };

        /*
         * §3.4 — DETERMINISTIC FIRST, TUNED BY THE MODEL, THEN PERSISTED.
         *
         * A threshold that has been through the loop is used directly; one that
         * has not is re-derived from the population every run, because a first
         * guess frozen against a population that has since changed is worse
         * than deriving it again. `thresholdFor` returns only tuned values for
         * exactly that reason.
         *
         * THE RUN IS RECORDED EITHER WAY. "Used several times" is the condition
         * §3.4 puts on trusting a threshold, and without counting it is a phrase
         * in a spec rather than something anything can test.
         */
        const thresholdOf = async (detector: string, derived: number): Promise<number> => {
          const learned = await thresholdFor(db, actor, {
            conceptId: input.conceptId,
            detector,
          });

          const value = learned ?? derived;

          /*
           * ── REUSING A DERIVED THRESHOLD DOES NOT MAKE IT TUNED ────────────
           *
           * This recorded `tuned` whenever a row already existed, so a purely
           * derived threshold became `tuned` on its SECOND run with nothing
           * having tuned it — and 036 keeps `tuned` sticky, so it never went
           * back.
           *
           * `origin` exists to tell "been through the loop, use it" from "a
           * first guess, re-derive when the population changes". After two runs
           * it could no longer tell them apart, and first guesses stopped being
           * re-derived. Only an actual adjustment sets `tuned`; see `tune`.
           */
          await recordThreshold(db, actor, {
            conceptId: input.conceptId,
            detector,
            value,
            origin: 'derived',
          });

          return value;
        };

        /* Loaded once for the run rather than per pair: the same concept's
           confirmed pairs are the same whichever two systems are compared. */
        const aliases = await resolutionRepo.confirmedFor(db, input.conceptId);

        for (let i = 0; i < sources.length; i += 1) {
          for (let j = i + 1; j < sources.length; j += 1) {
            const a = sources[i]!;
            const b = sources[j]!;

            /*
             * §3.4 — DERIVED FROM THE POPULATION, not from a stored setting, so
             * a newly connected pair produces sensible findings on the first
             * run. Tuning persists later, against the concept and detector.
             */
            const population = Math.min(a.rows.length, b.rows.length);
            const outcome = detectDisagreement(
              a,
              b,
              {
                name: input.measure.name,
                fieldPathA: input.measure.byConnection[a.connectionId]!,
                fieldPathB: input.measure.byConnection[b.connectionId]!,
              },
              {
                tolerance: await thresholdOf('disagreement', deriveTolerance(population)),
                /*
                 * §2.6 — WHAT SOMEBODY HAS ALREADY RECONCILED. Without these a
                 * confirmed pair leaves the queue and the two rows still never
                 * match, so the records a person took the trouble to reconcile
                 * are never compared — resolved on screen and unresolved in
                 * fact.
                 */
                aliases,
              },
            );

            compared += outcome.compared;

            for (const finding of outcome.findings) {
              const { id, raisedCount } = await findingRepo.upsert(db, {
                organisationId: actor.organisationId,
                detector: 'disagreement',
                conceptId: input.conceptId,
                entityRef: finding.entityRef,
                measure: finding.measure,
                observed: finding.observed,
                expected: finding.expected,
                deviation: finding.deviation,
                populationN: outcome.compared,
                population: { compared: outcome.compared, sources: [a.connectionId, b.connectionId] },
                lineage: finding.readings.map((r) => ({
                  connectionId: r.connectionId,
                  fieldPath: r.fieldPath,
                  ...(r.certainty ? { certainty: r.certainty } : {}),
                })),
                runId,
              });

              /* `entityRef` is read from `a`, so `a` is the row that carries
                 the keys this finding is about. */
              await captureLinks(id, a, finding.entityRef);

              raised.push({
                id,
                raisedCount,
                detector: 'disagreement',
                conceptId: input.conceptId,
                entityRef: finding.entityRef,
                measure: finding.measure,
                observed: finding.observed,
                expected: finding.expected,
                deviation: finding.deviation,
                populationN: outcome.compared,
                lineage: finding.readings.map((r) => ({
                  connectionId: r.connectionId,
                  fieldPath: r.fieldPath,
                  ...(r.certainty ? { certainty: r.certainty } : {}),
                })),
                detectedAt: new Date().toISOString(),
              });
            }

            /*
             * §2.6 — the pairs that would not resolve become questions, not
             * guesses. Recorded once; asking the same one twice would make the
             * queue grow every time anybody ran a detector.
             */
            for (const pair of outcome.unresolved) {
              /*
               * §2.6 — THE QUESTIONS, THROUGH THE REPO THAT KNOWS THE RULES.
               * This was an inline INSERT that wrote `value_ref_b` as an empty
               * string against a CHECK forbidding it, so every run that found
               * an unresolved pair failed here. 041 makes an unnamed other side
               * legal; `recordPair` is what keeps the canonical rule and the
               * conflict target in one place.
               */
              await resolutionRepo.recordPair(db, {
                organisationId: actor.organisationId,
                conceptId: input.conceptId,
                connectionA: pair.connectionA,
                valueRefA: pair.valueRefA,
                connectionB: pair.connectionB,
                valueRefB: pair.valueRefB,
              });

              unresolved += 1;
            }
          }
        }

        /*
         * ── The six that run over one source at a time ────────────────────
         *
         * FEDERATED MEANS NO HISTORY AND NO SECOND SYSTEM. Disagreement above
         * needs a pair; these read one object's rows and answer from that pass
         * alone, which is why they work the moment a single connection exists
         * and why §3.1's three are missing rather than merely quiet.
         *
         * EACH ONE'S FINDINGS ARE UPSERTED UNDER ITS OWN NAME, so the same
         * entity can carry a duplication finding and an outlier finding without
         * either replacing the other — `findings_unique` is keyed on the
         * detector for exactly that reason.
         */
        /**
         * §12 — raise a finding whose evidence came out of a Silo.
         *
         * SEPARATE FROM `record` BECAUSE THERE IS NO ROW. The source path
         * captures a finding's outbound links from the row it was raised on; a
         * transition carries no relationships to follow.
         *
         * LINEAGE NAMES EVERY SYSTEM AND A REAL FIELD PATH. It named the first
         * transition's connection for evidence drawn from all of them, and put
         * the detector's prose label where a field path belongs.
         */
        const recordFromSilo = async (
          detector: string,
          outcome: Outcome,
          connectionIds: string[],
          fieldPath: string,
        ): Promise<void> => {
          const lineage = connectionIds.map((connectionId) => ({
            connectionId,
            fieldPath,
            historySource: 'silo' as const,
          }));

          for (const found of outcome.findings) {
            const { id, raisedCount } = await findingRepo.upsert(db, {
              organisationId: actor.organisationId,
              detector,
              conceptId: input.conceptId,
              entityRef: found.entityRef,
              measure: found.measure,
              observed: found.observed,
              expected: found.expected,
              deviation: found.deviation,
              populationN: outcome.populationN,
              population: {
                examined: outcome.populationN,
                sources: connectionIds,
                evidence: found.evidence,
              },
              lineage,
              occurredAt: found.occurredAt ?? null,
              historySource: 'silo',
              runId,
            });

            raised.push({
              id,
              raisedCount,
              detector,
              conceptId: input.conceptId,
              entityRef: found.entityRef,
              measure: found.measure,
              observed: found.observed,
              expected: found.expected,
              deviation: found.deviation,
              populationN: outcome.populationN,
              lineage,
              detectedAt: new Date().toISOString(),
              occurredAt: found.occurredAt ?? null,
              historySource: 'silo',
            });
          }
        };

        for (const source of sources) {
          const object = source.object;

          /*
           * THE ROW BEHIND EACH FINDING, INDEXED ONCE. Capturing a finding's
           * outbound links needs the row it was raised on, and scanning for it
           * per finding is quadratic over a page of a thousand.
           *
           * Keyed the way `refOf` keys an entity reference, so the lookup
           * cannot miss because one side was bounded and the other was not.
           */
          const rowByRef = new Map<string, Row>();
          for (const row of source.rows) {
            const ref = refOf(at(row, object.identifierField));
            if (ref !== '' && !rowByRef.has(ref)) rowByRef.set(ref, row);
          }


          const record = async (
            detector: string,
            outcome: Outcome,
            measure?: string,
            historySource?: 'source' | 'silo' | 'both',
          ) => {
            for (const found of outcome.findings) {
              const { id, raisedCount } = await findingRepo.upsert(db, {
                organisationId: actor.organisationId,
                detector,
                conceptId: input.conceptId,
                entityRef: found.entityRef,
                measure: measure ?? found.measure,
                observed: found.observed,
                expected: found.expected,
                deviation: found.deviation,
                populationN: outcome.populationN,
                population: {
                  examined: outcome.populationN,
                  sources: [source.connectionId],
                  evidence: found.evidence,
                },
                /*
                 * §3 — LINEAGE SAYS WHERE THE PAST CAME FROM. "Open 31 days
                 * against a norm of 4" is a different claim read live from the
                 * source than read from a Silo that last collected on Tuesday,
                 * and somebody challenging it needs to know which.
                 */
                lineage: [
                  {
                    connectionId: source.connectionId,
                    fieldPath: found.measure,
                    ...(historySource ? { historySource } : {}),
                  },
                ],
                occurredAt: found.occurredAt ?? null,
                historySource: historySource ?? null,
                runId,
              });

              await captureLinks(id, source, found.entityRef);

              raised.push({
                id,
                raisedCount,
                detector,
                conceptId: input.conceptId,
                entityRef: found.entityRef,
                measure: measure ?? found.measure,
                observed: found.observed,
                expected: found.expected,
                deviation: found.deviation,
                populationN: outcome.populationN,
                lineage: [
                  {
                    connectionId: source.connectionId,
                    fieldPath: found.measure,
                    ...(historySource ? { historySource } : {}),
                  },
                ],
                detectedAt: new Date().toISOString(),
                occurredAt: found.occurredAt ?? null,
                historySource: historySource ?? null,
              });
            }
          };

          examined = Math.max(examined, source.rows.length);

          /* Identity is what the concept already agreed on, so this needs no
             declaration: duplicates ARE rows sharing the match keys. */
          await record(
            'duplication',
            detectDuplication(source.rows, object.matchKeys, object.identifierField),
          );

          const measureField = input.measure.byConnection[source.connectionId]!;
          await record(
            'outlier',
            detectOutlier(
              source.rows,
              { identifierField: object.identifierField, measure: measureField },
              { threshold: await thresholdOf('outlier', deriveOutlierThreshold(source.rows.length)) },
            ),
            input.measure.name,
          );

          if (examine.absence) {
            await record(
              'absence',
              detectAbsence(source.rows, examine.absence.fields, {
                tolerance: await thresholdOf(
                  'absence',
                  deriveAbsenceTolerance(source.rows.length),
                ),
              }),
            );
          }

          if (examine.referentialBreak) {
            await record(
              'referential_break',
              detectReferentialBreak(source.rows, {
                referenceField: examine.referentialBreak.referenceField,
                identifierField: object.identifierField,
                targetRows: targets.get(source.connectionId) ?? [],
                targetKeyField: examine.referentialBreak.targetKeyField,
              }),
            );
          }

          if (examine.sequence) {
            await record(
              'sequence_violation',
              detectSequenceViolation(source.rows, {
                identifierField: object.identifierField,
                stepFields: examine.sequence.stepFields,
              }),
            );
          }

          if (examine.concentration) {
            const outcome = detectConcentration(
              source.rows,
              {
                groupField: examine.concentration.groupField,
                weightField: examine.concentration.weightField,
              },
              /* The multiple depends on how many nodes there are, which the
                 detector counts — so the threshold is derived from the shape of
                 the answer rather than from the size of the fetch. */
              {
                multiple: await thresholdOf(
                  'concentration',
                  deriveConcentrationMultiple(
                    new Set(
                      source.rows
                        .map((row) => row[examine.concentration!.groupField])
                        .filter((value) => value !== null && value !== undefined && value !== ''),
                    ).size,
                  ),
                ),
              },
            );

            await record('concentration', outcome);
          }

          /*
           * ── The three that read a range ─────────────────────────────────
           *
           * THEY RUN HERE, BESIDE THE OTHERS, WITH NO STORAGE INVOLVED. Their
           * rows were fetched from whatever `engine/history` resolved — usually
           * the source system, which already holds the history — and the
           * detectors themselves cannot tell the difference.
           *
           * THE BASELINE IS CHECKED BEFORE EACH ONE RUNS. §3 — a history source
           * that exists but has not accumulated enough is a THIRD STATE,
           * neither available nor unavailable. Drift over four data points is
           * arithmetically correct and practically noise, and shipping that
           * teaches somebody the detector is broken.
           */
          for (const [detector, declared] of [
            ['timing_deviation', examine.timing],
            ['drift', examine.drift],
            ['recurrence', examine.recurrence],
          ] as const) {
            if (!declared) continue;

            const plan = plans.get(detector);
            if (!plan || (plan.from !== 'source' && plan.from !== 'both')) continue;
            if (!plan.connections.includes(source.connectionId)) continue;

            const rows = historyRows.get(historyKey(detector, source.connectionId)) ?? [];
            const requirement = requirementFor(detector);

            /*
             * A FULL PAGE IS A REFUSAL, NOT A RANGE. The history query asks for at
             * most HISTORY_ROWS, newest first, so a source with more in the range
             * came back with its newest slice — and the detector ran on that as
             * though it were the whole period, a finding about the last few weeks
             * presented as one about six months. The Silo path already refuses
             * this; the source path now says the same, unless another source
             * answered in full.
             */
            if (rows.length >= HISTORY_ROWS) {
              if (historyOutcomes.get(detector)?.status !== 'ran') {
                historyOutcomes.set(detector, {
                  detector,
                  status: 'unavailable',
                  reason: 'bounds.history_rows',
                  message:
                    `The source holds at least ${HISTORY_ROWS} records in the last ` +
                    `${requirement.rangeDays} days, which is more than one run reads. Running ` +
                    'on part of the range would describe part of it as all of it.',
                  offerStorage: false,
                });
              }
              continue;
            }

            const dateField =
              detector === 'timing_deviation'
                ? examine.timing!.startField
                : detector === 'drift'
                  ? examine.drift!.dateField
                  : examine.recurrence!.dateField;

            const seen = rows
              .map((row) => at(row, dateField))
              .map((value) => (typeof value === 'string' ? Date.parse(value) : NaN))
              .filter((value) => !Number.isNaN(value))
              .sort((a, b) => a - b);

            const baseline = baselineOf(requirement, {
              instances: rows.length,
              earliest: seen[0] === undefined ? null : new Date(seen[0]).toISOString(),
              latest:
                seen[seen.length - 1] === undefined
                  ? null
                  : new Date(seen[seen.length - 1]!).toISOString(),
            });

            if (baseline.state === 'accumulating') {
              /* Only where nothing better has been seen: another source may
                 have enough, and one that does is the answer for the run. */
              if (historyOutcomes.get(detector)?.status !== 'ran') {
                historyOutcomes.set(detector, { detector, ...baseline, status: 'accumulating' });
              }
              continue;
            }

            /*
             * A `both` PLAN RUNS AS THE SOURCE, AND IS LABELLED THE SOURCE.
             * `both` was designed for a Silo that holds copies of the source's
             * dated records, so the baseline could come from one and the
             * current period from the other. A Silo holds changes, not records:
             * there is nothing in it of the shape these rows have, and
             * `mergeBoundary` was computed and never used. Stamping these
             * findings `both` claimed a Silo contributed when nothing had read
             * one.
             */
            const from = 'source' as const;

            if (detector === 'timing_deviation') {
              await record(
                'timing_deviation',
                detectTimingDeviation(
                  rows,
                  {
                    identifierField: object.identifierField,
                    startField: examine.timing!.startField,
                    endField: examine.timing!.endField,
                    classField: examine.timing!.classField,
                  },
                  {
                    threshold: await thresholdOf(
                      'timing_deviation',
                      deriveTimingThreshold(rows.length),
                    ),
                  },
                ),
                undefined,
                from,
              );
            }

            if (detector === 'drift') {
              const bucketDays = deriveBucketDays(requirement.rangeDays);
              await record(
                'drift',
                detectDrift(
                  rows,
                  {
                    dateField: examine.drift!.dateField,
                    subjectField: examine.drift!.subjectField,
                    label: examine.drift!.label ?? input.measure.name,
                  },
                  {
                    bucketDays,
                    threshold: await thresholdOf(
                      'drift',
                      deriveDriftThreshold(Math.floor(requirement.rangeDays / bucketDays)),
                    ),
                  },
                ),
                undefined,
                from,
              );
            }

            if (detector === 'recurrence') {
              await record(
                'recurrence',
                detectRecurrence(
                  rows,
                  {
                    sourceField: examine.recurrence!.sourceField,
                    dateField: examine.recurrence!.dateField,
                  },
                  {
                    threshold: await thresholdOf(
                      'recurrence',
                      deriveRecurrenceThreshold(
                        new Set(rows.map((row) => at(row, examine.recurrence!.sourceField))).size,
                      ),
                    ),
                  },
                ),
                undefined,
                from,
              );
            }

            historyOutcomes.set(detector, { detector, status: 'ran', historySource: from });
          }
        }

        /*
         * ── §12: the detectors that read a Silo ────────────────────────────
         *
         * REACHED ONLY WHERE NO SOURCE HAD THE RIGHT SHAPE. The resolver tries
         * the source first and always will: a Silo is a copy, and reading a copy
         * when the original can answer turns every staleness bug in the copy
         * into a wrong finding carrying full confidence.
         *
         * TRANSITIONS ARE NOT ROWS AND THE DETECTORS ARE NOT LIED TO ABOUT IT.
         * Drift over them measures HOW OFTEN a field changes, not the level of
         * the measure, and the label says so. No value is read: the detectors
         * count changes and never need what the field said.
         *
         * EVERY WAY THIS CAN FAIL TO RUN IS SAID, not skipped. A window too
         * short for the baseline, a subject the Silo does not capture, a range
         * holding more than one run may read — each one used to end in
         * "accumulating" for ever or in a finding about part of the range.
         */
        for (const [detector, declared] of [
          ['timing_deviation', examine.timing],
          ['drift', examine.drift],
          ['recurrence', examine.recurrence],
        ] as const) {
          if (!declared) continue;

          const plan = plans.get(detector);
          if (plan?.from !== 'silo' || !captured) continue;

          const requirement = requirementFor(detector);
          const unavailable = (reason: string, message: string) =>
            historyOutcomes.set(detector, {
              detector,
              status: 'unavailable',
              reason,
              message,
              offerStorage: false,
            });

          /* Two timestamps on one record; a transition has one. And the only
             plan that reaches here is one where no source is dated. */
          if (detector === 'timing_deviation') {
            unavailable(
              'source_not_dated',
              'How long something took needs a start and an end on one record. No source here ' +
                'dates its records, and a Silo keeps changes rather than records.',
            );
            continue;
          }

          /* A WINDOW SHORTER THAN THE SPAN IS A BASELINE THAT NEVER BUILDS. It
             would report "accumulating" on every run, for ever. */
          if (captured.retentionDays < requirement.minimumSpanDays) {
            unavailable(
              'retention_too_short',
              `This needs ${requirement.minimumSpanDays} days of changes and the Silo keeps ` +
                `${captured.retentionDays}. Lengthen its window for this to run.`,
            );
            continue;
          }

          /*
           * THE SUBJECT IS A SOURCE COLUMN; A TRANSITION NAMES A CONCEPT FIELD.
           * `subjectField` is what the source-backed run reads off a row, and
           * `field_path` holds the concept's own field names — so filtering one
           * by the other matched nothing and drift reported "accumulating" for
           * ever. It is mapped through the concept, and a subject no nominated
           * field maps to is said to be uncaptured.
           */
          let fieldPath: string | undefined;
          if (detector === 'drift' && examine.drift!.subjectField) {
            const subject = examine.drift!.subjectField;
            fieldPath = objects
              .flatMap((object) =>
                Object.entries(object.fieldMap)
                  .filter(([, column]) => column === subject)
                  .map(([field]) => field),
              )
              .find((field) => captured.fields.includes(field));

            if (!fieldPath) {
              unavailable(
                'field_not_captured',
                `Drift was asked to watch ${subject}, and the Silo does not capture it.`,
              );
              continue;
            }
          }

          const read = await siloRepo.changesFor(db, {
            siloId: plan.siloId,
            conceptId: input.conceptId,
            fieldPath,
            since: new Date(Date.now() - requirement.rangeDays * 24 * 60 * 60 * 1000),
            limit: HISTORY_ROWS,
          });

          /* §10 — scanned is scanned, whether or not the run goes on to use it. */
          await siloRepo.recordScan(db, plan.siloId, read.bytes);

          /* REFUSED, NOT TRUNCATED. The newest five thousand of a busier range
             describe part of it, and the finding would say all of it. */
          if (read.truncated) {
            unavailable(
              'bounds.history_rows',
              `The Silo holds more than ${HISTORY_ROWS} changes in the last ` +
                `${requirement.rangeDays} days, which is more than one run reads. Running on ` +
                'part of the range would describe part of it as all of it.',
            );
            continue;
          }

          /*
           * THE SAME BASELINE CHECK THE SOURCE PATH GETS. A Silo enabled last
           * Tuesday holds a fortnight of changes, and drift computed from those
           * is a statement about a fortnight presented as one about six months.
           */
          const changes = read.changes;
          const baseline = baselineOf(requirement, {
            instances: changes.length,
            earliest: changes[0]?.observedAt.toISOString() ?? null,
            latest: changes[changes.length - 1]?.observedAt.toISOString() ?? null,
          });

          if (baseline.state === 'accumulating') {
            historyOutcomes.set(detector, { detector, ...baseline, status: 'accumulating' });
            continue;
          }

          const rows: Row[] = changes.map((change) => ({
            entityRef: change.entityRef,
            fieldPath: change.fieldPath,
            observedAt: change.observedAt.toISOString(),
          }));

          /* EVERY SYSTEM THE CHANGES CAME FROM, not the first one's. */
          const connectionIds = [...new Set(changes.map((change) => change.connectionId))].sort();
          /* A field path in lineage, never a label: `*` is every nominated field. */
          const watched = fieldPath ?? '*';

          if (detector === 'drift') {
            const bucketDays = deriveBucketDays(requirement.rangeDays);
            await recordFromSilo(
              'drift',
              detectDrift(
                rows,
                {
                  dateField: 'observedAt',
                  label: fieldPath ? `changes to ${fieldPath}` : 'recorded changes',
                },
                {
                  bucketDays,
                  threshold: await thresholdOf(
                    'drift',
                    deriveDriftThreshold(Math.floor(requirement.rangeDays / bucketDays)),
                  ),
                },
              ),
              connectionIds,
              watched,
            );
          }

          if (detector === 'recurrence') {
            await recordFromSilo(
              'recurrence',
              detectRecurrence(
                rows,
                { sourceField: 'entityRef', dateField: 'observedAt' },
                {
                  threshold: await thresholdOf(
                    'recurrence',
                    deriveRecurrenceThreshold(new Set(rows.map((row) => at(row, 'entityRef'))).size),
                  ),
                },
              ),
              connectionIds,
              watched,
            );
          }

          historyOutcomes.set(detector, { detector, status: 'ran', historySource: 'silo' });
        }

        await writeAudit(db, {
          event: 'detector_run',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            detector: [...new Set(raised.map((finding) => finding.detector))].join(', ') || 'none',
            conceptId: input.conceptId,
            measure: input.measure.name,
            compared,
            examined,
            raised: raised.length,
            unresolved,
          },
        });

        log.info(
          { conceptId: input.conceptId, compared, examined, raised: raised.length, unresolved },
          'Detectors ran',
        );

        /*
         * ── §3's four behaviours, said per detector ─────────────────────────
         *
         * NOTHING IS SILENTLY OMITTED. A detector that did not run is reported
         * with which of the four it was, because a short findings list with no
         * explanation reads as "nothing is wrong here" — the one conclusion
         * none of these states supports.
         *
         * THE FOUR ARE GENUINELY DIFFERENT AND A PERSON ACTS DIFFERENTLY ON
         * EACH. `not_configured`: tell it which fields to look at.
         * `accumulating`: wait, and here is how long. `unavailable` with an
         * offer: turn on storage. `unavailable` without one: nothing you can do
         * from here, and pretending otherwise wastes your time.
         */
        const detectors: DetectorOutcome[] = [];

        for (const detector of NEEDS_DECLARING) {
          const declared =
            detector === 'absence' ? examine.absence
            : detector === 'referential_break' ? examine.referentialBreak
            : detector === 'sequence_violation' ? examine.sequence
            : detector === 'concentration' ? examine.concentration
            : detector === 'timing_deviation' ? examine.timing
            : detector === 'drift' ? examine.drift
            : examine.recurrence;

          if (!declared) {
            detectors.push({ detector, status: 'not_configured' });
            continue;
          }

          const plan = plans.get(detector as HistoryDetector);

          if (plan?.from === 'unavailable') {
            const said = explain(plan);
            detectors.push({
              detector,
              status: 'unavailable',
              reason: plan.reason,
              message: said.message,
              offerStorage: said.offerStorage,
            });
            continue;
          }

          detectors.push(
            historyOutcomes.get(detector as HistoryDetector) ?? { detector, status: 'ran' },
          );
        }

        /* The four that never needed declaring ran, and say so. */
        for (const detector of ['disagreement', 'duplication', 'outlier']) {
          detectors.push({ detector, status: 'ran' });
        }

        /* §5 — scored before the run is let go of, because half of what a
           score is made of only exists while the run is in hand. */
        await scoreRun(db, { conceptId: input.conceptId, raised });

        return {
          findings: raised,
          unresolved,
          compared,
          populationN: examined,
          detectors,
        };
      }),
  );
}

/* ── §5 Scoring ──────────────────────────────────────────────────────────── */

/**
 * Score everything a run raised, against the run it came out of.
 *
 * ── Why it happens here and not at read time ───────────────────────────────
 *
 * Half of what a score is made of only exists while the run is in hand: the
 * spread of the detector's own other findings, which detectors independently
 * noticed the same entity, and where the paths out of those findings arrived.
 * Reading the table later would score a finding against whatever else happens
 * to be in it that day, silently reordering findings nobody re-ran.
 *
 * ── And why the arithmetic is somewhere else ───────────────────────────────
 *
 * This function FETCHES; `engine/scoring` DECIDES. Everything below gathers
 * six numbers per finding from four sources and hands them over, which is what
 * lets the weighting be tested exhaustively with no database anywhere near it.
 *
 * WITHIN A DETECTOR, NEVER ACROSS. A disagreement's deviation is two systems
 * differing by 40%; an outlier's is a value six median-absolute-deviations from
 * its population. Those are not commensurable, and putting one above the other
 * is §5's ranking stage, which reads the whole set and explains itself.
 */
async function scoreRun(
  db: Parameters<typeof findingRepo.recordScores>[0],
  input: { conceptId: string; raised: RaisedFinding[] },
): Promise<void> {
  if (input.raised.length === 0) return;

  /*
   * ── ONE ENTRY PER FINDING, BECAUSE ONE FINDING CAN BE RAISED TWICE ────────
   *
   * The disagreement detector compares every pair of contributing sources, and
   * the same (detector, concept, entity, measure) is one ROW however many pairs
   * produced it — so a three-system concept pushes the same finding id into
   * `raised` three times.
   *
   * Left alone that does three separate kinds of damage: the same deviation
   * counts three times in the median and MAD the whole run is measured
   * against, `recordScores` receives three rows for one id in a single
   * `UPDATE ... FROM` and Postgres picks one of them arbitrarily, and
   * corroboration counts one detector as three.
   *
   * LAST WINS, because the last upsert is the one whose figures are in the row.
   */
  const byFinding = new Map(input.raised.map((finding) => [finding.id, finding]));
  const raised = [...byFinding.values()];

  const links = await findingRepo.linksFor(
    db,
    raised.map((finding) => finding.id),
  );

  /*
   * ── Corroboration: detectors, not findings ────────────────────────────────
   *
   * Three findings from one detector about one entity is one detector's
   * opinion three times. Three detectors is three independent pieces of
   * arithmetic that happened to land on the same instance, which is the thing
   * actually worth surfacing.
   */
  const detectorsByEntity = new Map<string, Set<string>>();
  for (const finding of raised) {
    const at = detectorsByEntity.get(finding.entityRef) ?? new Set<string>();
    at.add(finding.detector);
    detectorsByEntity.set(finding.entityRef, at);
  }

  /*
   * ── Path concentration: where the trouble arrives ─────────────────────────
   *
   * Matched the way §4 matches everywhere else — trimmed and case-folded at
   * READ time, over values stored exactly as their sources stated them, so a
   * change to this rule reinterprets findings already written rather than only
   * future ones.
   */
  const arrivalKey = (link: { connectionId: string; targetObject: string; value: string }) =>
    `${link.connectionId} ${link.targetObject} ${link.value.trim().toLowerCase()}`;

  const arrivalsByFinding = new Map<string, Set<string>>();
  const findingsByArrival = new Map<string, number>();

  for (const link of links) {
    const key = arrivalKey(link);
    const mine = arrivalsByFinding.get(link.findingId) ?? new Set<string>();
    if (!mine.has(key)) {
      mine.add(key);
      findingsByArrival.set(key, (findingsByArrival.get(key) ?? 0) + 1);
    }
    arrivalsByFinding.set(link.findingId, mine);
  }

  const withLinks = arrivalsByFinding.size;

  /*
   * ── Outcome proximity: hops to something the customer said matters ────────
   *
   * §4.2 — NOTHING HERE DECIDES WHAT AN OUTCOME IS. A designation is somebody
   * in this organisation stating that this field is one they are judged on, and
   * proximity is the plain graph distance to the nearest such concept, over the
   * same relationships §4.1 walks.
   *
   * A CONCEPT SOMEBODY DESIGNATED IS ZERO HOPS FROM ITSELF, whichever field the
   * designation sits on: the designation says this concept is where outcomes
   * live, and which column of it carries the direction is the ranking stage's
   * business rather than a distance.
   */
  const designated = new Set(
    (await associationRepo.liveDesignations(db)).map((one) => one.conceptId),
  );

  let hopsToOutcome: number | null = null;

  if (designated.has(input.conceptId)) {
    hopsToOutcome = 0;
  } else if (designated.size > 0) {
    const relationships = await conceptRepo.relationships(db);

    for (const target of designated) {
      const [nearest] = routesBetween({
        relationships,
        from: input.conceptId,
        to: target,
        maxHops: DEFAULT_LIMITS.maxHops,
      });

      if (!nearest) continue;
      if (hopsToOutcome === null || nearest.steps.length < hopsToOutcome) {
        hopsToOutcome = nearest.steps.length;
      }
    }
  }

  /* The spread each finding is measured against: its OWN detector's run. */
  const deviationsByDetector = new Map<string, number[]>();
  for (const finding of raised) {
    if (finding.deviation === null) continue;
    deviationsByDetector.set(finding.detector, [
      ...(deviationsByDetector.get(finding.detector) ?? []),
      finding.deviation,
    ]);
  }

  const scored = raised.map((finding) => {
    const arrivals = arrivalsByFinding.get(finding.id);

    /* The most concentrated of this finding's arrivals. A finding pointing at
       two things is as concentrated as its most-shared one. */
    const sharing = arrivals
      ? Math.max(...[...arrivals].map((key) => findingsByArrival.get(key) ?? 0))
      : 0;

    const result = score({
      finding: { deviation: finding.deviation, populationN: finding.populationN },
      population: { deviations: deviationsByDetector.get(finding.detector) ?? [] },
      corroboratedBy: [...(detectorsByEntity.get(finding.entityRef) ?? [])].filter(
        (other) => other !== finding.detector,
      ),
      ...(arrivals ? { paths: { sharing, total: withLinks } } : {}),
      runs: finding.raisedCount,
      hopsToOutcome,
    });

    return {
      findingId: finding.id,
      score: result.score,
      components: result.components as Record<string, number>,
    };
  });

  await findingRepo.recordScores(db, scored);
}

/**
 * The objects a live concept contributes, or a refusal naming which.
 *
 * A RETIRED CONCEPT AND A CONCEPT WITH NOTHING IN IT ARE BOTH "NO SUCH THING"
 * here, which is what the query this replaced said by joining to live concepts
 * and finding no rows. Neither can be run against, and neither is the caller
 * having asked for too much.
 */
async function load(actor: Actor, conceptId: string): Promise<ContributingObject[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const concept = await conceptRepo.read(db, conceptId);

        if (!concept || concept.retiredAt || concept.objects.length === 0) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }

        /*
         * CLEARANCE BEFORE ANY ROW IS READ. A run reads a marked concept's
         * records out of its systems — and, where a Silo holds it, out of stored
         * history — then writes findings naming its entities. `list` already
         * drops findings about a concept the reader is not cleared for; `run`
         * raised fresh ones for them. The same rule as `concept.resolve`: this
         * is an act that reveals a restricted record's existence.
         */
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        await assertCleared(db, authority, { type: 'concept', id: conceptId });

        /*
         * §2.7 AGAIN, AT RUN TIME. A concept confirmed across two connections
         * can lose one — revoked, retired, a grant withdrawn — and then there is
         * nothing to compare against. Refusing is the honest answer; returning
         * zero findings would read as agreement.
         */
        if (concept.objects.length < 2) {
          throw invalid({
            message:
              'This concept only reaches one system now, so there is nothing to compare it against.',
            code: 'invalid.concept_needs_two',
          });
        }

        /*
         * FIELD POLICY: a detector compares the fields this person may see. A
         * finding about a field hidden from them would publish, as a disagreement,
         * exactly the values the policy withholds.
         */
        const hidden = await hiddenFields(db, actor, concept.objects.map((one) => one.connectionId));
        return visibleObjects(concept.objects, hidden);
      }),
  );
}

/**
 * §3.2 — what somebody decided about a finding.
 *
 * PER PERSON, NEVER FOR EVERYBODY. §6.6: silenced for the person, not the
 * organisation. A colleague looking for something else has not agreed that this
 * is noise, and one dismissal removing it from their view would make the
 * feedback loop a censorship mechanism.
 *
 * A DISMISSAL CARRIES ITS REASON, enforced by the schema as well as here. It is
 * doing two jobs: the signal that teaches ranking what this person finds
 * significant, and the evidence that somebody saw this and judged it — which is
 * what matters if the finding later turns out to have been important.
 */
export async function decide(
  actor: Actor,
  input: { findingId: string; disposition: 'confirmed' | 'dismissed' | 'not_relevant'; reason?: string },
): Promise<void> {
  if (needsReason(input.disposition) && !input.reason?.trim()) {
    throw invalid({
      message: 'Say why it is not worth looking at. An unexplained dismissal is indistinguishable from a misclick.',
      code: 'invalid.dismissal_needs_reason',
    });
  }

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const finding = await findingRepo.read(db, input.findingId);
        if (!finding) {
          throw notFound({ message: 'That finding does not exist.', code: 'missing.finding' });
        }

        await findingRepo.saveDisposition(db, {
          organisationId: actor.organisationId,
          findingId: input.findingId,
          membershipId: actor.membershipId,
          disposition: input.disposition,
          reason: input.reason?.trim() ?? null,
        });

        /*
         * §6.6 — THE DISPOSITION WRITES TO THE MAP, in the same transaction, so
         * a decision that recorded but did not teach cannot happen. Silenced for
         * the person and not the organisation: `recordDisposition` writes to
         * this membership's own map and nowhere else.
         *
         * IT NEVER REACHES A DETECTOR. The weight moves ranking and connector
         * selection; the arithmetic in `engine/detectors` does not know maps
         * exist, which is what keeps "the same data produces the same findings"
         * true.
         */
        await recordDisposition(db, actor, {
            conceptId: finding.conceptId,
            detector: finding.detector,
          disposition: input.disposition,
        });

        await writeAudit(db, {
          event: input.disposition === 'dismissed' ? 'finding_dismissed' : 'finding_confirmed',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { findingId: input.findingId, disposition: input.disposition, reason: input.reason ?? null },
        });
      }),
  );
}

/**
 * The findings this person has not already decided about.
 *
 * THEIR OWN DISPOSITION HIDES IT; NOBODY ELSE'S DOES. The join is on this
 * membership, which is what makes §6.6 true in the query rather than in a
 * comment above it.
 */
export async function list(actor: Actor, options: { includeDecided?: boolean } = {}) {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const found = await findingRepo.forReader(db, {
          membershipId: actor.membershipId,
          includeDecided: options.includeDecided ?? false,
        });

        /*
         * ── §2.5 — a finding names the concept it is about ─────────────────
         *
         * Which means a list of findings is a list of the concepts that
         * produced them, and a concept's markings exist precisely because
         * resolving one reveals that a restricted record EXISTS. Returning a
         * finding about a marked concept to somebody with no clearance is the
         * same disclosure through a different door: the entity reference, the
         * count, and the fact that anything was found at all.
         *
         * DROPPED, NOT REFUSED. One marked concept among ten must not make the
         * whole list an error — that would tell the reader a compartment exists
         * and that something in it is relevant to them, which is what a
         * compartment hides. They get the findings they are cleared for and no
         * indication that there were others.
         *
         * The alternative — filtering in the query — would need the clearance
         * join in `findingRepo`, and a permission rule in a repo applies only to
         * the callers who happen to use that repo.
         */
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        const cleared = new Set<string>();

        for (const conceptId of new Set(found.map((finding) => finding.conceptId))) {
          const required = await authzRepo.markingsOnResource(db, 'concept', conceptId);
          if (checkMarkings({ required }, { held: authority.clearances }).permitted) {
            cleared.add(conceptId);
          }
        }

        return found
          .filter((finding) => cleared.has(finding.conceptId))
          .map((finding) => ({
            id: finding.id,
            detector: finding.detector,
            conceptId: finding.conceptId,
            concept: finding.conceptName,
            entityRef: finding.entityRef,
            measure: finding.measure,
            observed: finding.observed,
            expected: finding.expected,
            deviation: finding.deviation,
            populationN: finding.populationN,
            lineage: finding.lineage,
            detectedAt: finding.detectedAt.toISOString(),
            disposition: finding.disposition,
            /*
             * §5 — WHAT TO READ FIRST, AND WHAT THAT WAS MADE OF. The list is
             * already ordered by it; sending the number without the components
             * would make the order something the reader has to take on trust,
             * which is the one thing §5.2 does not allow of a placement.
             */
            score: finding.score,
            scoreComponents: finding.scoreComponents,
            /* When it was first true, and how many runs have raised it — the
               two facts `detected_at` alone could never answer, because every
               upsert overwrites it. */
            firstDetectedAt: finding.firstDetectedAt.toISOString(),
            raisedCount: finding.raisedCount,
          }));
      }),
  );
}
