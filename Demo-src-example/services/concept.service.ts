import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import { bounds, invalid, notFound, policy } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { childLogger } from '../config/logger.config';
import { assertCan, assertCleared, authorityOf } from './authorisation.service';
import * as authzRepo from '../repos/authz.repo';
import { checkMarkings } from '../utils/markingCheck.util';
import * as resolutionRepo from '../repos/resolution.repo';
import { complete, identify, resolveEntities } from '../engine/ontology/resolve.ontology';
import { describeRoute, relate, routesBetween } from '../engine/ontology/relate.ontology';
import * as fieldAliasRepo from '../repos/fieldAlias.repo';
import { absorb, beginWalk, nextQuery, objectKey, pathsThrough } from '../engine/ontology/traverse.ontology';
import { DEFAULT_LIMITS, type Limits } from '../utils/bounds.util';
import { corroborate, unifyFields } from '../engine/ontology/corroborate.ontology';
import { batched } from '../engine/ontology/plan.ontology';
import { connectionCapabilities } from '../engine/read/capabilities.read';
import type { Row } from '../engine/detectors/shared.detector';
import type { ManifestObject } from '../schemas/manifest.schema';
import { ask, askComplete, readableIds } from './connector.service';
import * as connectorRepo from '../repos/connector.repo';
import * as conceptRepo from '../repos/concept.repo';
import * as profileRepo from '../repos/profile.repo';
import {
  resolvable as canResolve,
  signatureOf,
  type Concept,
  type ConceptProposal,
  type ConceptRevision,
  type ContributingObject,
} from '../models/concept.model';
import {
  derive as deriveConcepts,
  fieldMapFor,
  fieldsWorthProfiling,
  withCorrections,
  type ConnectionSchema,
  type ObjectProfile,
  type Proposal,
} from '../engine/ontology/derive.ontology';
import type { Actor } from './scope.service';
import { labelOf } from '../utils/words.util';

const log = childLogger('ontology');

/**
 * §2 — what the customer's data means.
 *
 * NOTHING IS PREDEFINED. There is no shipped ontology and no seed anywhere in
 * this file: a concept exists because somebody in one organisation confirmed
 * that these objects, in these connections, matched on these keys, mean this
 * thing. Two customers with a concept called "customer" have unrelated
 * concepts, and the schema is what guarantees it rather than a convention.
 *
 * CONFIRMATION IS THE CREATING ACT. §2.4. A proposal is a filled-in form; it
 * becomes a concept when a person presses the button, which is why
 * `confirmed_by` is NOT NULL and why there is no `createConcept` that skips it.
 *
 * EXACT, NEVER FUZZY. §2.6. Resolution runs against agreed keys and nothing
 * here approximates. Where two records will not match, the answer is an
 * unresolved pair for a human to decide — not a similarity score. A wrong merge
 * silently corrupts every answer after it, and no amount of confidence makes
 * that a better trade than failing to merge.
 */

/*
 * `ContributingObject` AND `Concept` LIVE IN `models/concept.model`. They were
 * declared here and, structurally identically, in the derivation engine — two
 * definitions of one thing, waiting to disagree about whether `matchKeys` is
 * ordered. They are re-exported because half the subsystem imports them from
 * this module.
 */
export type { Concept, ContributingObject } from '../models/concept.model';

/**
 * WHAT SOMEBODY MAY BUILD A CONCEPT OUT OF.
 *
 * A CONCEPT CANNOT REACH FURTHER THAN ITS AUTHOR CAN. Confirming one against a
 * connection you cannot read would let you learn that the connection exists,
 * what its objects are called, and — once a detector runs — how many entities
 * are in it. `readableIds` is the same gate the query path uses, so the answer
 * here and the answer there cannot drift apart.
 */
async function assertReachable(
  db: Parameters<typeof readableIds>[0],
  actor: Actor,
  connectionIds: string[],
): Promise<void> {
  const readable = await readableIds(db, actor, connectionIds);
  const missing = connectionIds.filter((id) => !readable.has(id));

  if (missing.length > 0) {
    throw notFound({
      message:
        missing.length === 1
          ? 'That connection does not exist, or you cannot reach it.'
          : `${missing.length} of those connections do not exist, or you cannot reach them.`,
      code: 'missing.connection',
    });
  }
}

/**
 * §2.7 — A CONCEPT NEEDS TWO SYSTEMS TO BE WORTH ANYTHING.
 *
 * A single contributing object has nothing to resolve against: there is no
 * second system to match into, so no identity to establish and no disagreement
 * to detect. Refusing it here is the honest version of the onboarding fact that
 * product value starts at the second connection — the alternative is letting
 * somebody build a concept that cannot do anything and discovering why later.
 */
function assertResolvable(objects: ContributingObject[]): void {
  if (objects.length < 2) {
    throw invalid({
      message:
        'A concept needs an object in at least two connections. With one system there is nothing to match it against.',
      code: 'invalid.concept_needs_two',
    });
  }

  const seen = new Set<string>();
  for (const object of objects) {
    if (seen.has(object.connectionId)) {
      throw invalid({
        message: 'A concept takes one object per connection.',
        code: 'invalid.concept_duplicate_connection',
      });
    }
    seen.add(object.connectionId);

    if (object.matchKeys.length === 0) {
      throw invalid({
        message: `Say which fields resolve ${object.objectName} against the others.`,
        code: 'invalid.concept_no_match_keys',
      });
    }
  }
}

/**
 * A concept for each object of a confirmed connection that has none (128).
 *
 * ── ASKING MUST NEVER WAIT ON THE ONTOLOGY ────────────────────────────────
 *
 * Questions are asked of concepts, so without this a person who had connected
 * one system could ask nothing — sent to confirm concepts that derivation
 * never proposes, because derivation needs two systems. The person who
 * confirmed the connection looked at its records and said they were right;
 * that is the decision a one-system concept needs, so Silo makes it.
 *
 * NAMED AS A PERSON SAYS THE OBJECT ("Contact"), and after the connection
 * when a concept already has that name — two CRMs' contacts are two concepts
 * until somebody confirms they are the same people. A concept matching things
 * across systems is untouched by this: it is still proposed and confirmed, and
 * the system concepts beside it stay, so a question about one system's
 * records still has somewhere to go.
 *
 * INSIDE THE CALLER'S TRANSACTION, and idempotent: an object already in a live
 * concept of any origin is left alone.
 */
export async function ensureSystemConcepts(db: Parameters<typeof readableIds>[0], actor: Actor, connectionIds?: string[]): Promise<number> {
  const active = (await connectorRepo.loadActive(db)).filter((c) => !connectionIds || connectionIds.includes(c.connectionId));
  if (active.length === 0) return 0;
  const live = await conceptRepo.listLive(db);
  const covered = new Set(live.flatMap((concept) => concept.objects.map((o) => `${o.connectionId}|${o.objectName}`)));

  let made = 0;
  for (const connection of active) {
    for (const object of connection.manifest.objects.filter((o) => o.available)) {
      if (covered.has(`${connection.connectionId}|${object.name}`)) continue;
      const plain = labelOf(object.name);
      const name = (await conceptRepo.findLiveByName(db, plain)) ? `${plain} (${connection.name})`.slice(0, 128) : plain;
      if (await conceptRepo.findLiveByName(db, name)) continue;

      const [mapped] = await mappedObjects(db, actor, [
        { connectionId: connection.connectionId, objectName: object.name, identifierField: object.identifier[0]!, matchKeys: [...object.identifier], fieldMap: {} },
      ]);
      const concept = await conceptRepo.insertConcept(db, {
        organisationId: actor.organisationId,
        name,
        origin: 'system',
        proposalId: null,
        confirmedBy: actor.membershipId,
        objects: [mapped!],
      });
      await writeAudit(db, {
        event: 'concept_confirmed',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: { conceptId: concept.id, name, proposalId: null, connections: [connection.connectionId] },
      });
      covered.add(`${connection.connectionId}|${object.name}`);
      made += 1;
    }
  }
  if (made > 0) {
    await rederiveRelationships(db, actor);
    log.info({ made }, 'System concepts made for confirmed connections');
  }
  return made;
}

/**
 * A system concept follows its object's fields.
 *
 * Made when the connection was confirmed, it maps every field the connector
 * read then. When the connector learns the system's whole field list, the
 * concept is re-mapped to match, so the new fields can be asked about at once.
 * ONLY SYSTEM CONCEPTS: one a person confirmed or corrected says what they
 * decided, and is not rewritten underneath them.
 */
export async function refreshSystemConcepts(db: Parameters<typeof readableIds>[0], actor: Actor, connectionId: string): Promise<number> {
  const live = await conceptRepo.listLive(db);
  let refreshed = 0;
  for (const concept of live.filter((one) => one.origin === 'system' && one.objects.some((o) => o.connectionId === connectionId))) {
    const objects = await mappedObjects(db, actor, concept.objects.map((object) => ({ ...object, fieldMap: {} })));
    await conceptRepo.replaceObjects(db, {
      conceptId: concept.id,
      organisationId: actor.organisationId,
      objects,
      addedBy: actor.membershipId,
    });
    refreshed += 1;
  }
  return refreshed;
}

/**
 * Confirming a proposal, or writing one by hand.
 *
 * THE PROPOSAL IS OPTIONAL AND THE RECORD OF IT IS NOT. Whether somebody took
 * a derived proposal as offered, renamed it, or built the thing themselves is
 * the difference between derivation working and derivation being corrected
 * every time — and that is only answerable if it is written down at the moment.
 */
