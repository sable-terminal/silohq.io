import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import { childLogger } from '../config/logger.config';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf } from './authorisation.service';
import * as conceptRepo from '../repos/concept.repo';
import * as dependencyEdgeRepo from '../repos/dependencyEdge.repo';
import * as edgeRevisionRepo from '../repos/edgeRevision.repo';
import * as edgeObservationRepo from '../repos/edgeObservation.repo';
import * as siloRepo from '../repos/silo.repo';
import * as conceptService from './concept.service';
import {
  asLeadTime,
  distributionOf,
  elapsed,
  MIN_SAMPLES_TO_PROPOSE,
} from '../engine/simulation/observe.simulation';
import { OBSERVATION_EVENT_LIMIT } from '../config/constants.config';
import { SIMULATION_DISCLOSURE } from '../models/simulationDisclosure.model';
import { invalid, notFound } from '../utils/error.util';
import type { Actor } from './scope.service';

const log = childLogger('dependency-graph');

/**
 * Simulation §2 — the graph a simulation walks, and the only part of Silo a
 * customer has to supply themselves.
 *
 * ── §11, the honest constraint ─────────────────────────────────────────────
 *
 * "Simulation is only as good as the graph, and the graph is supplied by the
 * customer. Derivation proposes, history sharpens, but the assertion that one
 * thing waits on another is theirs."
 *
 * So this file proposes and nothing more. Every edge it writes is inert: §2.3
 * puts a person between a proposal and the graph, and §3 walks confirmed edges
 * only.
 *
 * ── What derivation can and cannot know ────────────────────────────────────
 *
 * §2.2 — "The ontology's relationships give candidate edges and their
 * direction." That is the whole of it. A relationship says an invoice points at
 * an order; it does not say the order waits on it, whether it could proceed
 * degraded, or for how long. So a proposal carries a direction and an evidence
 * reference, and leaves the kind and the lead time empty for somebody who knows.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

export type Proposed = {
  proposed: number;
  /** Already there, proposal or confirmed. Left untouched. */
  existing: number;
};

/**
 * §2.2 — read the ontology and propose candidate edges.
 *
 * RUNNABLE AGAIN, SAFELY, AND THAT IS THE POINT. The ontology grows; derivation
 * is run again; anything already there is left exactly as it is. A confirmed
 * edge overwritten by a fresh structural proposal would silently un-decide a
 * decision §2.3 says holds until a person changes it.
 *
 * DIRECTION COMES FROM THE RELATIONSHIP, NOT FROM A GUESS. A relationship is
 * already directed — this object's field points at that one — and that
 * direction is the candidate's. Whether the dependency actually runs that way
 * is one of the things the person confirming decides.
 */
export async function derive(actor: Actor): Promise<Proposed> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'graph.propose');

      const relationships = await conceptRepo.relationships(db);

      let proposed = 0;
      let existing = 0;

      for (const relationship of relationships) {
        /* A concept does not wait on itself; the schema refuses it too. */
        if (relationship.fromConceptId === relationship.toConceptId) continue;

        const edge = await dependencyEdgeRepo.propose(db, {
          id: generateId(),
          organisationId: actor.organisationId,
          fromConceptId: relationship.fromConceptId,
          toConceptId: relationship.toConceptId,
          source: 'structure',
          evidenceRef: relationship.id,
        });

        if (!edge) {
          existing += 1;
          continue;
        }

        proposed += 1;

        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'graph_edge_proposed',
          detail: {
            edgeId: edge.id,
            fromConceptId: edge.fromConceptId,
            toConceptId: edge.toConceptId,
            source: 'structure',
          },
        });
      }

      log.info({ proposed, existing }, 'Dependency edges derived');
      return { proposed, existing };
    }),
  );
}

