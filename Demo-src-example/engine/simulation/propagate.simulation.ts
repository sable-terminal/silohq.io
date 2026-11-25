import { createHash } from 'node:crypto';

/**
 * Simulation §3 — deterministic propagation.
 *
 * ── §3.3: WHAT THIS NEVER SAYS ─────────────────────────────────────────────
 *
 * "Never that one thing caused another. The graph is a set of confirmed
 * assertions about how things depend on each other. Walking it says the failure
 * reaches these records through these edges. That is a structural statement,
 * not a causal one, and it survives the confounder question that a causal claim
 * does not."
 *
 * That sentence is why this file has no severity, no proportion and no score.
 * A number between nought and one attached to a downstream record is a claim
 * about how much of the failure got there, and nothing in a confirmed edge
 * supports one. §3.1 — "Output is named records, not proportions."
 *
 * ── WHICH WAY THE EDGES POINT, BECAUSE GETTING IT BACKWARDS IS SILENT ─────
 *
 * §2.2 takes an edge's direction from the ontology relationship, and a
 * relationship runs from the object holding the foreign key to the one it
 * points at: `invoices.order_id → orders.id`. A foreign key says precisely that
 * the referencing row cannot exist without the referenced one, so the HOLDER is
 * the dependent.
 *
 * So `from` waits on `to`. A failure is stated at a concept, and propagation
 * searches for edges whose `to` is that concept — the things that wait on it —
 * and arrives at their `from`. Reading it the other way produces a walk that
 * runs up the dependency chain instead of down it, returns a plausible-looking
 * set of records, and is wrong about every one of them.
 *
 * ── NOTHING IN HERE TOUCHES A DATABASE OR A SOURCE SYSTEM ─────────────────
 *
 * This plans the concept-level walk. Turning a reached concept into named
 * records is a query against somebody's production systems, which belongs in a
 * service. The separation is what makes the walk testable against a graph
 * written by hand.
 */

export type EdgeKind = 'hard' | 'soft' | 'resource';
export type EdgeSource = 'structure' | 'history' | 'stated';
export type TimeUnit = 'hours' | 'days' | 'weeks';

/** The part of an edge a walk needs. */
export interface WalkableEdge {
  id: string;
  /** The dependent: the thing that waits. */
  fromConceptId: string;
  /** The thing it waits on. */
  toConceptId: string;
  kind: EdgeKind;
  leadTimeValue: number;
  leadTimeUnit: TimeUnit;
  bufferValue: number | null;
  bufferUnit: TimeUnit | null;
  source: EdgeSource;
  version: number;
  /* §3.2 — what proceeding degraded costs. Present on a soft edge and on no
     other kind, which the schema enforces. */
  degradedCost: string | null;
  /* §2.1 — how much the upstream thing serves per unit of time. Present on a
     resource edge and on no other kind. */
  capacityValue: number | null;
  capacityUnit: TimeUnit | null;
}

const HOURS: Record<TimeUnit, number> = { hours: 1, days: 24, weeks: 168 };

/**
 * §2.1 — "a value and a unit", reduced to one unit so paths can be added up.
 *
 * HOURS RATHER THAN DAYS, because a lead time stated in hours is a real thing
 * — a same-day handover between two systems — and rounding it to a day makes
 * every path containing it wrong by up to a full day in the direction that
 * looks better.
 */
export const hoursOf = (value: number, unit: TimeUnit): number => value * HOURS[unit];

/**
 * How long before a failure at the far end lands here.
 *
 * THE BUFFER ADDS. §2.1 calls it how long the downstream thing runs on hand
 * before the failure reaches it, so it is a grace period on top of the time the
 * effect takes to travel. Subtracting it — reading it as slack already spent —
 * would report every affected record as failing sooner than it does, which is
 * the direction that causes somebody to act on a date that has not arrived.
 */
export function delayOf(edge: WalkableEdge): number {
  const lead = hoursOf(edge.leadTimeValue, edge.leadTimeUnit);
  const buffer =
    edge.bufferValue === null || edge.bufferUnit === null
      ? 0
      : hoursOf(edge.bufferValue, edge.bufferUnit);
  return lead + buffer;
}

/**
 * §5 — "Graph version is recorded on every result."
 *
 * OVER THE CONFIRMED SET ONLY, and over each edge's own version. A proposal
 * changes nothing a walk can see, so counting it would make two identical runs
 * look incomparable every time derivation ran. An edge entering or leaving the
 * confirmed set changes the digest by being present or absent; an edge revised
 * in place changes it through §2.3's version bump.
 */