export async function confirm(
  actor: Actor,
  input: {
    name: string;
    objects: ContributingObject[];
    proposalId?: string;
    /**
     * §2.5 — SET AT CONFIRMATION TIME, which is the only moment somebody is
     * looking at what the concept spans. Applying them later means a window in
     * which the concept resolves unrestricted, and the window is exactly when
     * the first queries get run against something new.
     */
    markingIds?: string[];
  },
): Promise<Concept> {
  assertResolvable(input.objects);

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'concept.confirm');

        /* Restricting a thing and clearing a person are different acts, so
           marking one at confirmation needs the permission for marking. */
        if (input.markingIds?.length) assertCan(authority, 'marking.apply');

        await assertReachable(db, actor, input.objects.map((o) => o.connectionId));

        const name = input.name.trim();

        if (await conceptRepo.findLiveByName(db, name)) {
          throw policy({
            message: `There is already a concept called ${name}. Open it and add the object to it rather than making a second one.`,
            code: 'policy.concept_exists',
          });
        }

        let origin: 'confirmed' | 'corrected' | 'manual' = 'manual';
        let proposal: ConceptProposal | null = null;

        if (input.proposalId) {
          proposal = await conceptRepo.readProposal(db, input.proposalId);

          if (!proposal) {
            throw notFound({
              message: 'That proposal does not exist.',
              code: 'missing.concept_proposal',
            });
          }
          if (proposal.reviewedAt) {
            throw policy({
              message: 'That proposal has already been decided.',
              code: 'policy.proposal_decided',
            });
          }

          /* Renaming it is still confirming it — and worth telling apart. */
          origin = proposal.proposedName === name ? 'confirmed' : 'corrected';
        }

        const objects = await mappedObjects(db, actor, input.objects);

        const concept = await conceptRepo.insertConcept(db, {
          organisationId: actor.organisationId,
          name,
          origin,
          proposalId: input.proposalId ?? null,
          confirmedBy: actor.membershipId,
          objects,
        });

        for (const markingId of input.markingIds ?? []) {
          await authzRepo.markResource(db, {
            id: generateId(),
            resourceType: 'concept',
            resourceId: concept.id,
            markingId,
          });
        }

        if (proposal) {
          await conceptRepo.decideProposal(db, {
            id: proposal.id,
            decision: origin === 'corrected' ? 'corrected' : 'confirmed',
            reviewedBy: actor.membershipId,
            conceptId: concept.id,
          });
        }

        await writeAudit(db, {
          event: origin === 'corrected' ? 'concept_corrected' : 'concept_confirmed',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            conceptId: concept.id,
            name,
            proposalId: input.proposalId ?? null,
            connections: input.objects.map((o) => o.connectionId),
          },
        });

        const links = await rederiveRelationships(db, actor);

        log.info(
          { conceptId: concept.id, name, objects: input.objects.length, relationships: links },
          'Concept confirmed',
        );

        return concept;
      }),
  );
}

/**
 * The concepts this person can actually use.
 *
 * A CONCEPT IS ONLY AS REACHABLE AS ITS OBJECTS. One built across finance and
 * engineering is inert to somebody granted neither, and half-useful to somebody
 * granted one — §2.7's rule again, applied per reader rather than per concept.
 * The contributing objects are filtered to what they can reach, and a concept
 * left with fewer than two is reported as unresolvable FOR THEM rather than
 * hidden, because "you cannot use this one" is a different fact from "it does
 * not exist".
 */
export async function list(
  actor: Actor,
): Promise<(Concept & { resolvable: boolean })[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const concepts = await conceptRepo.listLive(db);

        const everyConnection = [
          ...new Set(concepts.flatMap((c) => c.objects.map((o) => o.connectionId))),
        ];
        const readable = await readableIds(db, actor, everyConnection);

        return concepts.map((concept) => {
          const objects = concept.objects.filter((o) => readable.has(o.connectionId));
          /* §2.7, per reader: `resolvable` is derived from what THEY can reach,
             which is why the model computes it from objects rather than storing
             it on the concept. */
          /* A system concept is one system's records: there is nothing to match, and nothing missing. */
          return { ...concept, objects, resolvable: concept.origin === 'system' ? objects.length === 1 : canResolve(objects) };
        });
      }),
  );
}

/* ── §2.2 — Derivation ───────────────────────────────────────────────────── */

/**
 * How many identifiers are read from a source when checking whether two objects
 * hold the same entities.
 *
 * ENOUGH TO BE CONVINCING, FEW ENOUGH TO BE POLITE. Five hundred identifiers
 * settles the question — two systems holding the same invoices agree on
 * hundreds of them, two systems that merely look alike agree on almost none —
 * and it is one page from most sources rather than a table scan of somebody's
 * production ERP.
 */
/**
 * How many objects one derivation may profile.
 *
 * ONE QUERY EACH, against somebody's production system. An estate of four
 * hundred objects is a real thing and four hundred queries in a row is not a
 * reasonable thing to do to it on the strength of somebody pressing a button.
 */
const MAX_PROFILED_OBJECTS = 40;

const SAMPLE_SIZE = 500;

export type DeriveOutcome = {
  /** Waiting for a person. What the records bore out is in `learned` instead, and is a concept already. */
  proposed: Array<Proposal & { id: string }>;
  /** Already a concept, or already waiting in the queue. */
  skipped: number;
  /** Whether any identifiers were actually read. §2.2's fourth input. */
  sampled: boolean;
  /** §2.4 (132) — concepts Silo made itself on this run, with what each rests on. */
  learned: LearnedConcept[];
};

/**
 * A concept across systems that Silo joined itself (132).
 *
 * NAMES AND COUNTS. Which objects it spans, and for each pair of them how many
 * records matched on the key and which other field bore the match out.
 */
export type LearnedConcept = {
  conceptId: string;
  name: string;
  /** The systems it spans, by the names people gave their connections. */
  systems: string[];
  objects: Array<{ connectionId: string; objectName: string }>;
  evidence: Array<{
    a: { connectionId: string; objectName: string; field: string };
    b: { connectionId: string; objectName: string; field: string };
    matched: number;
    compared: number;
    agreed: number;
  }>;
};

/* How much of one side is read to check a proposal against, and how many lists of its keys the other side is asked about. */
const CORROBORATE_ROWS = 200;
const CORROBORATE_BATCHES = 3;
/* How many proposals one run will try to bear out. Each costs two reads of somebody's system per pair. */
const MAX_LEARNED_PER_RUN = 10;

/**
 * Read identifiers for the fields derivation has already decided are candidates.
 *
 * TARGETED, NOT A SURVEY. Sampling every field of every object across every
 * connection would be a crawl of the customer's estate; sampling the one match
 * key of the dozen objects the schemas already pointed at is a handful of
 * single-column page reads. The schema pass is what makes value matching
 * affordable, which is why it runs first rather than alongside.
 *
 * BEST EFFORT, AND ITS FAILURE IS VISIBLE. A source that is down, halted or
 * refuses the read costs the proposal its value evidence and nothing else —
 * `evidence.sampled` says so, and the confidence is capped accordingly. Failing
 * the whole derivation because one of eight systems was unreachable would be
 * worse than a proposal that admits what it did not check.
 *
 * NOTHING READ HERE IS WRITTEN ANYWHERE. The values live in this function's
 * locals, become a count inside `derive`, and are unreferenced when it returns.
 */
async function profileObjects(
  actor: Actor,
  proposals: Proposal[],
  schemas: ConnectionSchema[],
): Promise<Record<string, Record<string, ObjectProfile>>> {
  /*
   * ── WHAT GETS PROFILED IS NOT WHAT PASS ONE PROPOSED ──────────────────────
   *
   * Pass one runs on structure alone, so it can only ever shortlist pairs whose
   * NAMES already agree — which is the gate this whole redesign exists to
   * remove. Profiling only its proposals would reinstate it one layer up:
   * `customers.acct_no` and `ledger_parties.party_ref` would never be fetched,
   * so their three hundred shared identifiers would never be compared, and the
   * concept would be as invisible as it was before.
   *
   * So pass one ORDERS the work and does not limit it. Every object carrying a
   * field that could plausibly identify a record is profiled, with the ones
   * pass one already liked going first — because the budget below is a real
   * ceiling and the order decides what falls off the end of it.
   */
  const wanted = new Map<string, { connectionId: string; object: ManifestObject }>();

  const shortlisted = new Set(
    proposals.flatMap((proposal) =>
      proposal.contributing.map((one) => `${one.connectionId}:${one.objectName}`),
    ),
  );

  /*
   * ── ROUND-ROBIN ACROSS SYSTEMS, WHICH IS THE WHOLE POINT OF THE BUDGET ────
   *
   * The first version listed every object of the first connection, then every
   * object of the second, and took the first forty. On any estate whose first
   * system has forty objects — which is most of them — the second system was
   * never profiled at all. Every pair then had one side unmeasured, fell back
   * to the name gate this redesign exists to remove, and `sampled` still
   * reported true.
   *
   * A comparison needs BOTH sides. Forty objects from one system are worth
   * nothing; twenty from each are worth twenty comparisons.
   */
  const roundRobin = (
    candidates: Array<{ connectionId: string; object: ManifestObject }>,
  ): Array<{ connectionId: string; object: ManifestObject }> => {
    const queues = new Map<string, Array<{ connectionId: string; object: ManifestObject }>>();
    for (const one of candidates) {
      queues.set(one.connectionId, [...(queues.get(one.connectionId) ?? []), one]);
    }

    const out: Array<{ connectionId: string; object: ManifestObject }> = [];
    for (let round = 0; out.length < candidates.length; round += 1) {
      let took = false;
      for (const queue of queues.values()) {
        const next = queue[round];
        if (!next) continue;
        out.push(next);
        took = true;
      }
      /* Every queue exhausted; nothing more to interleave. */
      if (!took) break;
    }

    return out;
  };

  const everyObject = schemas.flatMap((schema) =>
    schema.objects.map((object) => ({ connectionId: schema.connectionId, object })),
  );

  const ordered = [
    ...roundRobin(
      everyObject.filter((one) => shortlisted.has(`${one.connectionId}:${one.object.name}`)),
    ),
    ...roundRobin(
      everyObject.filter((one) => !shortlisted.has(`${one.connectionId}:${one.object.name}`)),
    ),
  ];

  for (const one of ordered) {
    if (wanted.size >= MAX_PROFILED_OBJECTS) break;
    if (fieldsWorthProfiling(one.object).length === 0) continue;
    wanted.set(`${one.connectionId}:${one.object.name}`, one);
  }

  /*
   * NO SILENT CAP. An estate larger than the budget gets a partial derivation,
   * and a proposal list that is quietly short reads as "nothing else resembles
   * anything" — which is the one conclusion a truncated pass cannot support.
   */
  if (ordered.length > wanted.size) {
    log.info(
      { profiled: wanted.size, available: ordered.length },
      'Profiled the first objects only; derivation is partial',
    );
  }

  const objects = wanted;

  const profiles: Record<string, Record<string, ObjectProfile>> = {};

  for (const { connectionId, object } of objects.values()) {
    const fields = fieldsWorthProfiling(object);
    if (fields.length === 0) continue;

    try {
      const outcome = await ask({
        actor,
        connectionIds: [connectionId],
        query: {
          object: object.name,
          filters: [],
          /*
           * ── ORDERED, AND THIS MATTERS MORE THAN THE SIZE ──────────────────
           *
           * An unordered page is whatever the source felt like returning,
           * which for most systems is insertion order. Two systems populated at
           * different times then hand back their oldest five hundred rows each,
           * and those two sets can fail to intersect even for a concept that is
           * genuinely shared — value-first derivation would reject a real match
           * and the failure would look like the customer's data rather than
           * like our sampling.
           *
           * Sorting both sides on the key makes them sample the same region of
           * the key space. Where a source cannot sort, the page is still taken
           * and `saturated` records that the population is larger, which is
           * what stops a partial view being read as a census.
           */
          sort: [{ field: fields[0]!, direction: 'asc' }],
          /* Only the columns that could carry identity. A derivation run must
             not become a way to read a table. */
          fields,
          limit: SAMPLE_SIZE,
        },
      });

      const rows = outcome.answered.flatMap((source) => source.result?.rows ?? []);
      if (rows.length === 0) continue;

      const profile: ObjectProfile = {};

      for (const field of fields) {
        const values: string[] = [];
        let missing = 0;

        for (const row of rows) {
          const value = row[field];
          if (value === null || value === undefined || value === '') missing += 1;
          else values.push(String(value));
        }

        profile[field] = {
          rows: rows.length,
          /* The page came back full, so the population is larger than this and
             a count taken from it is a lower bound rather than a number. */
          saturated: rows.length >= SAMPLE_SIZE,
          absent: missing,
          values,
        };
      }

      const perConnection = profiles[connectionId] ?? {};
      perConnection[object.name] = profile;
      profiles[connectionId] = perConnection;
    } catch (error) {
      log.info(
        { connectionId, object: object.name, err: error },
        'Could not profile an object; proposing on structure alone',
      );
    }
  }

  return profiles;
}

