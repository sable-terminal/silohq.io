import { createHash } from 'node:crypto';
import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { invalid, notFound, policy } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { childLogger } from '../config/logger.config';
import { readableIds } from './connector.service';
import { directionOf, resolveFor, tunedThreshold, weightOf, type MapElement } from '../engine/analysis/maps.analysis';
import * as mapRepo from '../repos/map.repo';
import * as conceptRepo from '../repos/concept.repo';
import {
  isSharingPolicy,
  summarise,
  type MapAccess,
  type SharingPolicy,
  type MapRecord,
  type MapSummary,
  type ThresholdOrigin,
} from '../models/map.model';
import type { Actor } from './scope.service';

const log = childLogger('map');

/*
 * THE TRANSACTION CLIENT, NOT THE LOOSER EXECUTOR. `readableIds` needs the
 * former, and taking anything wider here would push the mismatch to the call
 * site as a type error nobody can act on.
 */
type Db = Parameters<typeof readableIds>[0];

/**
 * §6 — maps.
 *
 * THE LEARNED LAYER, AND THE ONE PLACE A PERMISSION COULD LEAK SIDEWAYS. A map
 * is shareable and full of references to concepts and connections; opening one
 * resolves it against the OPENER, which is §6.4 and is enforced in `open`
 * below. The arithmetic — what survives the re-check, what a disposition does
 * to a weight — is in `engine/maps` where it is testable without a database,
 * and the statements are in `repos/map.repo` where each has one shape to
 * verify. What is left here is the deciding: who may do what, what a missing
 * row means, and whose reach a map is resolved against.
 *
 * NOTHING HERE WRITES A VALUE. §6.1: references, counts and dispositions. Read
 * every insert in the repo for a column holding something read out of a
 * customer's record; there is none, because 036 gave them nowhere to go.
 */

export type { MapSummary };

/* ── Which map is in play ────────────────────────────────────────────────── */

/**
 * The map this person's work goes into, created on first use.
 *
 * AUTO-CREATED, BECAUSE THE ALTERNATIVE IS AN ONBOARDING STEP THAT TEACHES
 * NOTHING. "Create a map before the system can learn from you" is a form
 * standing in front of a feature whose whole point is that it accumulates
 * quietly. The first dismissal makes one.
 *
 * §6.2 — IT BELONGS TO A MEMBERSHIP. A lawyer and an engineer in one company
 * weight different concepts and dismiss different findings, and one shared map
 * would average them into something useful to neither.
 */
export async function activeMapFor(db: Db, actor: Actor): Promise<string> {
  const existing = await mapRepo.activeFor(db, actor.membershipId);
  if (existing) return existing.id;

  /* THE READ ABOVE AND THIS WRITE ARE NOT ONE ACT. Two of somebody's first
     actions can arrive together — a double-clicked dismissal, a detector run
     recording a threshold beside one — and both find no map. `insertDefault` is
     an upsert for that reason: the second caller reads back the first's id
     rather than colliding with it. */
  const id = await mapRepo.insertDefault(db, {
    organisationId: actor.organisationId,
    ownerMembershipId: actor.membershipId,
  });

  log.info({ mapId: id, membershipId: actor.membershipId }, 'Map created on first use');
  return id;
}

export async function create(
  actor: Actor,
  input: { name: string; forkFromMapId?: string },
): Promise<MapSummary> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const name = input.name.trim();

        /*
         * §6.4 — COPY FORKS. The snapshot then learns independently: the
         * recipient's dismissals do not reach the original, which is the only
         * thing that makes sharing safe under §6.2's per-person rule.
         */
        let forkedFrom: string | null = null;
        if (input.forkFromMapId) {
          const source = await openable(db, actor, input.forkFromMapId, 'copy');
          forkedFrom = source.id;
        }

        const id = await mapRepo.insert(db, {
          organisationId: actor.organisationId,
          ownerMembershipId: actor.membershipId,
          name,
          forkedFrom,
        });

        if (forkedFrom) {
          /*
           * COPIED THROUGH THE OPENER'S REACH, NOT WHOLESALE. A fork that
           * carried rows referencing concepts this person cannot resolve would
           * be the escalation §6.4 forbids, only written down and permanent.
           */
          const reach = await reachOf(db, actor);

          await mapRepo.copyInto(db, {
            fromMapId: forkedFrom,
            toMapId: id,
            conceptIds: [...reach.concepts],
            connectionIds: [...reach.connections],
          });
        }

        await writeAudit(db, {
          event: 'map_created',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { mapId: id, name, forkedFrom },
        });

        return read(db, id, actor);
      }),
  );
}