export type EdgeView = dependencyEdgeRepo.DependencyEdge & {
  from: { id: string; name: string };
  to: { id: string; name: string };
  /**
   * §4.3 — "Sample size for every edge on the path, always shown."
   *
   * Null where nothing has been measured, which is a different thing from a
   * sample of nought and has to read differently on the screen where somebody
   * decides whether to trust the lead time beside it.
   */
  observation: edgeObservationRepo.EdgeObservation | null;
};

export interface GraphView {
  edges: EdgeView[];
  /**
   * §11 — "This should be said in the product at the point someone enables it,
   * not discovered after they run the first scenario."
   *
   * There is no enable switch. What makes simulation work is somebody sitting
   * down with this list, so this list is the point, and it carries the
   * constraint rather than leaving a front end to remember it.
   */
  disclosure: readonly string[];
  /** §11 — how much of that afternoon is left, stated rather than implied. */
  unconfirmed: number;
}

/**
 * The graph as it stands, proposals included.
 *
 * §11 — "A customer unwilling to spend an afternoon confirming edges will get a
 * simulation that stops at the first unconfirmed hop." This listing is where
 * that afternoon happens, so the unconfirmed come first.
 */
export async function list(actor: Actor): Promise<EdgeView[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const edges = await dependencyEdgeRepo.list(db);
      const concepts = new Map(
        (await conceptRepo.listLive(db)).map((concept) => [concept.id, concept.name]),
      );
      const observations = new Map(
        (await edgeObservationRepo.all(db)).map((one) => [one.edgeId, one]),
      );

      return edges.map((edge) => ({
        ...edge,
        from: { id: edge.fromConceptId, name: concepts.get(edge.fromConceptId) ?? '' },
        to: { id: edge.toConceptId, name: concepts.get(edge.toConceptId) ?? '' },
        observation: observations.get(edge.id) ?? null,
      }));
    }),
  );
}

/**
 * §2.1 — what a person supplies when they decide an edge.
 *
 * A LEAD TIME IS MANDATORY AND A BUFFER IS NOT, which is the schema's rule
 * restated where a caller can see it. §3.1 accumulates delay along a path, so a
 * confirmed edge with no lead time would be walked as nought and would quietly
 * shorten every result it appeared in. A buffer — §2.1's "how long the
 * downstream thing runs on hand" — genuinely may not exist.
 */
export interface EdgeJudgement {
  kind: dependencyEdgeRepo.EdgeKind;
  leadTimeValue: number;
  leadTimeUnit: dependencyEdgeRepo.TimeUnit;
  bufferValue: number | null;
  bufferUnit: dependencyEdgeRepo.TimeUnit | null;
  /**
   * §3.2 — "A soft edge propagates the delay and the stated cost, and the
   * downstream thing continues."
   *
   * REQUIRED ON A SOFT EDGE AND REFUSED ON THE OTHERS. A soft edge with no
   * stated cost says the downstream thing carries on and declines to say at
   * what price, which is the half of §3.2 that makes soft different from no
   * edge at all. A hard edge has nothing to state: it does not carry on.
   */
  degradedCost: string | null;
  /**
   * §2.1 — "Several downstream things compete for the same upstream capacity."
   *
   * REQUIRED ON A RESOURCE EDGE AND REFUSED ON THE OTHERS. A resource edge with
   * no capacity is a hard edge with extra words: contention is the whole of
   * what makes it a different kind, and contention needs a rate.
   */
  capacityValue: number | null;
  capacityUnit: dependencyEdgeRepo.TimeUnit | null;
}

const stateOf = (edge: dependencyEdgeRepo.DependencyEdge): edgeRevisionRepo.EdgeState => ({
  kind: edge.kind,
  leadTimeValue: edge.leadTimeValue,
  leadTimeUnit: edge.leadTimeUnit,
  bufferValue: edge.bufferValue,
  bufferUnit: edge.bufferUnit,
  degradedCost: edge.degradedCost,
  capacityValue: edge.capacityValue,
  capacityUnit: edge.capacityUnit,
  retired: edge.retiredAt !== null,
});

