import { withTransaction, type Executor } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import { childLogger } from '../config/logger.config';
import { denial, invalid, notFound } from '../utils/error.util';
import { checkMarkings } from '../utils/markingCheck.util';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf } from './authorisation.service';
import * as simulations from './simulations.service';
import * as conceptService from './concept.service';
import * as conceptRepo from '../repos/concept.repo';
import * as authzRepo from '../repos/authz.repo';
import * as dependencyEdgeRepo from '../repos/dependencyEdge.repo';
import * as edgeObservationRepo from '../repos/edgeObservation.repo';
import * as scenarioRepo from '../repos/scenario.repo';
import * as runRepo from '../repos/simulationRun.repo';
import {
  clearanceHours,
  graphVersion,
  propagate,
  type Stop,
  type WalkableEdge,
} from '../engine/simulation/propagate.simulation';
import {
  estimate,
  INDEPENDENCE_CAVEAT,
  seedOf,
  streamFrom,
} from '../engine/simulation/montecarlo.simulation';
import { SIMULATION_RESULT_DAYS } from '../config/constants.config';
import type { Actor } from './scope.service';

const log = childLogger('simulation');

/**
 * Simulation §3 — deterministic propagation, the one that ships first.
 *
 * ── WHAT THIS FILE IS CAREFUL ABOUT ────────────────────────────────────────
 *
 * §3.3 — "Never that one thing caused another." Nothing here computes a
 * severity, a share or a blame. It reports which records a failure reaches
 * through which confirmed assertions, and §3.1 makes that concrete: "Output is
 * named records, not proportions."
 *
 * §2.3 — "An unconfirmed edge is reported, not ignored. A simulation whose path
 * crosses an unconfirmed edge stops there and says so. Silently routing around
 * it produces a shorter answer that looks complete." So every place the walk
 * could not continue is in the answer, with the reason, and §9 makes the rate
 * of it "the only measure of whether the graph is complete enough to trust".
 *
 * ── HOW A CONCEPT BECOMES RECORDS ──────────────────────────────────────────
 *
 * The graph is concept to concept; the answer is records. The bridge is the
 * ontology's own walk, which already knows how to get from these invoices to
 * their orders across whichever systems hold them. Reimplementing that here
 * would be a second resolver with its own idea of what matches.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

/*
 * §3.1's bound, where a caller states none. Four hops is deep enough to cross
 * an operation and shallow enough that a graph with a mistake in it cannot turn
 * one question into a sweep of every system. Not exported: a caller reaching
 * for these would be passing them back in as its own bound, which is the same
 * default written twice.
 */
const DEFAULT_MAX_HOPS = 4;
const DEFAULT_MAX_PER_HOP = 200;

/** An edge the walk refused, in the words the answer uses. */
export type Unreached = Stop & { because: string };

const BECAUSE: Record<Stop['reason'], string> = {
  unconfirmed:
    'Nobody has confirmed this edge yet, so the simulation stopped rather than assuming it.',
  no_clearance: 'You do not have clearance for part of this.',
  max_hops: 'The simulation reached its hop limit here and stopped rather than truncating.',
};

export interface RunOutcome {
  run: runRepo.SimulationRun;
  scenario: scenarioRepo.Scenario;
  /**
   * §3.2 — "A path through a soft edge is reported separately from one through
   * only hard edges. Those are different severities and merging them makes
   * everything look equally broken."
   *
   * TWO LISTS RATHER THAN ONE WITH A FIELD ON IT. A field is something a caller
   * can forget to read; two lists cannot be rendered as one table without
   * somebody deciding to merge them, which is the decision §3.2 is warning
   * about.
   */
  failed: runRepo.SimulationResult[];
  degraded: runRepo.SimulationResult[];
  /** §2.3 and §3.1 — everywhere the walk stopped, and why. */
  unreached: Unreached[];
  /**
   * §4.4 — "This is a known limitation of the method and it is stated in the
   * output rather than hidden." Present on a probabilistic run and absent on a
   * deterministic one, which makes no independence assumption to caveat.
   */
  caveats: string[];
}