export async function list(actor: Actor): Promise<MapSummary[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        /*
         * MINE, PLUS WHAT WAS SHARED WITH ME. A share is a scope membership, a
         * direct grant or the whole organisation — the same three grantees
         * `connection_grants` uses, because it is the same question and two
         * answers to it in one database is how a permission bug hides.
         */
        const maps = await mapRepo.listVisibleTo(db, actor.membershipId);

        return maps.map((map) => summarise(map, actor.membershipId));
      }),
  );
}

/**
 * Open a map, resolved against whoever opened it.
 *
 * §6.4 — A MAP MUST NEVER BECOME A PERMISSION ESCALATION. A shared map
 * routinely references concepts the recipient cannot see, and resolving those
 * with the owner's reach would turn "share my map" into "lend somebody my
 * grants". The decision is `engine/maps.resolveFor`; what this function
 * contributes is the honest answer to "what can this person actually reach",
 * taken from the same `readableIds` the query path uses so the two cannot
 * drift.
 *
 * COVERAGE IS RETURNED, NOT LOGGED. §6.4 says a share states how much of the
 * map is reachable rather than leaving the recipient to discover it, and a
 * number that only appears in a log statement is the same as no number.
 */
export async function open(
  actor: Actor,
  mapId: string,
): Promise<{
  map: MapSummary;
  elements: MapElement[];
  coverage: number;
  dropped: number;
  unreachableConnections: string[];
}> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const map = await openable(db, actor, mapId, 'use');
        const elements = await mapRepo.elementsOf(db, mapId);
        const resolved = resolveFor(elements, await reachOf(db, actor));

        if (resolved.dropped.length > 0) {
          log.info(
            { mapId, dropped: resolved.dropped.length, coverage: resolved.coverage },
            'Map opened with elements dropped for the opener',
          );
        }

        return {
          map: await read(db, map.id, actor),
          elements: resolved.kept,
          coverage: resolved.coverage,
          dropped: resolved.dropped.length,
          unreachableConnections: resolved.unreachableConnections,
        };
      }),
  );
}

export async function activate(actor: Actor, mapId: string): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        await mine(db, actor, mapId);

        /* One default per person: the partial unique index would refuse a
           second, so the old one is cleared first rather than caught. */
        await mapRepo.deactivateAll(db, actor.membershipId);
        await mapRepo.activate(db, mapId);
      }),
  );
}

export async function archive(actor: Actor, mapId: string): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        await mine(db, actor, mapId);

        /*
         * ARCHIVED, NOT DELETED. Everything anybody was shown while it was
         * active was ordered by what is in it, and a map that vanishes makes
         * those orderings unexplainable — the same argument `outcome_designations`
         * makes for retiring rather than deleting.
         */
        await mapRepo.archive(db, mapId);

        await writeAudit(db, {
          event: 'map_archived',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { mapId },
        });
      }),
  );
}

/* ── §6.3 and §6.4 Sharing ───────────────────────────────────────────────── */

export type Grantee =
  | { membershipId: string }
  | { scopeId: string }
  | { organisationWide: true };

/**
 * Share a map, within the organisation and no further.
 *
 * §6.5 — THERE IS NO EXTERNAL GRANTEE AND THERE MUST NEVER BE ONE. A map is a
 * description of how one person reads their own company's systems; it never
 * leaves the organisation, and the schema has nowhere to send it.
 *
 * THE POLICY IS CHECKED HERE, NOT AT THE ROUTE. §6.4 — open, scope only,
 * explicit only, or disabled. Which grantees are legal depends on a row, and a
 * route cannot read a row.
 */