/**
 * §2.2 — propose concepts from the systems this organisation has connected.
 *
 * TWO PASSES, AND THE ORDER IS THE POINT. The schemas alone say which objects
 * are worth comparing; the values say whether they actually hold the same
 * entities. Doing it the other way round means reading data to answer a
 * question the schema could have dismissed for free.
 *
 * IT PROPOSES AND STOPS. §2.4 — nothing here creates a concept, and `confirm`
 * is the only thing that can. A derivation that quietly created its own
 * confident proposals would be the product deciding what a customer's data
 * means, which §2.1 exists to prevent.
 *
 * RE-RUNNING IS SAFE AND NEARLY SILENT. Anything already confirmed, and
 * anything already waiting in the queue, is counted as skipped rather than
 * offered again — otherwise the second run doubles the review queue and the
 * third triples it.
 */
export async function derive(
  actor: Actor,
  options: { sampleValues?: boolean } = {},
): Promise<DeriveOutcome> {
  return runDerivation(actor, { ...options, asked: true });
}

/**
 * §2.4 (132) — look for the same records across this organisation's systems,
 * and join the ones the records bear out.
 *
 * ── THE SAME DERIVATION, RUN BECAUSE A SYSTEM ARRIVED ─────────────────────
 *
 * `derive` is somebody pressing a button, and needs the permission to confirm
 * concepts. This is Silo doing it when a connection is confirmed — the moment
 * there is something new to find — so nobody has to know the button exists.
 * It is not a wider door: it reads only what this person can read, a proposal
 * it cannot bear out waits in the queue for somebody who may confirm it, and
 * what it does make is a `learned` concept that says so and can be retired.
 */
export async function joinSystems(actor: Actor): Promise<LearnedConcept[]> {
  return (await runDerivation(actor, { sampleValues: true, asked: false })).learned;
}

/**
 * Join systems if a connection has arrived that nobody has looked across (133).
 *
 * ── CALLED WHEREVER THERE IS ALREADY SOMETHING TO WAIT FOR ────────────────
 *
 * Looking across systems takes as long as the slowest of them, so it is not
 * part of confirming a connection. The page that confirmed one asks for this in
 * the background, and an answer being written up does it beside the model call.
 * Whichever arrives first claims the connections and looks; the rest find
 * nothing waiting and return at once, which is what makes this safe to call
 * from anywhere.
 *
 * A LOOK THAT FAILED GIVES ITS CLAIM BACK, so the next caller tries again
 * rather than the connection being marked as looked at when it was not.
 */
export async function joinIfPending(actor: Actor): Promise<LearnedConcept[]> {
  const tenant = { organisationId: actor.organisationId, membershipId: actor.membershipId };

  const claimed = await runWithTenant(tenant, () =>
    withTransaction(async (db) => {
      const active = await connectorRepo.loadActive(db);
      const readable = await readableIds(db, actor, active.map((connection) => connection.connectionId));
      /* One system has nothing to be joined with, and stays waiting for the second. */
      if (readable.size < 2) return [];
      return connectorRepo.claimUnjoined(db, [...readable]);
    }),
  );

  if (claimed.length === 0) return [];

  try {
    return await joinSystems(actor);
  } catch (error) {
    await runWithTenant(tenant, () => withTransaction((db) => connectorRepo.releaseJoin(db, claimed)));
    throw error;
  }
}

async function runDerivation(
  actor: Actor,
  options: { sampleValues?: boolean; asked: boolean },
): Promise<DeriveOutcome> {
  const wantSamples = options.sampleValues ?? true;

  const { schemas, known } = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        /*
         * THE SAME PERMISSION AS CONFIRMING, because this writes the queue that
         * confirming reads. It is also the only gate on enumerating what every
         * reachable system's schema looks like in one response.
         */
        if (options.asked) assertCan(authority, 'concept.confirm');

        const active = await connectorRepo.loadActive(db);
        const readable = await readableIds(
          db,
          actor,
          active.map((connection) => connection.connectionId),
        );

        const schemas: ConnectionSchema[] = active
          .filter((connection) => readable.has(connection.connectionId))
          .map((connection) => ({
            connectionId: connection.connectionId,
            /* An unavailable object cannot be queried, so a concept over it
               could not resolve anything either. */
            objects: connection.manifest.objects.filter((object) => object.available),
          }));

        const contributions = await conceptRepo.liveContributions(db);

        const byConcept = new Map<string, ContributingObject[]>();
        for (const row of contributions) {
          byConcept.set(row.conceptId, [...(byConcept.get(row.conceptId) ?? []), row]);
        }

        const waiting = await conceptRepo.openProposals(db);

        /*
         * §2.2 — WHAT THESE FIELDS LOOKED LIKE LAST TIME, for stability. Absent
         * on a first run, which is honest rather than provisional: drift needs
         * two observations and derivation renormalises the signal away.
         */
        const held = await profileRepo.latest(
          db,
          schemas.map((schema) => schema.connectionId),
        );

        for (const stored of held) {
          const schema = schemas.find((one) => one.connectionId === stored.connectionId);
          if (!schema) continue;
          const priors = schema.priors ?? {};
          const object = priors[stored.objectName] ?? {};
          object[stored.fieldName] = {
            distinctRatio: stored.distinctRatio,
            absentRatio: stored.absentRatio,
            rows: stored.rows,
          };
          priors[stored.objectName] = object;
          schema.priors = priors;
        }

        return {
          schemas,
          known: {
            concepts: [...byConcept.values()],
            open: new Set(waiting.map((proposal) => signatureOf(proposal.contributing))),
            /* Still in the queue from an earlier run, and this person can reach all of it. */
            waiting: waiting.filter((proposal) =>
              proposal.contributing.every((object) => readable.has(object.connectionId)),
            ),
            declined: new Set((await conceptRepo.declined(db)).map((objects) => signatureOf(objects))),
          },
        };
      }),
  );

  /* Pass one: structure only, and free. */
  const candidates = deriveConcepts(schemas);

  /*
   * Pass two runs OUTSIDE the transaction, because it makes network calls to
   * other people's systems — holding a database connection open across eight of
   * those is how a pool of ten runs out under one derivation.
   */
  let proposals = candidates;
  let sampled = false;

  /*
   * PROFILED WHENEVER THERE ARE TWO SYSTEMS TO COMPARE, not only when pass one
   * already found something. Gating on `candidates.length` was the same
   * name-gate one layer up: pass one runs on structure, so an estate whose
   * systems agree about no spelling produced no candidates, nothing was
   * fetched, and the pair that shared three hundred identifiers was never
   * looked at.
   */
  if (wantSamples && schemas.length >= 2) {
    const profiles = await profileObjects(actor, candidates, schemas);
    sampled = Object.keys(profiles).length > 0;

    if (sampled) {
      /*
       * PASS TWO IS THE REAL PASS. Pass one ran on structure alone and exists
       * only to decide which objects were worth the cost of a query; what it
       * proposed is thrown away here rather than merged, because a name
       * agreeing is not evidence that survives a value disagreeing.
       */
      proposals = deriveConcepts(
        schemas.map((schema) => ({ ...schema, profiles: profiles[schema.connectionId] })),
      );

      /*
       * RECORDED AFTER THE COMPARISON, SO THE NEXT RUN HAS SOMETHING TO DRIFT
       * AGAINST. Three counts per field; see 052 for why that is the whole of
       * what may be kept.
       */
      const observed = Object.entries(profiles).flatMap(([connectionId, objects]) =>
        Object.entries(objects).flatMap(([objectName, fields]) =>
          Object.entries(fields).map(([fieldName, profile]) => {
            const present = Math.max(0, profile.rows - profile.absent);
            return {
              connectionId,
              objectName,
              fieldName,
              rows: profile.rows,
              distinctRatio:
                present === 0
                  ? 0
                  : new Set(profile.values.map((value) => value.trim().toLowerCase())).size /
                    present,
              absentRatio: profile.rows === 0 ? 0 : profile.absent / profile.rows,
            };
          }),
        ),
      );

      await runWithTenant(
        { organisationId: actor.organisationId, membershipId: actor.membershipId },
        () =>
          withTransaction((db) =>
            profileRepo.record(db, { organisationId: actor.organisationId, profiles: observed }),
          ),
      );
    }
  }

  const fresh = proposals.filter((proposal) => {
    if (known.open.has(signatureOf(proposal.contributing))) return false;

    /*
     * A SUBSET OF AN EXISTING CONCEPT ADDS NOTHING. Two of the three objects
     * somebody already confirmed is the concept they have, offered back to them
     * with one missing.
     */
    return !known.concepts.some((concept) => {
      const members = new Set(signatureOf(concept).split('|'));
      return signatureOf(proposal.contributing)
        .split('|')
        .every((member) => members.has(member));
    });
  });

  const written = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const rows: Array<Proposal & { id: string }> = [];

        for (const proposal of fresh) {
          const id = await conceptRepo.insertProposal(db, {
            organisationId: actor.organisationId,
            proposedName: proposal.proposedName,
            contributing: proposal.contributing,
            evidence: proposal.evidence,
            confidence: proposal.confidence,
          });

          await writeAudit(db, {
            event: 'concept_proposed',
            organisationId: actor.organisationId,
            membershipId: actor.membershipId,
            userId: null,
            detail: {
              proposalId: id,
              proposedName: proposal.proposedName,
              connections: proposal.contributing.map((object) => object.connectionId),
              confidence: proposal.confidence,
              sampled: proposal.evidence.sampled,
            },
          });

          rows.push({ ...proposal, id });
        }

        return rows;
      }),
  );

  /*
   * ── AND THE ONES THE RECORDS BEAR OUT DO NOT WAIT (132) ───────────────────
   *
   * Everything above proposes. A proposal says the same identifiers appear in
   * both systems; whether the records that match are the same THINGS is what a
   * person confirming it decides by looking. Where the records settle that
   * themselves — see `corroborate` — Silo makes the concept, and the queue is
   * left holding only what somebody actually needs to look at.
   *
   * ONLY AFTER VALUES WERE READ. A proposal made on structure alone has nothing
   * to be borne out by.
   *
   * WHAT IS WAITING FROM EARLIER RUNS IS TRIED AGAIN, because the records it
   * could not be borne out by then may have been filled in since.
   */
  let learned: Array<LearnedConcept & { proposalId: string }> = [];

  if (sampled) {
    const candidates = [
      ...written.map((one) => ({ id: one.id, proposedName: one.proposedName, contributing: one.contributing, evidence: one.evidence, confidence: one.confidence })),
      ...known.waiting.map((one) => ({
        id: one.id,
        proposedName: one.proposedName,
        contributing: one.contributing,
        evidence: (one.evidence as Proposal['evidence']) ?? { pairs: [], sampled: false },
        confidence: one.confidence ?? 0,
      })),
    ]
      /* What a person turned down is theirs to bring back, never Silo's. */
      .filter((one) => !known.declined.has(signatureOf(one.contributing)))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_LEARNED_PER_RUN);

    try {
      learned = await learnFrom(actor, candidates);
    } catch (error) {
      /* A proposal that could not be checked is still a proposal. */
      log.warn({ err: error }, 'Proposals could not be checked against their records; they wait for a person');
    }
  }

  const made = new Set(learned.map((one) => one.proposalId));

  /* Somebody pressing Derive has looked across everything they can read, so nothing is left waiting for the next answer to do. */
  if (sampled) {
    await runWithTenant({ organisationId: actor.organisationId, membershipId: actor.membershipId }, () =>
      withTransaction((db) => connectorRepo.claimUnjoined(db, schemas.map((schema) => schema.connectionId))),
    );
  }

  log.info(
    {
      connections: schemas.length,
      proposed: written.length - written.filter((one) => made.has(one.id)).length,
      learned: learned.length,
      skipped: proposals.length - fresh.length,
      sampled,
    },
    'Ontology derivation run',
  );

  return {
    proposed: written.filter((one) => !made.has(one.id)),
    skipped: proposals.length - fresh.length,
    sampled,
    learned: learned.map(({ proposalId: _proposal, ...one }) => one),
  };
}