/**
 * §5 — "A simulation is saved as a scenario: the stated failure, the graph
 * version, the mode, and the bounds."
 *
 * THERE IS NO UNSAVED SIMULATION, which reads like bureaucracy and is not: §5's
 * whole claim is that "a scenario asked again next month is a new result, and
 * the two are comparable because the scenario is the same". An ad-hoc run has
 * nothing to be compared with, and would quietly become the way everybody used
 * the feature.
 */
export async function save(
  actor: Actor,
  input: {
    name: string;
    failedConceptId: string;
    failedEntityRefs: readonly string[];
    maxHops?: number;
    maxPerHop?: number;
    /* §4 — a probabilistic scenario states its window and its iteration count;
       a deterministic one has neither. */
    mode?: scenarioRepo.SimulationMode;
    horizonHours?: number;
    iterations?: number;
  },
): Promise<scenarioRepo.Scenario> {
  const mode = input.mode ?? 'deterministic';

  /*
   * §4.1 — "A probabilistic simulation runs only over edges that have [a
   * distribution]." The window is what makes §4.3's probability a figure rather
   * than the number one: a run samples lead times and not the graph, so every
   * record reached is reached in every iteration, and "probability of being
   * affected" only means anything against a horizon to be affected WITHIN.
   */
  if (mode === 'probabilistic' && (input.horizonHours === undefined || input.iterations === undefined)) {
    throw invalid({
      message: 'A probabilistic scenario needs a horizon and an iteration count.',
      code: 'scenario.probabilistic_incomplete',
    });
  }
  if (mode === 'deterministic' && (input.horizonHours !== undefined || input.iterations !== undefined)) {
    throw invalid({
      message: 'A deterministic scenario returns everything it reaches; it has no horizon.',
      code: 'scenario.horizon_not_applicable',
    });
  }
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'simulation.run');

      const concept = await conceptRepo.read(db, input.failedConceptId);
      if (!concept || concept.retiredAt) {
        throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
      }

      /*
       * §7 — clearance is checked on the concept the failure is STATED at, not
       * only on the ones the walk reaches. Saving a scenario against a
       * compartment you cannot see would let somebody discover it exists by
       * whether the save succeeded.
       */
      const required = await authzRepo.markingsOnResource(db, 'concept', concept.id);
      if (!checkMarkings({ required }, { held: authority.clearances }).permitted) {
        throw notFound({ message: 'That concept does not exist.', code: 'missing.concept' });
      }

      const scenario = await scenarioRepo.create(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        ownerId: actor.membershipId,
        name: input.name,
        failedConceptId: input.failedConceptId,
        failedEntityRefs: input.failedEntityRefs,
        mode,
        maxHops: input.maxHops ?? DEFAULT_MAX_HOPS,
        maxPerHop: input.maxPerHop ?? DEFAULT_MAX_PER_HOP,
        horizonHours: input.horizonHours ?? null,
        iterations: input.iterations ?? null,
        graphVersion: graphVersion(await dependencyEdgeRepo.confirmed(db)),
      });

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'scenario_saved',
        detail: {
          scenarioId: scenario.id,
          failedConceptId: scenario.failedConceptId,
          mode: scenario.mode,
          graphVersion: scenario.graphVersion,
        },
      });

      return scenario;
    }),
  );
}

export async function mine(actor: Actor): Promise<scenarioRepo.Scenario[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction((db) => scenarioRepo.mine(db, actor.membershipId)),
  );
}

export async function remove(actor: Actor, scenarioId: string): Promise<{ removed: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const removed = await scenarioRepo.remove(db, scenarioId, actor.membershipId);
      if (!removed) throw notFound({ message: 'That scenario does not exist.', code: 'missing.scenario' });
      return { removed };
    }),
  );
}

/** Everything the walk needs, read once and then let go of. */
type Loaded = {
  scenario: scenarioRepo.Scenario;
  walkable: WalkableEdge[];
  proposals: dependencyEdgeRepo.DependencyEdge[];
  barred: Set<string>;
  /* §4.1 — which edges have a distribution, and how big a sample it came from. */
  observed: Map<string, edgeObservationRepo.EdgeObservation>;
};

/**
 * §3.1 — "Given a stated failure on an entity, walk the confirmed graph and
 * return every downstream entity reached, with the path and the accumulated
 * delay."
 */