/**
 * §2.1 — "a value and a unit", and a buffer is one thing or neither.
 *
 * CHECKED HERE AS WELL AS IN THE SCHEMA. The CHECK constraint is the guarantee;
 * this is the message. A caller who sends half a buffer gets told which half is
 * missing rather than a constraint name.
 */
function assertJudgement(judgement: EdgeJudgement): void {
  if ((judgement.bufferValue === null) !== (judgement.bufferUnit === null)) {
    throw invalid({
      message: 'A buffer needs both a value and a unit, or neither.',
      code: 'edge.buffer_incomplete',
    });
  }

  /* §3.2 — the schema says this too; this is the sentence rather than a
     constraint name. */
  if ((judgement.kind === 'soft') !== (judgement.degradedCost !== null)) {
    throw invalid({
      message:
        judgement.kind === 'soft'
          ? 'A soft edge has to say what proceeding degraded costs.'
          : 'Only a soft edge has a degraded cost; the others do not carry on.',
      code: 'edge.degraded_cost_mismatch',
    });
  }

  if ((judgement.capacityValue === null) !== (judgement.capacityUnit === null)) {
    throw invalid({
      message: 'A capacity needs both a value and a unit.',
      code: 'edge.capacity_incomplete',
    });
  }

  /* §2.1 — contention is what makes a resource edge a different kind, and
     contention needs a rate. */
  if ((judgement.kind === 'resource') !== (judgement.capacityValue !== null)) {
    throw invalid({
      message:
        judgement.kind === 'resource'
          ? 'A resource edge has to say how much the upstream thing can serve.'
          : 'Only a resource edge has a capacity; nothing competes over the others.',
      code: 'edge.capacity_mismatch',
    });
  }
}

/**
 * §2.3 — a person decides, and the edge becomes part of the graph.
 *
 * THE REVISION ROW IS WRITTEN IN THE SAME TRANSACTION as the edge, and that is
 * the point of it being a transaction. §5 answers "is this result comparable
 * with that one" from the revision history; an edge that changed without a row
 * saying so would make that answer confidently wrong.
 */
export async function confirm(
  actor: Actor,
  edgeId: string,
  judgement: EdgeJudgement,
): Promise<dependencyEdgeRepo.DependencyEdge> {
  assertJudgement(judgement);

  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'graph.confirm');

      const before = await dependencyEdgeRepo.read(db, edgeId);
      if (!before) throw notFound({ message: 'That edge does not exist.', code: 'missing.edge' });

      const edge = await dependencyEdgeRepo.confirm(db, {
        id: edgeId,
        ...judgement,
        membershipId: actor.membershipId,
      });
      if (!edge) {
        /* The read found it live, so the only way the update matched nothing is
           that somebody else confirmed it in between. Theirs stands. */
        throw invalid({
          message: 'That edge has already been confirmed.',
          code: 'edge.already_confirmed',
        });
      }

      await edgeRevisionRepo.record(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        edgeId,
        change: 'confirmed',
        previousState: null,
        newState: stateOf(edge),
        reason: null,
        revisedBy: actor.membershipId,
      });

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'graph_edge_confirmed',
        detail: {
          edgeId,
          fromConceptId: edge.fromConceptId,
          toConceptId: edge.toConceptId,
          source: edge.source,
          edgeKind: edge.kind,
          leadTimeValue: edge.leadTimeValue,
          leadTimeUnit: edge.leadTimeUnit,
        },
      });

      log.info({ edgeId, kind: edge.kind }, 'Dependency edge confirmed');
      return edge;
    }),
  );
}

/**
 * §2.2 — "Stated by a person. Where no history exists, someone supplies the
 * lead time and the kind."
 *
 * §1's own example needs this and derivation cannot reach it: "Foreign keys
 * state that an invoice points at an order. They do not state that the order
 * waits on the supplier." No foreign key runs from an order to a supplier's
 * capacity, so no structural proposal ever will either.
 */