/**
 * Make a concept of each proposal its records bear out.
 *
 * ── TWO READS PER PAIR, AND WHAT THEY ARE FOR ─────────────────────────────
 *
 * `sharedRecords` fetches the records the two objects have in common, and
 * `corroborate` says whether the ones that match agree about anything else.
 *
 * EVERY OBJECT HAS TO BE REACHED, NOT EVERY PAIR BORNE OUT. A concept across
 * three systems is keyed on one key, so a CRM borne out against the ledger and
 * against the support desk has joined all three — the ledger and the desk need
 * not also share a second field between them, and often do not. What is not
 * enough is an object nothing bears out: that leaves a proposal a person
 * should look at rather than two-thirds of a concept.
 */
/**
 * The records two objects of a concept share, as each system holds them.
 *
 * A page of one side, ordered by its key; then the other side asked for the
 * records holding those keys — the question a counterpart is always asked by.
 * Where the other side cannot take a list, a page of it ordered the same way,
 * which samples the same end of the key space.
 *
 * BOUNDED, AND NOTHING IS KEPT. Two hundred records of one side and their
 * counterparts; the rows are arguments to a function that returns counts.
 *
 * READ AS THE PERSON ASKING, so a field hidden from them is not among what
 * comes back, and a system they cannot reach refuses.
 */
export async function sharedRecords(
  actor: Actor,
  a: Pick<ContributingObject, 'connectionId' | 'objectName' | 'matchKeys'>,
  b: Pick<ContributingObject, 'connectionId' | 'objectName' | 'matchKeys'>,
  /** What the second system declares it can filter by. */
  theirs: { filters: readonly string[]; maxFilterValues: number } | undefined,
): Promise<{ first: Row[]; second: Row[] }> {
  const read = async (connectionId: string, query: Parameters<typeof ask>[0]['query']): Promise<Row[]> => {
    const outcome = await ask({ actor, connectionIds: [connectionId], query });
    return outcome.answered.flatMap((source) => source.result?.rows ?? []);
  };

  const first = await read(a.connectionId, {
    object: a.objectName,
    filters: [],
    sort: [{ field: a.matchKeys[0]!, direction: 'asc' }],
    fields: [],
    limit: CORROBORATE_ROWS,
  });

  const keys = [...new Set(first.map((row) => row[a.matchKeys[0]!]).filter((value) => value !== null && value !== undefined && value !== ''))];
  if (keys.length === 0) return { first, second: [] };

  if (!theirs?.filters.includes('in')) {
    return {
      first,
      second: await read(b.connectionId, {
        object: b.objectName,
        filters: [],
        sort: [{ field: b.matchKeys[0]!, direction: 'asc' }],
        fields: [],
        limit: CORROBORATE_ROWS,
      }),
    };
  }

  const second: Row[] = [];
  for (const batch of batched(keys, theirs.maxFilterValues || null).slice(0, CORROBORATE_BATCHES)) {
    second.push(
      ...(await read(b.connectionId, {
        object: b.objectName,
        filters: [{ field: b.matchKeys[0]!, op: 'in', value: batch }],
        sort: [],
        fields: [],
        limit: CORROBORATE_ROWS * 2,
      })),
    );
  }

  return { first, second };
}

async function learnFrom(
  actor: Actor,
  candidates: ReadonlyArray<{
    id: string;
    proposedName: string;
    contributing: ContributingObject[];
    evidence: Proposal['evidence'];
  }>,
): Promise<Array<LearnedConcept & { proposalId: string }>> {
  if (candidates.length === 0) return [];

  const tenant = { organisationId: actor.organisationId, membershipId: actor.membershipId };
  const connectionIds = [...new Set(candidates.flatMap((one) => one.contributing.map((object) => object.connectionId)))];

  const connections = await runWithTenant(tenant, () => withTransaction((db) => connectorRepo.load(db, connectionIds)));
  const capabilityOf = new Map(connections.map((one) => [one.connectionId, connectionCapabilities(one.manifest)]));
  const nameOf = new Map(connections.map((one) => [one.connectionId, one.name]));

  const learned: Array<LearnedConcept & { proposalId: string }> = [];

  for (const candidate of candidates) {
    if (!candidate.evidence.sampled || candidate.evidence.pairs.length === 0) continue;

    const evidence: LearnedConcept['evidence'] = [];
    /* Columns found to hold the same thing, for the field map: the key's own slots, and what the matched records agree on. */
    const links: Array<Parameters<typeof unifyFields>[0]['links'][number]> = [];

    /* Which objects the pairs borne out so far have joined: each starts alone. */
    const idOf = (object: { connectionId: string; objectName: string }) => `${object.connectionId}\u0000${object.objectName}`;
    const group = new Map(candidate.contributing.map((object) => [idOf(object), idOf(object)]));
    const rootOf = (id: string): string => (group.get(id) === id || group.get(id) === undefined ? id : rootOf(group.get(id)!));

    for (const pair of candidate.evidence.pairs) {
      const a = candidate.contributing.find((one) => one.connectionId === pair.a.connectionId && one.objectName === pair.a.objectName);
      const b = candidate.contributing.find((one) => one.connectionId === pair.b.connectionId && one.objectName === pair.b.objectName);

      if (!a || !b || pair.keys.length === 0 || a.matchKeys.length === 0 || a.matchKeys.length !== b.matchKeys.length) continue;
      /* Already joined through another pair; a third read of somebody's system would add nothing. */
      if (rootOf(idOf(a)) === rootOf(idOf(b))) continue;

      let found: ReturnType<typeof corroborate>;
      try {
        const { first, second } = await sharedRecords(actor, a, b, capabilityOf.get(b.connectionId));
        found = corroborate({ a: { rows: first, keys: a.matchKeys }, b: { rows: second, keys: b.matchKeys } });
      } catch (error) {
        log.info({ proposalId: candidate.id, err: error }, 'Could not read the records a proposal rests on');
        continue;
      }

      if (!found.on) continue;

      group.set(rootOf(idOf(a)), rootOf(idOf(b)));

      const side = (object: ContributingObject, column: string) => ({ connectionId: object.connectionId, objectName: object.objectName, column });
      a.matchKeys.forEach((column, slot) => links.push({ a: side(a, column), b: side(b, b.matchKeys[slot]!) }));
      for (const one of found.same) links.push({ a: side(a, one.a), b: side(b, one.b) });

      evidence.push({
        a: { connectionId: a.connectionId, objectName: a.objectName, field: found.on.a },
        b: { connectionId: b.connectionId, objectName: b.objectName, field: found.on.b },
        matched: found.matched,
        compared: found.on.compared,
        agreed: found.on.agreed,
      });
    }

    /* Every object in one group, or it waits for a person. */
    if (new Set(candidate.contributing.map((object) => rootOf(idOf(object)))).size !== 1) continue;

    const made = await runWithTenant(tenant, () =>
      withTransaction(async (db) => {
        /* Decided since this run began, by somebody or by another run. */
        const proposal = await conceptRepo.readProposal(db, candidate.id);
        if (!proposal || proposal.reviewedAt) return null;

        const reachable = await readableIds(db, actor, candidate.contributing.map((object) => object.connectionId));
        if (candidate.contributing.some((object) => !reachable.has(object.connectionId))) return null;

        /*
         * NAMED AS PROPOSED, AND AFTER ITS SYSTEMS WHERE THAT NAME IS TAKEN — a
         * system concept is very often already called what its object is. Two
         * concepts are never given one name, and one that cannot be named is
         * left for a person.
         */
        /* As a person says it, like the concepts Silo makes for one system ("Company" beside "Companies"). */
        const plain = labelOf(candidate.proposedName.trim());
        const systems = candidate.contributing.map((object) => nameOf.get(object.connectionId) ?? '').filter(Boolean);
        const name = (await conceptRepo.findLiveByName(db, plain)) ? `${plain} (${systems.join(' + ')})`.slice(0, 128) : plain;
        if (await conceptRepo.findLiveByName(db, name)) return null;

        /*
         * MAPPED BY EACH SYSTEM'S OWN NAMES, THEN GIVEN ONE NAME WHERE THE
         * RECORDS SAID TWO COLUMNS ARE ONE: the key it is matched on, and every
         * field the matched records agreed about. So the concept can be asked
         * about a customer's number, or their city, in both systems at once,
         * from its first question.
         */
        const objects = unifyFields({ objects: await mappedObjects(db, actor, candidate.contributing), links });

        const concept = await conceptRepo.insertConcept(db, {
          organisationId: actor.organisationId,
          name,
          origin: 'learned',
          proposalId: candidate.id,
          confirmedBy: actor.membershipId,
          objects,
        });

        await conceptRepo.decideProposal(db, {
          id: candidate.id,
          decision: 'learned',
          reviewedBy: actor.membershipId,
          conceptId: concept.id,
        });

        await writeAudit(db, {
          event: 'concept_learned',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            conceptId: concept.id,
            name,
            proposalId: candidate.id,
            connections: candidate.contributing.map((object) => object.connectionId),
            borneOutBy: evidence.map((one) => ({
              /* Which fields bore it out and how many records: names and counts. */
              fields: `${one.a.objectName}.${one.a.field} = ${one.b.objectName}.${one.b.field}`,
              matched: one.matched,
              compared: one.compared,
              agreed: one.agreed,
            })),
          },
        });

        await rederiveRelationships(db, actor);
        return concept;
      }),
    );

    if (!made) continue;

    log.info({ conceptId: made.id, name: made.name, objects: candidate.contributing.length }, 'Concept learned from matching records');

    learned.push({
      proposalId: candidate.id,
      conceptId: made.id,
      name: made.name,
      systems: candidate.contributing.map((object) => nameOf.get(object.connectionId) ?? '').filter(Boolean),
      objects: candidate.contributing.map((object) => ({ connectionId: object.connectionId, objectName: object.objectName })),
      evidence,
    });
  }

  return learned;
}