export async function run(actor: Actor, scenarioId: string): Promise<RunOutcome> {
  /*
   * THE TRANSACTION IS LET GO BEFORE ANY SYSTEM IS TOUCHED, for the reason
   * `conceptQuery.ask` gives: each hop is a real request to somebody's
   * production system, and holding a pooled client across several of them is
   * how a pool of ten runs out under four concurrent questions.
   */
  const loaded = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db): Promise<Loaded> => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'simulation.run');

      const scenario = await scenarioRepo.readable(db, scenarioId, actor.membershipId);
      if (!scenario) throw notFound({ message: 'That scenario does not exist.', code: 'missing.scenario' });

      /*
       * §7 — "Marking checks apply. A simulation whose path crosses a concept
       * the runner lacks clearance for stops at that edge and reports it, in the
       * same way the compiler drops a concept rather than resolving and
       * filtering." Gathered up front so the walk can stop at the edge rather
       * than discovering it mid-query.
       */
      const barred = new Set<string>();
      for (const concept of await conceptRepo.listLive(db)) {
        const required = await authzRepo.markingsOnResource(db, 'concept', concept.id);
        if (!checkMarkings({ required }, { held: authority.clearances }).permitted) {
          barred.add(concept.id);
        }
      }

      if (barred.has(scenario.failedConceptId)) {
        throw denial({
          message: 'You do not have clearance for part of this.',
          code: 'denial.clearance',
          detail: { resource: `concept:${scenario.failedConceptId}` },
        });
      }

      const confirmed = await dependencyEdgeRepo.confirmed(db);

      return {
        scenario,
        /*
         * The schema guarantees a confirmed edge carries both, so the nulls
         * cannot occur — but the walk's types refuse them rather than defaulting
         * a missing lead time to nought, which is the one arithmetic mistake
         * that would shorten every path containing it.
         */
        walkable: confirmed.flatMap((edge) =>
          edge.kind === null || edge.leadTimeValue === null || edge.leadTimeUnit === null
            ? []
            : [
                {
                  id: edge.id,
                  fromConceptId: edge.fromConceptId,
                  toConceptId: edge.toConceptId,
                  kind: edge.kind,
                  leadTimeValue: edge.leadTimeValue,
                  leadTimeUnit: edge.leadTimeUnit,
                  bufferValue: edge.bufferValue,
                  bufferUnit: edge.bufferUnit,
                  degradedCost: edge.degradedCost,
                  capacityValue: edge.capacityValue,
                  capacityUnit: edge.capacityUnit,
                  source: edge.source,
                  version: edge.version,
                } satisfies WalkableEdge,
              ],
        ),
        proposals: await dependencyEdgeRepo.proposals(db),
        barred,
        observed: new Map((await edgeObservationRepo.all(db)).map((one) => [one.edgeId, one])),
      };
    }),
  );

  const { scenario, walkable, proposals, barred, observed } = loaded;
  const version = graphVersion(walkable);

  const plan = propagate({
    edges: walkable,
    failedConceptId: scenario.failedConceptId,
    maxHops: scenario.maxHops,
    unreachableConceptIds: barred,
    /* §4.3 — "always shown", so it travels on the path rather than being
       joined on by whoever renders the result. */
    sampleCounts: new Map([...observed].map(([id, one]) => [id, one.sampleCount])),
  });

  /*
   * §2.3 — the proposals the walk brushed past. A proposal has no kind and no
   * lead time, so it cannot be walked; reporting it is the whole of what can be
   * done with one, and not reporting it is what "a shorter answer that looks
   * complete" means.
   */
  const stoodOn = new Set([scenario.failedConceptId, ...plan.reached.map((one) => one.conceptId)]);
  const stops: Stop[] = [
    ...plan.stopped,
    ...proposals
      .filter((edge) => stoodOn.has(edge.toConceptId) && !stoodOn.has(edge.fromConceptId))
      .map((edge) => ({
        atConceptId: edge.toConceptId,
        edgeId: edge.id,
        nextConceptId: edge.fromConceptId,
        reason: 'unconfirmed' as const,
        hops: 0,
      })),
  ];

  /*
   * §6 — METERED HERE, AFTER THE CHEAP CHECKS AND BEFORE THE EXPENSIVE WORK.
   * A scenario that does not exist costs nothing; a walk that reaches somebody's
   * production systems costs one. Spending afterwards would make a run that
   * failed halfway free, which is the wrong way round: the cost was incurred.
   */
  await simulations.spend(actor);

  const standing = await simulations.standing(actor);
  const spentFromPeriod = standing.allowance?.periodStart ?? new Date();

  const started = await runWithTenant(tenantOf(actor), () =>
    withTransaction((db) =>
      runRepo.start(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        scenarioId: scenario.id,
        runBy: actor.membershipId,
        mode: scenario.mode,
        /* §4.2 — "Iteration count is bounded and stated." One, deterministically. */
        iterations: scenario.iterations ?? 1,
        graphVersion: version,
        spentFromPeriod,
      }),
    ),
  );

  /*
   * Which records sit at each concept the walk reached. Seeded with the stated
   * failure and filled in hop by hop, so each concept is resolved exactly once
   * however many paths pass through it.
   */
  const refsAt = new Map<string, string[]>([
    [scenario.failedConceptId, [...scenario.failedEntityRefs]],
  ]);

  const results: Array<{
    id: string;
    affectedConceptId: string;
    entityRef: string;
    path: Array<{ edgeId: string; fromConceptId: string; toConceptId: string }>;
    hops: number;
    delayHours: number;
    probability: number | null;
    edgeSources: readonly WalkableEdge['source'][];
    severity: 'failed' | 'degraded';
    degradedCosts: readonly string[];
    delayP10Hours: number | null;
    delayP90Hours: number | null;
    estimated: boolean;
    contendingRecords: number | null;
    clearanceHours: number | null;
  }> = [];

  let boundedAtHop: number | null = null;

  for (const arrival of plan.reached) {
    if (boundedAtHop !== null) break;

    const last = arrival.path[arrival.path.length - 1]!;
    const from = refsAt.get(last.toConceptId);

    /* The hop before this one reached no records, so neither does this one.
       An empty result is an answer rather than a failure. */
    if (!from || from.length === 0) continue;

    const walked = await conceptService.walk(actor, {
      fromConceptId: last.toConceptId,
      toConceptId: arrival.conceptId,
      entityRefs: from,
    });

    /*
     * ONLY THE PATHS THAT STARTED WHERE THIS HOP STARTED. A walk is asked about
     * a set of identifiers and answers with pairs; a pair whose `from` is not
     * one of them belongs to a different failure, and keeping it would widen
     * the affected set with records nothing reached.
     */
    const asked = new Set(from);
    const arrived = [
      ...new Set(walked.paths.filter((one) => asked.has(one.from)).map((one) => one.to)),
    ];

    /*
     * §3.1 — "Bounded per hop, as traversal already is. Fan-out that exceeds
     * the bound stops and names the hop rather than truncating." Recorded and
     * abandoned, not trimmed to fit: a list cut to two hundred looks like an
     * answer and is a fragment of one.
     */
    if (arrived.length > scenario.maxPerHop) {
      boundedAtHop = arrival.path.length;
      break;
    }

    refsAt.set(arrival.conceptId, arrived);

    /*
     * §6 — "Iterations multiply the arithmetic, though not the queries, since
     * the data is fetched once and sampled repeatedly." The walk above is the
     * queries; this is the arithmetic, and it runs per PATH rather than per
     * record, because every record at a concept shares the concept's path.
     */
    const estimated =
      scenario.mode === 'probabilistic'
        ? estimate({
            path: {
              quantiles: arrival.path.map((step) => {
                const one = observed.get(step.edgeId);
                /*
                 * §4.1 — an observation exists but is empty where nothing was
                 * measured, which is a different thing from a thin sample and
                 * must read as "no distribution" rather than as a degenerate
                 * one.
                 */
                return one && one.quantiles.length > 0 ? one.quantiles : null;
              }),
              statedDelayHours: arrival.delayHours,
            },
            iterations: scenario.iterations ?? 1,
            horizonHours: scenario.horizonHours ?? Infinity,
            /* §5 — seeded from the run, so re-running an unchanged scenario
               against unchanged data shows nothing moving rather than noise a
               reader cannot tell from a real difference. */
            next: streamFrom(seedOf(`${started.id}:${arrival.conceptId}`)),
          })
        : null;

    /*
     * §2.1 — "Several downstream things compete for the same upstream
     * capacity... a graph without them will find the wrong critical path."
     *
     * NO POSITIONS. Which of these records is served first is a fact about the
     * customer's scheduling that nothing in the graph carries, and sorting them
     * would publish a priority nobody stated. Every contender carries the same
     * two figures — how many there are, and how long they take to clear — which
     * is the number that makes the bottleneck visible.
     */
    const arrivedBy = arrival.path[arrival.path.length - 1]!;
    const contention =
      arrivedBy.kind === 'resource' && arrivedBy.capacityPerHour !== null
        ? {
            contendingRecords: arrived.length,
            clearanceHours: clearanceHours(arrived.length, arrivedBy.capacityPerHour),
          }
        : { contendingRecords: null, clearanceHours: null };

    for (const ref of arrived) {
      results.push({
        id: generateId(),
        affectedConceptId: arrival.conceptId,
        entityRef: ref,
        path: arrival.path,
        hops: arrival.path.length,
        delayHours: estimated ? estimated.medianHours : arrival.delayHours,
        /* §4.3 — a deterministic run makes no probability claim, and 1.0 would
           be exactly that claim. */
        probability: estimated ? estimated.probability : null,
        edgeSources: arrival.sources,
        /* §3.2 — "A path through a soft edge is reported separately from one
           through only hard edges. Those are different severities and merging
           them makes everything look equally broken." */
        severity: arrival.severity,
        degradedCosts: arrival.degradedCosts,
        delayP10Hours: estimated ? estimated.p10Hours : null,
        delayP90Hours: estimated ? estimated.p90Hours : null,
        /* §4.1 — per path. A deterministic run is every bit as exact as its
           edges, which were asserted, so it says so too. */
        estimated: estimated ? estimated.estimated : true,
        ...contention,
      });
    }
  }

  const expiresAt = new Date(Date.now() + SIMULATION_RESULT_DAYS * 24 * 60 * 60 * 1000);

  await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await runRepo.recordResults(db, {
        organisationId: actor.organisationId,
        runId: started.id,
        expiresAt,
        results,
      });
      await runRepo.complete(db, { id: started.id, boundedAtHop });

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'simulation_run',
        detail: {
          runId: started.id,
          scenarioId: scenario.id,
          mode: scenario.mode,
          graphVersion: version,
          affected: results.length,
        },
      });

      if (boundedAtHop !== null) {
        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'simulation_bounded',
          detail: { runId: started.id, hop: boundedAtHop, bound: scenario.maxPerHop },
        });
      }

      /*
       * §9 — "simulation_crossed_unconfirmed_edge is the one that matters. It
       * records every time a simulation stopped short, and the rate of it is
       * the only measure of whether the graph is complete enough to trust."
       *
       * ONE ROW PER EDGE, NOT ONE PER RUN. A rate needs a numerator, and a run
       * that stopped at nine edges is nine pieces of missing graph rather than
       * one incomplete run.
       */
      for (const stop of stops) {
        if (stop.reason !== 'unconfirmed') continue;
        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'simulation_crossed_unconfirmed_edge',
          detail: { runId: started.id, edgeId: stop.edgeId, atConceptId: stop.atConceptId },
        });
      }
    }),
  );

  log.info(
    { runId: started.id, affected: results.length, stopped: stops.length, boundedAtHop },
    'Simulation run',
  );

  const written = await results_(actor, started.id);

  return {
    run: { ...started, completedAt: new Date(), boundedAtHop },
    scenario,
    failed: written.filter((one) => one.severity === 'failed'),
    degraded: written.filter((one) => one.severity === 'degraded'),
    unreached: stops.map((stop) => ({ ...stop, because: BECAUSE[stop.reason] })),
    caveats: scenario.mode === 'probabilistic' ? [INDEPENDENCE_CAVEAT] : [],
  };
}