export async function state(
  actor: Actor,
  input: { fromConceptId: string; toConceptId: string } & EdgeJudgement,
): Promise<dependencyEdgeRepo.DependencyEdge> {
  assertJudgement(input);

  if (input.fromConceptId === input.toConceptId) {
    throw invalid({ message: 'A concept does not wait on itself.', code: 'edge.self' });
  }

  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'graph.confirm');

      /* Both ends must be concepts this organisation actually has. The foreign
         key would refuse otherwise, but as a constraint name rather than a
         sentence, and RLS would turn another tenant's concept into the same
         error as a typo — which is what it should look like from here. */
      const live = new Set((await conceptRepo.listLive(db)).map((concept) => concept.id));
      if (!live.has(input.fromConceptId) || !live.has(input.toConceptId)) {
        throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
      }

      const edge = await dependencyEdgeRepo.state(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        ...input,
        membershipId: actor.membershipId,
      });

      await edgeRevisionRepo.record(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        edgeId: edge.id,
        change: 'confirmed',
        previousState: null,
        newState: stateOf(edge),
        reason: null,
        revisedBy: actor.membershipId,
      });

      /*
       * PROPOSED AND CONFIRMED, BOTH, because both happened. §9 gives the two
       * events separately and a reviewer counting confirmations against
       * proposals should not find a live edge that was never proposed.
       */
      for (const event of ['graph_edge_proposed', 'graph_edge_confirmed'] as const) {
        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event,
          detail: {
            edgeId: edge.id,
            fromConceptId: edge.fromConceptId,
            toConceptId: edge.toConceptId,
            source: 'stated',
            edgeKind: edge.kind,
            leadTimeValue: edge.leadTimeValue,
            leadTimeUnit: edge.leadTimeUnit,
          },
        });
      }

      log.info({ edgeId: edge.id }, 'Dependency edge stated');
      return edge;
    }),
  );
}

/**
 * §2.3 — "Edges are revisable, with revisions recorded, because a lead time
 * that was true in March may not be in September."
 *
 * A REASON IS REQUIRED, and the schema says so too. Replacing somebody's
 * judgement without saying why leaves §5's comparison — "whether that was data
 * moving or the graph changing" — answerable but not explicable.
 */
export async function revise(
  actor: Actor,
  edgeId: string,
  input: EdgeJudgement & { reason: string },
): Promise<dependencyEdgeRepo.DependencyEdge> {
  assertJudgement(input);

  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'graph.confirm');

      const before = await dependencyEdgeRepo.read(db, edgeId);
      if (!before) throw notFound({ message: 'That edge does not exist.', code: 'missing.edge' });
      if (before.confirmedAt === null) {
        /* Nothing to revise: an unconfirmed proposal is changed by confirming
           it, which is the path that records who decided and when. */
        throw invalid({
          message: 'That edge is still a proposal. Confirm it instead.',
          code: 'edge.not_confirmed',
        });
      }

      const edge = await dependencyEdgeRepo.revise(db, {
        id: edgeId,
        kind: input.kind,
        leadTimeValue: input.leadTimeValue,
        leadTimeUnit: input.leadTimeUnit,
        bufferValue: input.bufferValue,
        bufferUnit: input.bufferUnit,
        degradedCost: input.degradedCost,
        capacityValue: input.capacityValue,
        capacityUnit: input.capacityUnit,
        membershipId: actor.membershipId,
      });
      if (!edge) throw notFound({ message: 'That edge does not exist.', code: 'missing.edge' });

      await edgeRevisionRepo.record(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        edgeId,
        change: 'revised',
        previousState: stateOf(before),
        newState: stateOf(edge),
        reason: input.reason,
        revisedBy: actor.membershipId,
      });

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'graph_edge_revised',
        detail: {
          edgeId,
          fromConceptId: edge.fromConceptId,
          toConceptId: edge.toConceptId,
          source: edge.source,
          edgeKind: edge.kind,
          leadTimeValue: edge.leadTimeValue,
          leadTimeUnit: edge.leadTimeUnit,
          version: edge.version,
        },
      });

      log.info({ edgeId, version: edge.version }, 'Dependency edge revised');
      return edge;
    }),
  );
}