/**
 * The proposals waiting for somebody.
 *
 * REACHABILITY IS REPORTED, NOT FILTERED — the same call `list` makes about
 * concepts, for the same reason. A proposal spanning a connection you cannot
 * read is one you must not confirm, and hiding it would leave the queue looking
 * empty while somebody else waits for it to be reviewed.
 */
export async function proposals(
  actor: Actor,
): Promise<Array<Proposal & { id: string; proposedAt: string; confirmable: boolean }>> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const waiting = await conceptRepo.openProposals(db);

        const readable = await readableIds(
          db,
          actor,
          [...new Set(waiting.flatMap((p) => p.contributing.map((o) => o.connectionId)))],
        );

        return waiting.map((proposal) => ({
          id: proposal.id,
          proposedName: proposal.proposedName,
          contributing: proposal.contributing,
          evidence: (proposal.evidence as Proposal['evidence']) ?? { pairs: [], sampled: false },
          confidence: proposal.confidence ?? 0,
          proposedAt: proposal.proposedAt.toISOString(),
          /* §2.7 — reported, not filtered. A proposal spanning a connection you
             cannot read is one you must not confirm, and hiding it leaves the
             queue looking empty while somebody waits for it to be reviewed. */
          confirmable: proposal.contributing.every((object) =>
            readable.has(object.connectionId),
          ),
        }));
      }),
  );
}

/**
 * Turning one down.
 *
 * A REJECTION IS A DECISION AND IS KEPT AS ONE. It is not a delete: the rate at
 * which derivation is rejected is the only measure of whether derivation is any
 * good, and a queue that forgets what was thrown out cannot produce it.
 */
export async function reject(actor: Actor, proposalId: string): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'concept.confirm');

        const proposal = await conceptRepo.readProposal(db, proposalId);

        if (!proposal) {
          throw notFound({
            message: 'That proposal does not exist.',
            code: 'missing.concept_proposal',
          });
        }
        if (proposal.reviewedAt) {
          throw policy({
            message: 'That proposal has already been decided.',
            code: 'policy.proposal_decided',
          });
        }

        await conceptRepo.decideProposal(db, {
          id: proposalId,
          decision: 'rejected',
          reviewedBy: actor.membershipId,
          conceptId: null,
        });

        log.info({ proposalId }, 'Concept proposal rejected');
      }),
  );
}


/**
 * §4.1 — re-derive which concepts reference which, from the foreign keys their
 * objects declare.
 *
 * RUN AFTER EVERY CHANGE TO THE CONCEPT SET, because a relationship needs BOTH
 * ends to be confirmed. Confirming `order` completes a link that `invoice`
 * declared weeks ago and nothing could record at the time, and correcting a
 * concept to point at a different object must be able to REMOVE one.
 *
 * DERIVED ONLY, AND IN THE SAME TRANSACTION. Relationships somebody confirmed
 * by hand survive — `origin` is what separates them — and a concept that
 * committed without its relationships would leave association unable to walk a
 * link the customer's schema already states, with nothing to say why.
 */
async function rederiveRelationships(
  db: Parameters<typeof readableIds>[0],
  actor: Actor,
): Promise<number> {
  const contributions = await conceptRepo.liveContributions(db);
  if (contributions.length === 0) {
    return conceptRepo.replaceDerivedRelationships(db, actor.organisationId, []);
  }

  const byConcept = new Map<string, ContributingObject[]>();
  for (const row of contributions) {
    byConcept.set(row.conceptId, [...(byConcept.get(row.conceptId) ?? []), row]);
  }

  const loaded = await connectorRepo.load(db, [
    ...new Set(contributions.map((row) => row.connectionId)),
  ]);

  const objectsByConnection = new Map(
    loaded.map((connection) => [connection.connectionId, connection.manifest.objects]),
  );

  const found = relate({
    concepts: [...byConcept.entries()].map(([conceptId, objects]) => ({ conceptId, objects })),
    objectsByConnection,
  });

  return conceptRepo.replaceDerivedRelationships(db, actor.organisationId, found);
}

/**
 * What references what, for §4's association layer to walk.
 *
 * READ, NOT RE-DERIVED, ON THE HOT PATH. Association asks this on every
 * computation; re-deriving would load every manifest each time to reconstruct
 * rows that only change when somebody confirms or corrects a concept.
 */
export async function relationships(actor: Actor) {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () => withTransaction((db) => clearedRelationships(db, actor)),
  );
}

/**
 * The relationships this reader is allowed to see, optionally about one concept.
 *
 * ONE FILTER, TWO SURFACES. The collection endpoint and the concept view ask
 * the same question about different scopes, and two copies of a disclosure rule
 * is one copy waiting to be updated alone.
 */
async function clearedRelationships(
  db: Parameters<typeof readableIds>[0],
  actor: Actor,
  options: { conceptId?: string } = {},
) {
  const all = await conceptRepo.relationships(db);

  const found = options.conceptId
    ? all.filter(
        (edge) =>
          edge.fromConceptId === options.conceptId || edge.toConceptId === options.conceptId,
      )
    : all;

        /*
         * ── §2.5 — BOTH ENDS, OR IT IS NOT SHOWN ──────────────────────────
         *
         * A relationship names two concepts, and a marking on either of them is
         * the statement that its existence is restricted. Returning the edge to
         * somebody cleared for only one end tells them a compartment exists,
         * what it is called, and that something they CAN see connects to it —
         * which is most of what the compartment was hiding.
         *
         * DROPPED, NOT REFUSED, the same way `detector.list` handles it. One
         * marked concept must not turn the whole graph into an error: that
         * would announce the compartment just as loudly, and from a screen an
         * admin looks at every day.
         *
         * Cleared per concept and cached, because a graph of a hundred edges
         * over twenty concepts would otherwise ask the same question five times
         * each.
         */
  const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
  const cleared = new Map<string, boolean>();

  for (const conceptId of new Set(found.flatMap((r) => [r.fromConceptId, r.toConceptId]))) {
    const required = await authzRepo.markingsOnResource(db, 'concept', conceptId);
    cleared.set(conceptId, checkMarkings({ required }, { held: authority.clearances }).permitted);
  }

  /*
   * AND THE CONNECTION, which every other concept read path checks and this one
   * did not. A relationship is a foreign key inside ONE system, so an edge
   * names a connection — and somebody with no grant on that connection being
   * shown its schema's shape is the same disclosure `assertReachable` exists to
   * prevent everywhere else.
   */
  const readable = await readableIds(
    db,
    actor,
    [...new Set(found.map((edge) => edge.connectionId))],
  );

  return found.filter(
    (edge) =>
      cleared.get(edge.fromConceptId) &&
      cleared.get(edge.toConceptId) &&
      readable.has(edge.connectionId),
  );
}


/**
 * A concept's objects with their field maps settled.
 *
 * ── One definition, because both paths need it and one had none ────────────
 *
 * `confirm` derived the map and applied the organisation's corrections.
 * `correct` passed the caller's objects straight through — and the request
 * body does not carry a field map, so correcting a concept BLANKED it and
 * `/concepts/:id/ask` began refusing every field of a concept that had been
 * answering questions a moment earlier.
 *
 * Two copies of this would drift; one is the point.
 *
 * DERIVED WHERE THE CALLER BRINGS NOTHING, by `canonicalField` over the
 * manifest — the same rule the comparison uses, so a hand-made concept and a
 * derived one map the same system identically.
 *
 * THEN CORRECTED, because "this system's `amt_gross` is our `total`" belongs to
 * the connection and holds for every concept over it, including this one.
 */