export function graphVersion(edges: readonly { id: string; version: number }[]): string {
  const hash = createHash('sha256');
  for (const line of edges.map((edge) => `${edge.id}:${edge.version}`).sort()) {
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Why a path stopped short of somewhere it could have gone.
 *
 * §2.3 — "An unconfirmed edge is reported, not ignored. A simulation whose path
 * crosses an unconfirmed edge stops there and says so. Silently routing around
 * it produces a shorter answer that looks complete."
 *
 * NEITHER `soft` NOR `resource` IS ONE OF THESE ANY MORE. Step three stopped at
 * both because it had no way to say what either meant; §3.2 gave soft its
 * answer and §2.1's capacity gives resource one.
 */
export type StopReason = 'unconfirmed' | 'no_clearance' | 'max_hops';

/**
 * §3.2 — "Those are different severities and merging them makes everything look
 * equally broken."
 *
 * `failed` IS A PATH THROUGH ONLY HARD EDGES: the downstream thing does not
 * happen. `degraded` is a path with at least one soft edge on it: somewhere
 * along the chain something carried on at a stated cost, and everything after
 * that point inherits the fact that it carried on. One soft edge anywhere makes
 * the whole path degraded, because the failure stopped being a failure there
 * and nothing further along can turn it back into one.
 */
export type Severity = 'failed' | 'degraded';

export interface Stop {
  /** The concept the walk was standing on. */
  atConceptId: string;
  /** Where it would have gone. Absent when the bound, not an edge, stopped it. */
  edgeId: string | null;
  nextConceptId: string | null;
  reason: StopReason;
  hops: number;
}

export interface Reached {
  conceptId: string;
  /**
   * The chain of edges from the stated failure to here, in order.
   *
   * THE KIND AND CAPACITY TRAVEL WITH THE STEP because contention is counted
   * against records, which this walk does not have. §2.1's figure — how long
   * the queue behind a resource takes to clear — needs the capacity at the
   * moment the records are known, which is after the walk.
   */
  path: Array<{
    edgeId: string;
    fromConceptId: string;
    toConceptId: string;
    kind: EdgeKind;
    capacityPerHour: number | null;
    /**
     * §4.3 — "Sample size for every edge on the path, always shown. A
     * probability derived from an edge with eleven observations is presented
     * with that number next to it."
     *
     * ON THE STEP, NOT LOOKED UP LATER. A result that named its edges and left
     * the counts to be joined on would be rendered without them by the first
     * screen that forgot, and "always shown" is the requirement. Null where
     * nothing has been measured, which reads differently from a sample of
     * nought and should.
     */
    sampleCount: number | null;
  }>;
  delayHours: number;
  /** §2.2 — what every edge on the path rested on. */
  sources: EdgeSource[];
  severity: Severity;
  /** §3.2 — the stated cost of every soft edge on the path, in order. */
  degradedCosts: string[];
}

export interface Plan {
  reached: Reached[];
  stopped: Stop[];
}

/**
 * Walk the confirmed graph from a stated failure.
 *
 * ── BREADTH FIRST, AND A CONCEPT IS EXPANDED ONCE ─────────────────────────
 *
 * Cycles are real: two plants that supply each other's components are a genuine
 * mutual dependency, and a graph that forbade them would be refusing to
 * describe the operation. So the walk copes rather than the model forbidding
 * it, and a concept already reached is not expanded again.
 *
 * THE FIRST ARRIVAL WINS, MEASURED IN HOPS. A second path to the same concept
 * is not explored. The alternative — keeping whichever path accumulates the
 * least delay — sounds better and is worse: it reports each record at its
 * earliest possible impact, which is the optimistic end of a range the product
 * has no basis to narrow, and §3.1 asks for the path rather than the best path.
 *
 * ── `unconfirmed` NEVER APPEARS HERE, DELIBERATELY ────────────────────────
 *
 * The caller passes confirmed edges. An unconfirmed one is not filtered out
 * inside this walk because a proposal has no kind and no lead time, so it
 * cannot be walked at all — but §2.3 still requires it be REPORTED, which needs
 * the proposals the caller holds and this function does not. `unconfirmed`
 * stops are the caller's to add, and the reason lives in this type so it cannot
 * be forgotten.
 */
export function propagate(input: {
  edges: readonly WalkableEdge[];
  failedConceptId: string;
  maxHops: number;
  /** §7 — concepts the runner holds no clearance for. */
  unreachableConceptIds?: ReadonlySet<string>;
  /** §4.3 — how many instances each edge's lead time was measured over. */
  sampleCounts?: ReadonlyMap<string, number>;
}): Plan {
  const { edges, failedConceptId, maxHops } = input;
  const barred = input.unreachableConceptIds ?? new Set<string>();

  /* Indexed by what an edge waits on, because that is what a failure is stated
     at and what every hop searches by. */
  const dependents = new Map<string, WalkableEdge[]>();
  for (const edge of edges) {
    const at = dependents.get(edge.toConceptId);
    if (at) at.push(edge);
    else dependents.set(edge.toConceptId, [edge]);
  }

  const reached: Reached[] = [];
  const stopped: Stop[] = [];

  /*
   * KEYED BY CONCEPT AND SEVERITY, NOT BY CONCEPT ALONE.
   *
   * §3.2 makes these two different answers about the same thing, and a concept
   * can be reachable both ways: a short soft path and a longer hard one. Keyed
   * by concept alone, breadth-first order would report whichever was shorter in
   * hops and hide the other — and when that is the soft one, a record that does
   * not happen at all is reported as continuing at a cost. That is the
   * understating direction, which is the one nobody catches.
   *
   * At most twice per concept, so the bound is unchanged in kind.
   */
  const seen = new Set<string>([`${failedConceptId}:failed`, `${failedConceptId}:degraded`]);

  let frontier: Reached[] = [
    { conceptId: failedConceptId, path: [], delayHours: 0, sources: [], severity: 'failed', degradedCosts: [] },
  ];

  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop += 1) {
    const next: Reached[] = [];

    for (const standing of frontier) {
      for (const edge of dependents.get(standing.conceptId) ?? []) {
        if (barred.has(edge.fromConceptId)) {
          /* §7 — "stops at that edge and reports it, in the same way the
             compiler drops a concept rather than resolving and filtering". */
          stopped.push({
            atConceptId: standing.conceptId,
            edgeId: edge.id,
            nextConceptId: edge.fromConceptId,
            reason: 'no_clearance',
            hops: hop,
          });
          continue;
        }

        /*
         * §3.2 — one soft edge anywhere makes the whole path degraded. The
         * failure stopped being a failure at that edge, and nothing further
         * along the chain turns it back into one.
         *
         * A RESOURCE EDGE IS A FAILURE, NOT A DEGRADATION. §2.1 — "several
         * downstream things compete for the same upstream capacity" — and a
         * stated failure takes that capacity to nothing, so nothing is served.
         * What contention adds is not a gentler severity: it is how long the
         * queue behind the resource takes to clear, which is the figure that
         * makes the bottleneck visible and is computed against records later.
         */
        const severity: Severity = standing.severity === 'degraded' || edge.kind === 'soft'
          ? 'degraded'
          : 'failed';

        const key = `${edge.fromConceptId}:${severity}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const arrival: Reached = {
          conceptId: edge.fromConceptId,
          path: [
            ...standing.path,
            {
              edgeId: edge.id,
              fromConceptId: edge.fromConceptId,
              toConceptId: edge.toConceptId,
              kind: edge.kind,
              capacityPerHour:
                edge.capacityValue === null || edge.capacityUnit === null
                  ? null
                  : edge.capacityValue / hoursOf(1, edge.capacityUnit),
              sampleCount: input.sampleCounts?.get(edge.id) ?? null,
            },
          ],
          delayHours: standing.delayHours + delayOf(edge),
          sources: [...standing.sources, edge.source],
          severity,
          degradedCosts:
            edge.kind === 'soft' && edge.degradedCost !== null
              ? [...standing.degradedCosts, edge.degradedCost]
              : [...standing.degradedCosts],
        };

        reached.push(arrival);
        next.push(arrival);
      }
    }

    /*
     * §3.1 — "Bounded per hop... Fan-out that exceeds the bound stops and names
     * the hop rather than truncating." The last hop's frontier is where the
     * walk would have continued, so anything still there when the bound is
     * reached is named rather than dropped in silence.
     */
    if (hop === maxHops) {
      for (const standing of next) {
        if ((dependents.get(standing.conceptId) ?? []).length > 0) {
          stopped.push({
            atConceptId: standing.conceptId,
            edgeId: null,
            nextConceptId: null,
            reason: 'max_hops',
            hops: hop,
          });
        }
      }
    }

    frontier = next;
  }

  /*
   * §3.2 — A FAILURE OUTRANKS A DEGRADATION AT THE SAME CONCEPT. Both arrivals
   * were explored, because either could have been the shorter one; reporting
   * both would put one record in the answer twice under two severities, and
   * whoever reads it would quote the gentler. The failure is the true statement
   * about that concept, so it is the one kept.
   */
  const failed = new Set(
    reached.filter((one) => one.severity === 'failed').map((one) => one.conceptId),
  );

  return {
    reached: reached.filter((one) => one.severity === 'failed' || !failed.has(one.conceptId)),
    stopped,
  };
}

/**
 * §2.1 — how long the queue behind a contended resource takes to clear.
 *
 * ── NO POSITIONS, DELIBERATELY ────────────────────────────────────────────
 *
 * Which of four hundred contending records is served first is a fact about the
 * customer's scheduling that nothing in this graph carries. A walk that sorted
 * them would be publishing a priority nobody stated, reporting the first record
 * as fine and the last as ruined on the strength of an arbitrary order.
 *
 * So every record contending for a resource carries the same two figures: how
 * many of them there are, and how long they take to clear between them. A
 * resource that serves ten a week with four hundred waiting is the critical
 * path §2.1 says a graph without resource edges would miss, and this is the
 * number that says so.
 */
export function clearanceHours(records: number, capacityPerHour: number): number {
  return records / capacityPerHour;
}