async function results_(actor: Actor, runId: string): Promise<runRepo.SimulationResult[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction((db) => runRepo.resultsFor(db, runId)),
  );
}

/**
 * A run, if this person made it and can still read its scenario.
 *
 * §7: "a scenario can be shared and a run's results cannot". Results name the
 * records the walk reached under the RUNNER's clearance, so a run is theirs
 * alone — not the owner's to read when a colleague runs a shared scenario,
 * and not a colleague's to read when the owner does. Somebody else's run, or
 * one whose scenario has since been deleted or unshared, is not there.
 */
async function ownRun(db: Executor, actor: Actor, runId: string): Promise<runRepo.SimulationRun> {
  const run = await runRepo.read(db, runId);
  const scenario =
    run && run.runBy === actor.membershipId
      ? await scenarioRepo.readable(db, run.scenarioId, actor.membershipId)
      : null;
  if (!run || !scenario) throw notFound({ message: 'That run does not exist.', code: 'missing.run' });
  return run;
}

/**
 * §5 — a run, read back.
 *
 * THE TWO GRAPH VERSIONS ARE BOTH RETURNED, and that is the point. "An edge
 * confirmed differently since means the two results are not comparable, and the
 * product says so rather than letting someone compare them."
 */
export async function read(
  actor: Actor,
  runId: string,
): Promise<{
  run: runRepo.SimulationRun;
  failed: runRepo.SimulationResult[];
  degraded: runRepo.SimulationResult[];
  /** True when the graph has moved since, so two runs must not be compared. */
  graphMoved: boolean;
}> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const run = await ownRun(db, actor, runId);

      const written = await runRepo.resultsFor(db, runId);

      return {
        run,
        failed: written.filter((one) => one.severity === 'failed'),
        degraded: written.filter((one) => one.severity === 'degraded'),
        graphMoved: graphVersion(await dependencyEdgeRepo.confirmed(db)) !== run.graphVersion,
      };
    }),
  );
}