export async function share(
  actor: Actor,
  mapId: string,
  input: { grantee: Grantee; access: MapAccess; expiresAt?: string },
): Promise<{ id: string; coverage: number | null }> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        await mine(db, actor, mapId);

        /* THE NARROWEST SETTING WHEN THERE IS NO ROW TO READ. §6.3 is private
           by default, so an organisation that cannot be read is one nothing may
           be shared across. */
        const sharingPolicy =
          (await mapRepo.sharingPolicyOf(db, actor.organisationId)) ?? 'explicit_only';

        const grantee = input.grantee;
        const wide = 'organisationWide' in grantee;
        const scoped = 'scopeId' in grantee;

        if (sharingPolicy === 'disabled') {
          throw policy({
            message: 'Sharing is turned off for this organisation.',
            code: 'policy.sharing_disabled',
          });
        }
        if (sharingPolicy === 'explicit_only' && !('membershipId' in grantee)) {
          throw policy({
            message: 'This organisation allows sharing with named people only.',
            code: 'policy.sharing_explicit_only',
          });
        }
        if (sharingPolicy === 'scope_only' && wide) {
          throw policy({
            message: 'This organisation does not allow sharing with everybody.',
            code: 'policy.sharing_scope_only',
          });
        }

        const id = await mapRepo.upsertShare(db, {
          organisationId: actor.organisationId,
          mapId,
          membershipId: 'membershipId' in grantee ? grantee.membershipId : null,
          scopeId: scoped ? grantee.scopeId : null,
          organisationWide: wide,
          access: input.access,
          sharedBy: actor.membershipId,
          expiresAt: input.expiresAt ?? null,
        });

        /*
         * §6.4 — CONNECTOR COVERAGE IS WARNED, NOT SILENTLY DEGRADED. A map
         * built on engineering systems, shared with somebody who has no grant on
         * them, is largely inert; the share says so at the moment it is made.
         *
         * ONLY FOR A NAMED PERSON, because coverage is a fact about one
         * recipient's grants. Sharing with a scope or an organisation has as
         * many answers as there are members, and averaging them would be worse
         * than saying nothing.
         */
        const coverage =
          'membershipId' in grantee
            ? await coverageFor(db, mapId, {
                organisationId: actor.organisationId,
                membershipId: grantee.membershipId,
              })
            : null;

        await writeAudit(db, {
          event: 'map_shared',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: {
            mapId,
            access: input.access,
            grantee: 'membershipId' in grantee ? grantee.membershipId : scoped ? grantee.scopeId : 'organisation',
            coverage,
          },
        });

        return { id, coverage };
      }),
  );
}

export async function revokeShare(actor: Actor, shareId: string): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const existing = await mapRepo.findLiveShare(db, shareId);

        if (!existing) {
          throw notFound({
            message: 'That share does not exist, or was already revoked.',
            code: 'missing.map_share',
          });
        }

        await mine(db, actor, existing.mapId);
        await mapRepo.revokeShare(db, shareId);

        await writeAudit(db, {
          event: 'map_share_revoked',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { shareId, mapId: existing.mapId },
        });
      }),
  );
}

/* ── §6.6 Feedback ───────────────────────────────────────────────────────── */

/**
 * §6.6 — a disposition writes to the map.
 *
 * SILENCED FOR THE PERSON, NOT THE ORGANISATION. This writes to the acting
 * membership's own map and nowhere else, which is the same statement
 * `finding_dispositions` makes with its unique constraint. One user dismissing a
 * finding does not remove it from a colleague's view.
 *
 * IT NEVER CHANGES WHAT A DETECTOR COMPUTES. The weight moves ranking and
 * connector selection. Detection stays arithmetic, and "the same data produces
 * the same findings" stays true — which is what makes a finding explainable at
 * all.
 *
 * CALLED INSIDE THE CALLER'S TRANSACTION, so a disposition and the learning it
 * produces commit together. A dismissal that recorded but did not teach is a
 * dismissal the person will make again next week.
 */