/**
 * §7 — the third thing `graph.confirm` covers.
 *
 * A retired edge leaves the confirmed set, so §3 stops walking it. It does not
 * leave the table: the results that cited it still name it, and §5 compares two
 * runs by asking what changed in the graph.
 */
export async function retire(
  actor: Actor,
  edgeId: string,
  reason: string,
): Promise<dependencyEdgeRepo.DependencyEdge> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'graph.confirm');

      const before = await dependencyEdgeRepo.read(db, edgeId);
      if (!before) throw notFound({ message: 'That edge does not exist.', code: 'missing.edge' });

      const edge = await dependencyEdgeRepo.retire(db, edgeId);
      if (!edge) throw notFound({ message: 'That edge does not exist.', code: 'missing.edge' });

      await edgeRevisionRepo.record(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        edgeId,
        change: 'retired',
        previousState: stateOf(before),
        newState: stateOf(edge),
        reason,
        revisedBy: actor.membershipId,
      });

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'graph_edge_retired',
        detail: {
          edgeId,
          fromConceptId: edge.fromConceptId,
          toConceptId: edge.toConceptId,
          source: edge.source,
          version: edge.version,
        },
      });

      log.info({ edgeId }, 'Dependency edge retired');
      return edge;
    }),
  );
}

/** §5 — what this edge said before, so two results can be told apart. */
export async function history(actor: Actor, edgeId: string): Promise<edgeRevisionRepo.EdgeRevision[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction((db) => edgeRevisionRepo.forEdge(db, edgeId)),
  );
}

/** §11 — the edge list, and the constraint it comes with. */
export async function graph(actor: Actor): Promise<GraphView> {
  const edges = await list(actor);
  return {
    edges,
    disclosure: SIMULATION_DISCLOSURE,
    unconfirmed: edges.filter((edge) => edge.confirmedAt === null).length,
  };
}

export type Observed = {
  /** Edges a distribution was computed for, whatever its size. */
  measured: number;
  /** Proposals whose lead time was filled in from it. §2.2's "enough". */
  proposed: number;
  /** Edges with both ends in a Silo but no completed gap to measure. */
  withoutHistory: number;
};

/**
 * §2.2 — "Proposed from history. Where a Silo holds enough, observed lead times
 * are derived from what actually happened."
 *
 * ── ONLY WHERE BOTH ENDS ARE WATCHED ──────────────────────────────────────
 *
 * "It is only available where history exists." An edge is measurable when one
 * Silo holds transitions for both of its concepts: a gap between an event
 * recorded here and one recorded nowhere is not a gap that can be measured, and
 * inferring it from a single side is how a number appears that nothing
 * observed.
 *
 * ── IT PROPOSES AND IT DOES NOT DECIDE ────────────────────────────────────
 *
 * A confirmed edge gets its observation recorded and its lead time left exactly
 * as somebody confirmed it. That is not timidity: §2.3 says the decision holds
 * until a PERSON changes it, and an edge whose lead time moved on a schedule
 * would change what every future simulation concludes with no revision row to
 * say the two results are no longer comparable. What the observation buys on a
 * confirmed edge is the ability to say "you said three days; four hundred
 * instances say five" — which is a conversation, not a write.
 */