async function mappedObjects(
  db: Parameters<typeof readableIds>[0],
  actor: Actor,
  objects: ContributingObject[],
): Promise<ContributingObject[]> {
  const connectionIds = [...new Set(objects.map((object) => object.connectionId))];

  const corrections = await fieldAliasRepo.forConnections(db, connectionIds);
  const manifests = await connectorRepo.load(db, connectionIds);

  return objects.map((object) => {
    const stated = object.fieldMap && Object.keys(object.fieldMap).length > 0;

    const described = manifests
      .find((one) => one.connectionId === object.connectionId)
      ?.manifest.objects.find((one) => one.name === object.objectName);

    const fieldMap = stated
      ? object.fieldMap
      : described
        ? fieldMapFor(described)
        : {};

    return {
      ...object,
      fieldMap: withCorrections({
        fieldMap,
        corrections: corrections.filter(
          (alias) =>
            alias.connectionId === object.connectionId && alias.objectName === object.objectName,
        ),
      }),
    };
  });
}

/* ── §2.5 Markings ───────────────────────────────────────────────────────── */

/**
 * What a concept is marked with.
 *
 * `resource_markings` WITH `resource_type = 'concept'`, WHICH IS WHERE
 * `assertCleared` LOOKS. 004 also created a `concept_markings` table that
 * nothing ever read; 039 dropped it, because a marking written into the half
 * the authorisation layer does not consult is a compartment that silently is
 * not one.
 */
export async function markings(actor: Actor, conceptId: string): Promise<string[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const concept = await conceptRepo.read(db, conceptId);
        if (!concept) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }
        return authzRepo.markingsOnResource(db, 'concept', conceptId);
      }),
  );
}

/**
 * §2.5 — restrict a concept, or stop restricting it.
 *
 * WHY A CONCEPT CARRIES MARKINGS AT ALL, since this is the part that reads as
 * over-engineering until it does not: a concept RESOLVES an entity across
 * systems. If one contributing system is restricted and another is not, then
 * resolving the concept reveals that a restricted record exists — the count
 * changes, the join succeeds, the entity appears in a list. Marking the
 * connection is not enough, and marking the field is not enough. The concept is
 * the side channel.
 *
 * `marking.apply`, NOT `concept.confirm`. Restricting a thing and clearing a
 * person are different acts with different blast radii, and somebody entitled
 * to say what two systems mean by "supplier" is not thereby entitled to decide
 * what is secret.
 *
 * SET, NOT ADD. The caller states the full set, because removal is the
 * operation that matters and an add-only interface makes it invisible.
 */
export async function setMarkings(
  actor: Actor,
  input: { conceptId: string; markingIds: string[]; reason?: string },
): Promise<string[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'marking.apply');

        const concept = await conceptRepo.read(db, input.conceptId);
        if (!concept || concept.retiredAt) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }

        /*
         * A MARKING THE ORGANISATION DOES NOT HAVE IS REFUSED, NOT CREATED.
         * `resource_markings.marking_id` is a foreign key, so an unknown id
         * would fail as a constraint violation — which reads as a server fault
         * rather than as "there is no compartment by that name".
         */
        const known = await authzRepo.markingIdsInOrganisation(db);
        const unknown = input.markingIds.filter((id) => !known.has(id));
        if (unknown.length > 0) {
          throw invalid({
            message: `${unknown.length === 1 ? 'That marking does' : 'Those markings do'} not exist.`,
            code: 'invalid.unknown_marking',
          });
        }

        const before = await authzRepo.markingsOnResource(db, 'concept', input.conceptId);
        const wanted = new Set(input.markingIds);

        for (const markingId of before) {
          if (!wanted.has(markingId)) {
            await authzRepo.unmarkResource(db, {
              resourceType: 'concept',
              resourceId: input.conceptId,
              markingId,
            });
          }
        }

        for (const markingId of wanted) {
          await authzRepo.markResource(db, {
            id: generateId(),
            resourceType: 'concept',
            resourceId: input.conceptId,
            markingId,
          });
        }

        const after = await authzRepo.markingsOnResource(db, 'concept', input.conceptId);

        /*
         * RECORDED, BECAUSE REMOVING A MARKING IS THE INTERESTING EVENT. Adding
         * one narrows who can see something and fails safe; removing one widens
         * it, silently, for everybody, and the only trace would be this row.
         */
        await conceptRepo.recordRevision(db, {
          organisationId: actor.organisationId,
          conceptId: input.conceptId,
          change: 'markings_changed',
          previousState: { markings: [...before].sort() },
          newState: { markings: [...after].sort() },
          reason: input.reason?.trim() ?? null,
          changedBy: actor.membershipId,
        });

        await writeAudit(db, {
          event: 'concept_marking_changed',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            conceptId: input.conceptId,
            added: [...wanted].filter((id) => !before.includes(id)),
            removed: before.filter((id) => !wanted.has(id)),
          },
        });

        log.info(
          { conceptId: input.conceptId, markings: after.length },
          'Concept markings changed',
        );

        return after;
      }),
  );
}

/* ── §2.5 and §2.6 Resolution ────────────────────────────────────────────── */

/**
 * Resolve rows from several systems into entities, under one concept.
 *
 * THE FUNCTION THE ONTOLOGY EXISTS TO PRODUCE, and the reason the concept layer
 * is more than a catalogue. It was missing entirely: concepts were being
 * confirmed, stored and never used, while the disagreement detector did its own
 * matching inline — so identity was decided by one detector and unavailable to
 * the other nine.
 *
 * ── It is also where clearance is enforced ─────────────────────────────────
 *
 * `assertCleared` had NO CALLERS anywhere in this codebase. Markings could be
 * created and clearances granted, and nothing checked either. The compiler that
 * §7.3 describes — the stage that drops a marked concept from a plan before the
 * manifest is built — does not exist yet, and until it does this is the
 * narrowest honest place to put the check: resolution is the act that reveals a
 * restricted record's existence, so resolution is what must refuse.
 *
 * IT REFUSES BEFORE READING ANYTHING, not after. The rows are already in the
 * caller's hand by the time this is called, which is unavoidable while there is
 * no compiler — but nothing that leaves this function has been resolved, so no
 * count, no join and no entity crosses the boundary.
 */
export type ResolutionReport = {
  concept: { id: string; name: string };
  /**
   * Each entity, by the identifiers its systems know it by.
   *
   * NO ROWS, AND THE SHAPE IS THE ENFORCEMENT. `resolveEntities` carries the
   * whole row on each member because the arithmetic needs the match-key fields
   * to read; none of that may cross this boundary. What a reader is entitled to
   * is WHICH records are the same thing — identifiers, which is what §3.2
   * permits everywhere else — and never what any of them contained.
   */
  entities: Array<{ members: Array<{ connectionId: string; ref: string }> }>;
  /**
   * §2.6 — records with no counterpart, which is a QUESTION and not a finding.
   * Either the record is genuinely missing there, or it is spelled differently
   * and nobody has said so yet. Nothing here can tell those apart.
   */
  unmatched: Array<{ connectionId: string; ref: string; missingIn: string }>;
  /** How many rows carried a usable key, per connection. */
  keyed: Record<string, number>;
  /** Rows whose match keys were incomplete, so identity could not be read. */
  unkeyed: Record<string, number>;
  /** How many entities were found in EVERY contributing system. */
  completeAcrossAll: number;
  /** How many rows were looked at per connection, and whether that was all. */
  examined: Array<{ connectionId: string; rows: number; truncated: boolean }>;
};

/**
 * How many rows one resolution reads per system.
 *
 * A CEILING RATHER THAN A PAGE. This answers "how much of my estate resolves",
 * and an answer computed from a slice that silently stopped would report
 * unmatched records that are matched perfectly well two thousand rows further
 * down. When it is hit, `examined.truncated` says so and the number is a
 * statement about the slice rather than about the estate.
 */
const RESOLVE_ROWS = 5000;

/**
 * §2.6 — which records across these systems are the same thing, and which are not.
 *
 * ── The question this answers, which nothing else did ──────────────────────
 *
 * A concept says `customers` in Netsuite and `clients` in Sage mean one thing.
 * This is what turns that into an answer: these four thousand rows are two
 * thousand six hundred customers, and these ninety could not be matched to
 * anything. The last number is the interesting one — it is the honest measure
 * of how well an ontology actually fits an estate, and a customer had no way to
 * ask for it.
 *
 * ── It fetches its own rows, and that is the whole reshaping ───────────────
 *
 * It used to take rows as an argument, which made it unroutable: an HTTP
 * surface would have meant a client posting records INTO a product whose claim
 * is that it does not store them. `detector.run` already solves this by
 * fetching what it needs itself, and this now does the same — the caller names
 * a concept and nothing else.
 *
 * ONLY THE COLUMNS IDENTITY IS READ FROM. The identifier and the match keys,
 * and nothing else on the row. A resolution must not become a way to read a
 * table, which is the same bound derivation's profiling pass works under.
 *
 * ── Where clearance is enforced ────────────────────────────────────────────
 *
 * Here, and in `walk`. Resolution is the act that reveals a restricted record's
 * existence — that this customer is in both systems — so resolution is what
 * must refuse. §7.3's compiler would eventually drop a marked concept from a
 * plan before it was built; until it exists, this is the narrowest honest place
 * for the check.
 */