export async function runs(actor: Actor, scenarioId: string): Promise<runRepo.SimulationRun[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const scenario = await scenarioRepo.readable(db, scenarioId, actor.membershipId);
      if (!scenario) throw notFound({ message: 'That scenario does not exist.', code: 'missing.scenario' });
      /* Only the runs this person made — see `ownRun`. */
      return (await runRepo.forScenario(db, scenarioId)).filter((run) => run.runBy === actor.membershipId);
    }),
  );
}

/**
 * §7 — "simulation.share — Share a scenario."
 *
 * A SHARE WIDENS WHO CAN ASK AND NEVER WHAT THE ANSWER HOLDS. §7's marking rule
 * is applied to the runner, so somebody with less clearance running a shared
 * scenario gets a shorter answer that says where it stopped — not the owner's
 * fuller one. That is why a scenario can be shared and a run's results cannot:
 * results name records, and handing those over would carry the owner's
 * clearance with them.
 */
export async function shareWith(
  actor: Actor,
  scenarioId: string,
  membershipId: string,
): Promise<{ shared: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'simulation.share');

      /* Only the owner gives it away. A share that could be re-shared by
         whoever received it is a grant nobody can withdraw. */
      const scenario = await scenarioRepo.read(db, scenarioId);
      if (!scenario || scenario.ownerId !== actor.membershipId) {
        throw notFound({ message: 'That scenario does not exist.', code: 'missing.scenario' });
      }

      if (membershipId === actor.membershipId) {
        throw invalid({ message: 'You already have this scenario.', code: 'scenario.share_self' });
      }

      const share = await scenarioRepo.share(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        scenarioId,
        membershipId,
        grantedBy: actor.membershipId,
      });

      /* Already shared. Saying so beats a second row nothing would ever read. */
      if (!share) return { shared: false };

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'scenario_shared',
        detail: { scenarioId, sharedWith: membershipId, mode: scenario.mode },
      });

      return { shared: true };
    }),
  );
}