export async function recordDisposition(
  db: Db,
  actor: Actor,
  input: { conceptId: string; detector: string; disposition: string },
): Promise<void> {
  const direction = directionOf(input.disposition);
  if (!direction) return;

  const mapId = await activeMapFor(db, actor);

  const counts = await mapRepo.bumpDetectorCounts(db, {
    organisationId: actor.organisationId,
    mapId,
    conceptId: input.conceptId,
    detector: input.detector,
    signal: direction === 'signal' ? 1 : 0,
    noise: direction === 'noise' ? 1 : 0,
  });

  await mapRepo.setDetectorWeight(db, {
    mapId,
    conceptId: input.conceptId,
    detector: input.detector,
    weight: weightOf(counts.signalCount, counts.noiseCount),
  });
}

/**
 * §5.5 — what the reader's active map has learned about each detector.
 *
 * ── The other half of a loop that only ever wrote ──────────────────────────
 *
 * `recordDisposition` has been accumulating these since maps existed: every
 * time somebody confirms or dismisses a finding, the detector that raised it
 * gains a signal or a noise count and its weight moves. Nothing read the weight
 * back, so the learning was real, stored, and inert — a map could watch
 * somebody dismiss the same detector forty times and go on ordering it exactly
 * as it did on the first day.
 *
 * IT IS READ HERE AND APPLIED IN §5, not in detection. A weight is a statement
 * about what is worth READING FIRST in this organisation, which is ranking's
 * question. Letting it reach the detectors would change what is TRUE rather
 * than what is surfaced, and a detector that stops raising findings because
 * somebody dismissed some is a detector that has been switched off by accident.
 */
export async function detectorWeights(db: Db, actor: Actor) {
  return mapRepo.detectorWeights(db, await activeMapFor(db, actor));
}

/**
 * §6.1 — record which connections a question of this shape needed.
 *
 * ── The shape, never the question ──────────────────────────────────────────
 *
 * 036 is explicit that storing the question would put a customer's own words —
 * which routinely carry a supplier name, a person or an amount — into the
 * learned layer. What is hashed is the PLAN: the concept, the fields and the
 * operators. That is enough to recognise the same shape when it is asked again
 * and carries nothing back.
 *
 * WRITTEN AFTER AN ANSWER, NOT AFTER A PLAN. A question that failed to execute
 * taught nothing about which connections are worth reaching for, and recording
 * it would teach the map to favour whatever happened to be broken.
 */
export async function recordConnectorUse(
  db: Db,
  actor: Actor,
  input: { shape: string; connectionIds: readonly string[] },
): Promise<void> {
  const mapId = await activeMapFor(db, actor);

  await mapRepo.recordConnectorUse(db, {
    organisationId: actor.organisationId,
    mapId,
    queryPatternHash: hashShape(input.shape),
    connectionIds: input.connectionIds,
  });
}

/**
 * §6.1 — two concepts a question actually related.
 *
 * ── The trigger arrived with joins ─────────────────────────────────────────
 *
 * `map_links` had a reader and a copy-on-fork and no writer, so the table was
 * permanently empty and forking a map copied nothing out of it. The blocker was
 * never the schema: a plan named ONE concept, so nothing in the product could
 * say a question had genuinely crossed two.
 *
 * A join can. Both concepts were named by somebody who wanted the answer, and
 * the answer came back — which is the only honest evidence this was waiting for.
 *
 * AFTER THE ANSWER, LIKE `recordConnectorUse`. A join that failed to execute
 * says nothing about whether those two concepts belong together.
 *
 * NO VALUES AND NO QUESTION, also like it — two concept ids and a count.
 */
export async function reinforceLink(
  db: Db,
  actor: Actor,
  input: { conceptA: string; conceptB: string },
): Promise<void> {
  await mapRepo.reinforceLink(db, {
    organisationId: actor.organisationId,
    mapId: await activeMapFor(db, actor),
    conceptA: input.conceptA,
    conceptB: input.conceptB,
  });
}