export async function resolve(
  actor: Actor,
  input: { conceptId: string; limit?: number },
): Promise<ResolutionReport> {
  const rowLimit = Math.min(input.limit ?? RESOLVE_ROWS, RESOLVE_ROWS);

  /* Read once, then let the database connection go: what follows is a request
     to each of somebody's own systems. */
  const plan = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);

        /*
         * THE SAME PERMISSION EVERY OTHER FAN-OUT SURFACE REQUIRES. This reaches
         * every system a concept spans and pulls thousands of rows from each;
         * `query.run` is what says somebody may do that, and it was missing —
         * clearance and reachability were both checked and the permission
         * itself was not, so anybody in the organisation could run it.
         */
        assertCan(authority, 'query.run');

        const concept = await conceptRepo.read(db, input.conceptId);
        if (!concept || concept.retiredAt) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }

        /* §2.5 — the side channel, closed. */
        await assertCleared(db, authority, {
          type: 'concept',
          id: concept.id,
          conceptIds: [concept.id],
        });

        /*
         * AND THE CONNECTIONS, because a concept somebody is cleared for can
         * still span a system they hold no grant on. Same `readableIds` the
         * query path uses, so the two cannot drift.
         */
        await assertReachable(
          db,
          actor,
          concept.objects.map((object) => object.connectionId),
        );

        return {
          concept,
          aliases: await resolutionRepo.confirmedFor(db, concept.id),
        };
      }),
  );

  const sources: Array<{ connectionId: string; object: ContributingObject; rows: Row[] }> = [];
  const examined: ResolutionReport['examined'] = [];

  for (const object of plan.concept.objects) {
    /*
     * `askComplete`, NOT `ask`. A resolution computed from one of two systems
     * would report every row in the other as unmatched — which is not a smaller
     * answer, it is a confidently wrong one, and it looks exactly like a
     * customer whose data genuinely does not line up.
     */
    const answered = await askComplete({
      actor,
      connectionIds: [object.connectionId],
      query: {
        object: object.objectName,
        filters: [],
        sort: [],
        /* The identifier and the match keys. Every other column on that row is
           a business value and identity is not read from one. */
        fields: [...new Set([object.identifierField, ...object.matchKeys])],
        limit: rowLimit,
      },
    });

    const rows = answered.flatMap((source) => source.result?.rows ?? []);
    sources.push({ connectionId: object.connectionId, object, rows });
    examined.push({
      connectionId: object.connectionId,
      rows: rows.length,
      truncated: rows.length >= rowLimit,
    });
  }

  const resolution = resolveEntities({
    sources,
    aliases: plan.aliases.map((alias) => ({
      connectionA: alias.connectionA,
      valueRefA: alias.valueRefA,
      connectionB: alias.connectionB,
      valueRefB: alias.valueRefB,
    })),
  });

  return {
    concept: { id: plan.concept.id, name: plan.concept.name },
    /* THE ROWS ARE DROPPED HERE, and this is the only place they could have
       escaped. `Member` carries one; nothing above this line may see it. */
    /*
     * ── `entity.key` IS NOT HERE, AND THAT WAS A LEAK ────────────────────────
     *
     * `resolveEntities` names a group by its MATCH KEY, and a match key is
     * `keyOf(row, matchKeys)` — the joined VALUES of the fields identity is
     * read from. With a match key of `email` that handle is an email address,
     * and the first version of this returned it over HTTP.
     *
     * It is not needed. An entity is identified by its members, which are
     * identifiers and are what §3.2 permits; a caller wanting a stable handle
     * has the sorted member refs. Hashing the key instead would be a one-way
     * function of customer values in a response, which is the same objection
     * that keeps a value sketch out of `field_profiles`.
     */
    entities: resolution.entities.map((entity) => ({
      members: entity.members.map((member) => ({
        connectionId: member.connectionId,
        ref: member.ref,
      })),
    })),
    unmatched: resolution.unmatched,
    keyed: resolution.keyed,
    unkeyed: resolution.unkeyed,
    completeAcrossAll: complete(
      resolution,
      plan.concept.objects.map((object) => object.connectionId),
    ).length,
    examined,
  };
}

/* ── Correction ──────────────────────────────────────────────────────────── */

/**
 * One concept, as the concept view shows it.
 *
 * MARKINGS COME BACK WITH IT, because "what does the system believe about my
 * estate" is not answerable without knowing which parts of it are restricted.
 */
export async function read(
  actor: Actor,
  conceptId: string,
): Promise<
  Concept & {
    resolvable: boolean;
    markings: string[];
    /**
     * §4.1 — what this concept references and what references it.
     *
     * THE OTHER HALF OF WHAT THE VIEW IS FOR. A concept on its own says which
     * objects mean one thing; the relationships say how that thing sits in the
     * customer's model, and they are the part nobody typed in — they come from
     * the foreign keys their own schemas declare.
     */
    relationships: Awaited<ReturnType<typeof clearedRelationships>>;
  }
> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const concept = await conceptRepo.read(db, conceptId);
        if (!concept) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }

        const readable = await readableIds(
          db,
          actor,
          concept.objects.map((object) => object.connectionId),
        );
        const objects = concept.objects.filter((object) => readable.has(object.connectionId));

        return {
          ...concept,
          objects,
          resolvable: concept.origin === 'system' ? objects.length === 1 : canResolve(objects),
          markings: await authzRepo.markingsOnResource(db, 'concept', conceptId),
          /* The same filter the collection endpoint applies, scoped to this
             concept — so the two surfaces cannot disagree about what may be
             shown to whom. */
          relationships: await clearedRelationships(db, actor, { conceptId }),
        };
      }),
  );
}

/**
 * Rename a concept.
 *
 * COSMETIC, AND RECORDED ANYWAY. A rename resolves exactly the same rows, so no
 * past answer changes meaning — but "what was this called in March" is a real
 * question when somebody is reading an old report, and the revision row is the
 * only place it will be.
 */
export async function rename(
  actor: Actor,
  input: { conceptId: string; name: string; reason?: string },
): Promise<Concept> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'concept.confirm');

        const concept = await conceptRepo.read(db, input.conceptId);
        if (!concept || concept.retiredAt) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }

        await assertReachable(db, actor, concept.objects.map((o) => o.connectionId));

        const name = input.name.trim();
        if (name === concept.name) {
          throw invalid({
            message: 'That is already its name.',
            code: 'invalid.concept_unchanged',
          });
        }

        const renamed = await conceptRepo.rename(db, concept.id, name);
        if (!renamed) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }

        await conceptRepo.recordRevision(db, {
          organisationId: actor.organisationId,
          conceptId: concept.id,
          change: 'renamed',
          previousState: { name: concept.name },
          newState: { name },
          reason: input.reason?.trim() ?? null,
          changedBy: actor.membershipId,
        });

        await writeAudit(db, {
          event: 'concept_corrected',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { conceptId: concept.id, change: 'renamed', from: concept.name, to: name },
        });

        const updated = await conceptRepo.read(db, concept.id);
        return updated!;
      }),
  );
}

/**
 * Change what a concept is built out of.
 *
 * THE CORRECTION THAT MATTERS, AND THE ONE THAT NEEDS A REASON. Changing which
 * objects contribute, or which fields they match on, changes WHICH ROWS ARE THE
 * SAME ENTITY — so every finding, count and comparison computed before this
 * point was computed against a different definition. The revision row is what
 * makes "why did this report say 400 in March and 380 now" answerable at all,
 * and the database refuses the change without a reason for the same purpose.
 *
 * CONFIRMED RESOLUTIONS SURVIVE IT. A person decided that Acme Group Ltd is
 * ACME GROUP LIMITED; that stays true when the match keys change, because it
 * was never derived from them. Re-deriving it would ask somebody the same
 * question again, which §2.6 exists to prevent.
 */
export async function correct(
  actor: Actor,
  input: { conceptId: string; objects: ContributingObject[]; reason: string },
): Promise<Concept> {
  assertResolvable(input.objects);

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'concept.confirm');

        const concept = await conceptRepo.read(db, input.conceptId);
        if (!concept || concept.retiredAt) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }

        /*
         * BOTH SETS, NOT JUST THE NEW ONE. Somebody who can reach the incoming
         * connections but not the outgoing ones could otherwise quietly detach
         * a system they were never permitted to see, and the concept would stop
         * resolving against it with no trace beyond a revision they wrote.
         */
        await assertReachable(db, actor, [
          ...new Set([
            ...concept.objects.map((o) => o.connectionId),
            ...input.objects.map((o) => o.connectionId),
          ]),
        ]);

        await conceptRepo.replaceObjects(db, {
          conceptId: concept.id,
          organisationId: actor.organisationId,
          /* THE SAME TREATMENT AS CONFIRMATION. Passing the caller's objects
             straight through blanked the field map, because the request body
             does not carry one — so a corrected concept stopped answering
             questions it had answered a moment earlier. */
          objects: await mappedObjects(db, actor, input.objects),
          addedBy: actor.membershipId,
        });

        await conceptRepo.recordRevision(db, {
          organisationId: actor.organisationId,
          conceptId: concept.id,
          change: 'objects_changed',
          previousState: { objects: concept.objects },
          newState: { objects: input.objects },
          reason: input.reason.trim(),
          changedBy: actor.membershipId,
        });

        await writeAudit(db, {
          event: 'concept_corrected',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            conceptId: concept.id,
            change: 'objects_changed',
            reason: input.reason.trim(),
            connections: input.objects.map((o) => o.connectionId),
          },
        });

        await rederiveRelationships(db, actor);

        log.info(
          { conceptId: concept.id, objects: input.objects.length },
          'Concept objects corrected',
        );

        const updated = await conceptRepo.read(db, concept.id);
        return updated!;
      }),
  );
}

/**
 * Retire a concept.
 *
 * NOT A DELETE, AND THE NAME IS RELEASED. Findings, associations and map links
 * reference it; deleting would cascade them away and take the evidence for
 * every answer it ever produced. Retiring leaves all of that intact and takes
 * the concept out of `concepts_name_live`, so a corrected replacement can be
 * confirmed under the same name — which is exactly what somebody retiring a
 * badly-keyed "supplier" is about to do.
 */
export async function retire(
  actor: Actor,
  input: { conceptId: string; reason: string },
): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'concept.confirm');

        const concept = await conceptRepo.read(db, input.conceptId);
        if (!concept || concept.retiredAt) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }

        await assertReachable(db, actor, concept.objects.map((o) => o.connectionId));

        await conceptRepo.retire(db, concept.id);

        /* A retired concept is no longer an end of anything: its relationships
           go with it, and the other side's link to it disappears. */
        await rederiveRelationships(db, actor);

        await conceptRepo.recordRevision(db, {
          organisationId: actor.organisationId,
          conceptId: concept.id,
          change: 'retired',
          previousState: { name: concept.name, objects: concept.objects },
          newState: {},
          reason: input.reason.trim(),
          changedBy: actor.membershipId,
        });

        await writeAudit(db, {
          event: 'concept_corrected',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { conceptId: concept.id, change: 'retired', reason: input.reason.trim() },
        });

        log.info({ conceptId: concept.id, name: concept.name }, 'Concept retired');
      }),
  );
}

/**
 * What has been done to a concept.
 *
 * THE OTHER HALF OF THE CONCEPT VIEW. Seeing what the system believes today is
 * half of it; seeing when somebody changed what it believes, and why, is what
 * turns "this number looks wrong" into an answerable question.
 */
export async function revisions(actor: Actor, conceptId: string): Promise<ConceptRevision[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const concept = await conceptRepo.read(db, conceptId);
        if (!concept) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }
        return conceptRepo.revisionsOf(db, conceptId);
      }),
  );
}