export async function observe(actor: Actor): Promise<Observed> {
  /*
   * READ, RELEASE, WALK, WRITE. The pairing step goes to somebody's production
   * systems once per edge, and holding a pooled client across those is how a
   * pool of ten runs out under four concurrent sweeps.
   */
  const plan = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'graph.propose');

      const edges = await dependencyEdgeRepo.list(db);
      const siloes = await siloRepo.list(db);

      const measurable: Array<{
        edge: dependencyEdgeRepo.DependencyEdge;
        siloId: string;
      }> = [];

      for (const silo of siloes) {
        const watched = new Set((await siloRepo.conceptsIn(db, silo.id)).map((one) => one.conceptId));
        for (const edge of edges) {
          if (watched.has(edge.fromConceptId) && watched.has(edge.toConceptId)) {
            measurable.push({ edge, siloId: silo.id });
          }
        }
      }

      /* The events themselves: times and references, never values. */
      const events = new Map<string, Array<{ entityRef: string; at: Date }>>();
      for (const { edge, siloId } of measurable) {
        for (const conceptId of [edge.fromConceptId, edge.toConceptId]) {
          const key = `${siloId}:${conceptId}`;
          if (events.has(key)) continue;
          events.set(
            key,
            await siloRepo.eventTimes(db, { siloId, conceptId, limit: OBSERVATION_EVENT_LIMIT }),
          );
        }
      }

      return { measurable, events };
    }),
  );

  let measured = 0;
  let proposed = 0;
  let withoutHistory = 0;

  for (const { edge, siloId } of plan.measurable) {
    /* `to` is what the dependent waits on, so `to` is the upstream side and its
       events are the ones a gap is measured FROM. */
    const upstream = plan.events.get(`${siloId}:${edge.toConceptId}`) ?? [];
    const downstream = plan.events.get(`${siloId}:${edge.fromConceptId}`) ?? [];

    if (upstream.length === 0 || downstream.length === 0) {
      withoutHistory += 1;
      continue;
    }

    const walked = await conceptService.walk(actor, {
      fromConceptId: edge.toConceptId,
      toConceptId: edge.fromConceptId,
      entityRefs: [...new Set(upstream.map((one) => one.entityRef))],
    });

    const pairs = new Map<string, string[]>();
    for (const path of walked.paths) {
      const held = pairs.get(path.from);
      if (held) held.push(path.to);
      else pairs.set(path.from, [path.to]);
    }

    const samples = elapsed({ upstream, downstream, pairs });

    const window = {
      from: upstream[0]!.at,
      to: upstream[upstream.length - 1]!.at,
    };
    const distribution = distributionOf(samples, window);

    if (!distribution) {
      /* Both sides have history and no upstream event was ever followed by a
         downstream one. That is an answer about the edge, not a failure. */
      withoutHistory += 1;
      continue;
    }

    measured += 1;

    /* §2.2's "enough" governs only whether a lead time is PROPOSED. The
       observation is recorded either way, because §4.3 wants the sample size
       visible rather than the thin ones hidden. */
    const lead =
      distribution.count >= MIN_SAMPLES_TO_PROPOSE && edge.confirmedAt === null
        ? asLeadTime(distribution.medianHours)
        : null;

    await runWithTenant(tenantOf(actor), () =>
      withTransaction(async (db) => {
        await edgeObservationRepo.record(db, {
          edgeId: edge.id,
          organisationId: actor.organisationId,
          sampleCount: distribution.count,
          meanHours: distribution.meanHours,
          medianHours: distribution.medianHours,
          p90Hours: distribution.p90Hours,
          minHours: distribution.minHours,
          maxHours: distribution.maxHours,
          stdDevHours: distribution.stdDevHours,
          quantiles: distribution.quantiles,
          observedFrom: distribution.observedFrom,
          observedTo: distribution.observedTo,
        });

        if (!lead) return;

        const updated = await dependencyEdgeRepo.proposeLeadTime(db, {
          id: edge.id,
          leadTimeValue: lead.value,
          leadTimeUnit: lead.unit,
        });
        if (!updated) return;

        proposed += 1;

        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'graph_edge_observed',
          detail: {
            edgeId: edge.id,
            fromConceptId: edge.fromConceptId,
            toConceptId: edge.toConceptId,
            source: 'history',
            sampleCount: distribution.count,
            leadTimeValue: lead.value,
            leadTimeUnit: lead.unit,
          },
        });
      }),
    );
  }

  log.info({ measured, proposed, withoutHistory }, 'Dependency edges observed');
  return { measured, proposed, withoutHistory };
}