/**
 * Who this scenario has been given to.
 *
 * THE OWNER ONLY, and it is not a courtesy: revoking a share you cannot see is
 * guesswork, and a share list somebody else could read would say which of their
 * colleagues had been handed a question about a compartment.
 */
export async function shares(actor: Actor, scenarioId: string): Promise<scenarioRepo.ScenarioShare[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const scenario = await scenarioRepo.read(db, scenarioId);
      if (!scenario || scenario.ownerId !== actor.membershipId) {
        throw notFound({ message: 'That scenario does not exist.', code: 'missing.scenario' });
      }
      return scenarioRepo.sharesOf(db, scenarioId);
    }),
  );
}

export async function revokeShare(
  actor: Actor,
  scenarioId: string,
  membershipId: string,
): Promise<{ revoked: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const scenario = await scenarioRepo.read(db, scenarioId);
      if (!scenario || scenario.ownerId !== actor.membershipId) {
        throw notFound({ message: 'That scenario does not exist.', code: 'missing.scenario' });
      }
      return { revoked: await scenarioRepo.revokeShare(db, { scenarioId, membershipId }) };
    }),
  );
}

export interface Comparison {
  scenarioId: string;
  /** §5 — records in the later run that were not in the earlier one. */
  entered: Array<{ conceptId: string; entityRef: string }>;
  left: Array<{ conceptId: string; entityRef: string }>;
  /** Reached by both, where the delay moved. */
  moved: Array<{ conceptId: string; entityRef: string; fromHours: number; toHours: number }>;
  /**
   * §5 — "whether that was data moving or the graph changing".
   *
   * `attributable` IS FALSE WHEN THE GRAPH MOVED, and the difference must not
   * then be read as the operation having changed. §5 is explicit that two runs
   * across different graph versions "are not comparable, and the product says
   * so rather than letting someone compare them" — so the comparison is still
   * produced, because refusing outright would leave somebody diffing two
   * screens by eye, and it arrives with the reason it cannot be trusted.
   */
  attributable: boolean;
  because: string;
}