/* ── §4.1 Walking a relationship ─────────────────────────────────────────── */

export type WalkedPath = {
  /** The identifier this path started from, as its system states it. */
  from: string;
  /** Where it arrived, likewise raw. */
  to: string;
  /** The entity that identifier belongs to, as somebody confirmed it. */
  entity: string;
  /**
   * The same thing, in the other systems, where somebody has confirmed it.
   *
   * WHAT MAKES THE RESOLUTION VISIBLE RATHER THAN IMPLIED. The entity is named
   * after one member by a fixed rule, so the name alone cannot tell a reader
   * whether anything was resolved at all — this can.
   */
  alsoKnownAs: Array<{ connectionId: string; ref: string }>;
  /** Each relationship crossed, in order, naming the system that declared it. */
  via: Array<{
    connectionId: string;
    keyObject: string;
    keyField: string;
    direction: 'along' | 'against';
    fromValue: string;
    toValue: string;
  }>;
};

/**
 * Walk from instances of one concept to instances of another.
 *
 * ── Three layers, and the reason each is where it is ───────────────────────
 *
 * THE ROUTE is types: `ontology/relate` reads the concept graph and answers
 * whether an invoice can reach a supplier at all, from keys the customer's own
 * schemas declare. No instance is consulted and the answer is the same for
 * every invoice there has ever been.
 *
 * THE WALK is instances, and it is `engine/traverse`, which is arithmetic over
 * rows it is handed. It emits a query per hop and consumes what comes back; it
 * cannot reach a source, which is what makes a walk reproducible from a
 * transcript rather than from a re-run against systems that have since moved.
 *
 * THE RESOLUTION is here, at read time, and NOTHING BELOW THIS LINE DOES IT.
 * The walk carried keys exactly as the sources stated them; turning the reached
 * key into an entity happens now, against the pairs somebody has confirmed, and
 * happens again the next time somebody asks. That is what lets a resolution
 * corrected in September repair a walk recorded in March.
 *
 * ── What it is allowed to conclude ─────────────────────────────────────────
 *
 * That one thing sits upstream or downstream of another, and through which
 * keys. Never that one caused the other — see `describeRoute`, where the
 * vocabulary is fixed in code precisely so it is not left to whoever writes the
 * next template.
 */
export async function walk(
  actor: Actor,
  input: {
    fromConceptId: string;
    toConceptId: string;
    /** Identifiers to start from, as the starting system states them. */
    entityRefs: string[];
    /** Which of the available routes to take. They are different claims. */
    routeIndex?: number;
    limits?: Limits;
  },
): Promise<{
  /**
   * Every route that exists, shortest first.
   *
   * THE SYSTEM IS PART OF THE ROUTE AND NOT DECORATION. Two systems that both
   * declare `invoices.supplier_code` produce two routes whose sentences read
   * identically — they are the same statement about different sets of records —
   * and a caller choosing between them has nothing else to choose on.
   */
  routes: Array<{ description: string; connectionId: string; hops: number }>;
  taken: number;
  paths: WalkedPath[];
  /** True where a hop reached nothing — an answer, not a failure. */
  exhausted: boolean;
}> {
  const limits = input.limits ?? DEFAULT_LIMITS;

  /*
   * EVERYTHING THE WALK NEEDS TO KNOW, READ ONCE. The hops themselves are
   * requests to somebody's own systems and must not be made while a database
   * connection is held — the same reason `detector.run` loads and then lets go.
   */
  const plan = await runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);

        const from = await conceptRepo.read(db, input.fromConceptId);
        const to = await conceptRepo.read(db, input.toConceptId);

        if (!from || from.retiredAt || !to || to.retiredAt) {
          throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
        }

        /*
         * §2.5 — BOTH ENDS. A walk reveals that a restricted record exists and
         * which instance of it, which is the disclosure markings are for;
         * clearing the starting concept alone would let somebody walk into a
         * compartment they were kept out of.
         */
        for (const concept of [from, to]) {
          await assertCleared(db, authority, {
            type: 'concept',
            id: concept.id,
            conceptIds: [concept.id],
          });
        }

        const relationships = await conceptRepo.relationships(db);

        const routes = routesBetween({
          relationships,
          from: from.id,
          to: to.id,
          maxHops: limits.maxHops,
        });

        /*
         * ── EVERY CONCEPT ON EVERY ROUTE, NOT JUST THE TWO ENDS ──────────────
         *
         * A route walked BACKWARDS reaches an object no relationship names an
         * identifier for, so `beginWalk` refuses unless it is told. The first
         * version built this from the `from` and `to` concepts only — which is
         * enough for a one-hop route and wrong for every longer one, because
         * the object it comes back through belongs to an INTERMEDIATE concept.
         *
         * So a two-hop downstream route was offered in `routes` and then
         * refused the moment anybody chose it, with "nothing says what orders
         * calls itself by". Only one-hop routes were ever walked in a test.
         */
        const reached = new Set(
          routes.flatMap((route) => [
            route.fromConceptId,
            route.toConceptId,
            ...route.steps.flatMap((step) => [step.fromConceptId, step.toConceptId]),
          ]),
        );

        const identifiers = new Map<string, string>();
        for (const conceptId of reached) {
          const one = conceptId === from.id ? from : conceptId === to.id ? to : await conceptRepo.read(db, conceptId);
          if (!one) continue;
          for (const object of one.objects) {
            identifiers.set(objectKey(object.connectionId, object.objectName), object.identifierField);
          }
        }

        const names = new Map([from, to].map((concept) => [concept.id, concept.name]));
        const described = routes.map((route) => ({
          description: describeRoute(route, (id) => names.get(id) ?? 'something else'),
          connectionId: route.steps[0]!.connectionId,
          hops: route.steps.length,
        }));

        const taken = input.routeIndex ?? 0;
        const route = routes[taken];

        if (!route) {
          throw invalid({
            message:
              routes.length === 0
                ? `Nothing in your systems declares a key between ${from.name} and ${to.name}.`
                : `There ${routes.length === 1 ? 'is 1 route' : `are ${routes.length} routes`} between those two, and that is not one of them.`,
            code: 'invalid.no_route',
          });
        }

        /* The system the route runs in — fixed by its first step, and the same
           for every step, because a key is a statement inside one system. */
        const connectionId = route.steps[0]!.connectionId;
        await assertReachable(db, actor, [connectionId]);

        const starting = from.objects.find((one) => one.connectionId === connectionId);
        if (!starting) {
          throw invalid({
            message: `${from.name} has no object in the system that declares that key.`,
            code: 'invalid.concept_missing_object',
          });
        }

        const arriving = to.objects.find((one) => one.connectionId === connectionId);

        return {
          routes: described,
          taken,
          route,
          connectionId,
          /*
           * WHAT EACH OBJECT ON THE ROUTE CALLS ITSELF BY. A route walked
           * BACKWARDS reaches an object no relationship names an identifier
           * for — going from an order to the invoices that reference it, the
           * thing reached is an invoice, and only the concept knows what an
           * invoice is identified by here.
           *
           * TAKEN FROM THE CONCEPTS RATHER THAN THE MANIFESTS, because a
           * concept's `identifierField` is the one somebody CONFIRMED, and it
           * is what every finding about that object already refers to it by.
           * Reading the manifest instead could pick a different column and
           * produce a walk whose results no finding could be matched against.
           */
          identifiers: identifiers,
          startObject: starting.objectName,
          startField: starting.identifierField,
          arrivingIdentifier: arriving?.identifierField ?? null,
          aliases: await resolutionRepo.confirmedFor(db, to.id),
        };
      }),
  );

  const refuse = (refusal: { reason: string; bound?: { suggestion: string } }) => {
    throw bounds({
      message: refusal.bound
        ? `${refusal.reason} ${refusal.bound.suggestion}`
        : refusal.reason,
      code: 'bounds.walk',
    });
  };

  const begun = beginWalk({
    route: plan.route,
    from: { object: plan.startObject, field: plan.startField, values: input.entityRefs },
    identifiers: plan.identifiers,
    limits,
  });
  if (!begun.ok) refuse(begun.refusal);

  let walked = begun.ok ? begun.value : (undefined as never);

  for (;;) {
    const hop = nextQuery(walked, limits);
    if (!hop) break;

    /*
     * `ask`, NOT `askComplete`, IS THE WRONG CHOICE HERE and this is the right
     * one: a hop that half-answered reaches a set of orders that is not the set
     * that invoice touched, and the path printed from it looks exactly as
     * complete as one that is.
     */
    const answered = await askComplete({
      actor,
      connectionIds: [hop.connectionId],
      query: hop.query,
    });

    const absorbed = absorb(walked, answered[0]?.result?.rows ?? [], limits);
    if (!absorbed.ok) refuse(absorbed.refusal);
    walked = absorbed.ok ? absorbed.value : (undefined as never);
  }

  const paths = pathsThrough(walked);

  /*
   * ── Resolution, and where it honestly cannot be stated ────────────────────
   *
   * The walk arrives holding whatever field the last key pointed AT. Usually
   * that is the target object's identifier and the reached value names an
   * instance. Where the key points at some other column — a code that is unique
   * but is not what that object calls itself — the value is still a true
   * statement about what was reached and is NOT an entity, so it is reported
   * as reached and left unresolved rather than resolved against the wrong
   * field. Guessing here would attach findings to the wrong instance.
   */
  const resolvable = plan.arrivingIdentifier === walked.frontier.field;

  const identified = new Map(
    (resolvable
      ? identify({
          aliases: plan.aliases.map((alias) => ({
            connectionA: alias.connectionA,
            valueRefA: alias.valueRefA,
            connectionB: alias.connectionB,
            valueRefB: alias.valueRefB,
          })),
          refs: paths.map((path) => ({ connectionId: plan.connectionId, ref: path.to })),
        })
      : []
    ).map((found) => [found.ref, found] as const),
  );

  return {
    routes: plan.routes,
    taken: plan.taken,
    exhausted: walked.exhausted,
    paths: paths.map((path) => ({
      from: path.from,
      to: path.to,
      entity: identified.get(path.to)?.entity ?? path.to,
      alsoKnownAs: identified.get(path.to)?.alsoKnownAs ?? [],
      via: path.via.map((crossing) => ({
        connectionId: crossing.connectionId,
        keyObject: crossing.keyObject,
        keyField: crossing.keyField,
        direction: crossing.direction,
        fromValue: crossing.fromValue,
        toValue: crossing.toValue,
      })),
    })),
  };
}