/**
 * §3.4 — move the thresholds this map's own dispositions say are wrong.
 *
 * ── RUNS AT THE AI STAGE; THE MODEL DOES NOT PICK THE NUMBER ───────────────
 *
 * §3.4 says the AI stage adjusts a threshold. It runs here, after a ranking,
 * and the adjustment is computed from what people did with what the detector
 * raised — because a threshold decides whether a finding EXISTS, and a number a
 * model chose cannot be explained to somebody asking why an exception stopped
 * appearing. §6.6 already grants the map this power; §3.3 is what constrains
 * how it may be exercised.
 *
 * AUDITED WHENEVER IT MOVES, with the evidence that moved it. "Why did this
 * stop appearing in March" is a question only a row can answer.
 */
export async function tuneThresholds(db: Db, actor: Actor): Promise<number> {
  const mapId = await activeMapFor(db, actor);
  const weights = await mapRepo.detectorWeights(db, mapId);

  let moved = 0;

  for (const weight of weights) {
    const current = await mapRepo.tunedThresholdFor(db, {
      mapId,
      conceptId: weight.conceptId,
      detector: weight.detector,
    });

    /* Nothing recorded yet means nothing has run; there is no threshold to
       move and deriving one here would invent a baseline from opinions. */
    if (current === null) continue;

    const next = tunedThreshold(current, weight.signalCount, weight.noiseCount);
    if (!next.moved) continue;

    await mapRepo.recordThreshold(db, {
      organisationId: actor.organisationId,
      mapId,
      conceptId: weight.conceptId,
      detector: weight.detector,
      value: next.value,
      origin: 'tuned',
    });

    await writeAudit(db, {
      event: 'threshold_tuned',
      organisationId: actor.organisationId,
      membershipId: actor.membershipId,
      userId: null,
      detail: {
        conceptId: weight.conceptId,
        detector: weight.detector,
        value: next.value,
        previousValue: current,
        signalCount: weight.signalCount,
        noiseCount: weight.noiseCount,
      },
    });

    moved += 1;
  }

  return moved;
}

/** Which connections this map has needed for a question of this shape before. */
export async function connectorsFor(db: Db, actor: Actor, shape: string) {
  return mapRepo.connectorRelevance(db, {
    mapId: await activeMapFor(db, actor),
    queryPatternHash: hashShape(shape),
  });
}

/*
 * SHA-256 OF THE SHAPE. The column takes 16 to 128 characters and a hex digest
 * is 64; it is a fingerprint rather than a secret, so no keying is needed —
 * there is nothing in the input worth protecting, which is the point.
 */
const hashShape = (shape: string) => createHash('sha256').update(shape).digest('hex');

/* ── §3.4 Threshold persistence ──────────────────────────────────────────── */

/**
 * The threshold this map has learned for a detector on a concept.
 *
 * NULL IS A COMPLETE ANSWER AND THE COMMON ONE. §3.4 — an initial threshold is
 * derived from the query itself, so a newly connected system produces sensible
 * findings with no row here at all. That is what makes this an optimisation
 * rather than a configuration step somebody has to complete first.
 *
 * A TUNED ONE IS USED DIRECTLY; A DERIVED ONE IS NOT. §3.4 says a threshold
 * that has been through the loop several times is used rather than re-derived —
 * so only `tuned` is returned. Handing back a number this system derived last
 * week would freeze a first guess made against a population that has since
 * changed.
 */
export async function thresholdFor(
  db: Db,
  actor: Actor,
  input: { conceptId: string; detector: string },
): Promise<number | null> {
  const mapId = await activeMapFor(db, actor);

  return mapRepo.tunedThresholdFor(db, {
    mapId,
    conceptId: input.conceptId,
    detector: input.detector,
  });
}

/**
 * Record what a run used, or what the model tuned it to.
 *
 * THE RUN COUNT IS WHAT MAKES "SEVERAL TIMES" MEASURABLE. §3.4's rule is that a
 * threshold used repeatedly is trusted; without counting, "repeatedly" is a
 * word in a spec rather than a condition anything can test.
 */