const GRAPH_MOVED =
  'The graph changed between these two runs, so the difference cannot be read as the ' +
  'operation changing. Some of it is edges somebody confirmed, revised or retired.';

const DATA_MOVED =
  'Both runs walked the same graph, so the difference is the data underneath: records that ' +
  'entered or left the affected set, and delays that moved with them.';

/**
 * §5 — "Comparison of two runs shows what changed: which entities entered or
 * left the affected set, and whether that was data moving or the graph
 * changing."
 *
 * BOTH RUNS MUST BE OF THE SAME SCENARIO. §5's comparability claim rests on it:
 * "a scenario asked again next month is a new result, and the two are
 * comparable because the scenario is the same". Two runs of two different
 * stated failures have nothing in common to difference.
 */
export async function compare(actor: Actor, earlierId: string, laterId: string): Promise<Comparison> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const earlier = await ownRun(db, actor, earlierId);
      const later = await ownRun(db, actor, laterId);

      if (earlier.scenarioId !== later.scenarioId) {
        throw invalid({
          message: 'Two runs are only comparable when they asked the same question.',
          code: 'run.different_scenarios',
        });
      }

      const scenario = await scenarioRepo.readable(db, earlier.scenarioId, actor.membershipId);
      if (!scenario) throw notFound({ message: 'That scenario does not exist.', code: 'missing.scenario' });

      const key = (one: runRepo.SimulationResult) => `${one.affectedConceptId}:${one.entityRef}`;
      const before = new Map((await runRepo.resultsFor(db, earlierId)).map((one) => [key(one), one]));
      const after = new Map((await runRepo.resultsFor(db, laterId)).map((one) => [key(one), one]));

      const named = (one: runRepo.SimulationResult) => ({
        conceptId: one.affectedConceptId,
        entityRef: one.entityRef,
      });

      const entered = [...after.values()].filter((one) => !before.has(key(one))).map(named);
      const left = [...before.values()].filter((one) => !after.has(key(one))).map(named);

      const moved: Comparison['moved'] = [];
      for (const [id, one] of after) {
        const was = before.get(id);
        if (!was || was.delayHours === one.delayHours) continue;
        moved.push({ ...named(one), fromHours: was.delayHours, toHours: one.delayHours });
      }

      const attributable = earlier.graphVersion === later.graphVersion;

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'scenario_compared',
        detail: {
          scenarioId: earlier.scenarioId,
          runId: laterId,
          entered: entered.length,
          left: left.length,
          graphVersion: later.graphVersion,
        },
      });

      return {
        scenarioId: earlier.scenarioId,
        entered,
        left,
        moved,
        attributable,
        because: attributable ? DATA_MOVED : GRAPH_MOVED,
      };
    }),
  );
}