export async function recordThreshold(
  db: Db,
  actor: Actor,
  input: { conceptId: string; detector: string; value: number; origin: ThresholdOrigin },
): Promise<void> {
  const mapId = await activeMapFor(db, actor);

  await mapRepo.recordThreshold(db, {
    organisationId: actor.organisationId,
    mapId,
    conceptId: input.conceptId,
    detector: input.detector,
    value: input.value,
    origin: input.origin,
  });
}

/* ── Shared helpers ──────────────────────────────────────────────────────── */

async function read(db: Db, mapId: string, actor: Actor): Promise<MapSummary> {
  const map = await mapRepo.read(db, mapId);
  if (!map) throw notFound({ message: 'That map does not exist.', code: 'missing.map' });

  return summarise(map, actor.membershipId);
}

/** Mine to change: sharing, renaming and archiving are the owner's alone. */
async function mine(db: Db, actor: Actor, mapId: string): Promise<void> {
  const owned = await mapRepo.findOwned(db, {
    mapId,
    ownerMembershipId: actor.membershipId,
  });

  if (!owned) {
    /* NOT FOUND RATHER THAN FORBIDDEN. Whether somebody else's map exists is
       not a fact this endpoint should confirm. */
    throw notFound({ message: 'That map does not exist.', code: 'missing.map' });
  }
}

/** Mine, or shared with me at least this strongly. */
async function openable(
  db: Db,
  actor: Actor,
  mapId: string,
  need: MapAccess,
): Promise<MapRecord> {
  const map = await mapRepo.findOpenable(db, {
    mapId,
    membershipId: actor.membershipId,
    need,
  });

  if (!map) {
    throw notFound({ message: 'That map does not exist.', code: 'missing.map' });
  }
  return map;
}

/**
 * What this person can actually reach.
 *
 * THE SAME `readableIds` THE QUERY PATH USES, deliberately. Three hand-written
 * versions of "can they read this connection" agree right up until one is
 * edited, and the one that drifts is discovered by somebody seeing data they
 * should not.
 *
 * A CONCEPT NEEDS TWO REACHABLE OBJECTS, matching `ontology.list`'s
 * `resolvable`. One contributing object has nothing to match against, so a
 * concept the opener can only half-reach is one they cannot use — and a map
 * element pointing at it would be a reference to something inert.
 */
async function reachOf(db: Db, actor: Actor): Promise<{ concepts: Set<string>; connections: Set<string> }> {
  const contributions = await conceptRepo.liveContributions(db);

  const connections = await readableIds(
    db,
    actor,
    [...new Set(contributions.map((object) => object.connectionId))],
  );

  const reachableObjects = new Map<string, number>();
  for (const object of contributions) {
    if (!connections.has(object.connectionId)) continue;
    reachableObjects.set(object.conceptId, (reachableObjects.get(object.conceptId) ?? 0) + 1);
  }

  const concepts = new Set(
    [...reachableObjects.entries()].filter(([, count]) => count >= 2).map(([id]) => id),
  );

  return { concepts, connections };
}

async function coverageFor(
  db: Db,
  mapId: string,
  recipient: { organisationId: string; membershipId: string },
): Promise<number> {
  const elements = await mapRepo.elementsOf(db, mapId);
  if (elements.length === 0) return 1;

  /*
   * THE RECIPIENT'S REACH, COMPUTED AS THOUGH THEY WERE ASKING. `readableIds`
   * takes an actor and answers for that actor, so the only honest way to say
   * what a share is worth to somebody is to ask it about them.
   */
  const reach = await reachOf(db, {
    organisationId: recipient.organisationId,
    membershipId: recipient.membershipId,
  } as Actor);

  return resolveFor(elements, reach).coverage;
}

/**
 * AN ASSERTION SIGNATURE, NOT A `void` CHECK. Returning void made the guard
 * runtime-only: the caller still held a `string` afterwards and had to cast,
 * which is the cast that lets an unchecked value through next time.
 */
export function assertSharingPolicy(value: string): asserts value is SharingPolicy {
  if (!isSharingPolicy(value)) {
    throw invalid({ message: 'That is not a sharing policy.', code: 'invalid.sharing_policy' });
  }
}
