// Observed lead times (spec 39.3, 67.1, 67.4): the elapsed time between an upstream and a
// downstream transition, from the history Siloes Capture holds, with its distribution and
// sample size. Links between the objects come from current data through the executor; the
// transitions from the history resolver. A lead time from fewer observations than the
// minimum is never proposed: the answer says how many there are and how many are needed.
//
// Pairing: for each transition of the upstream property on an object, the first transition
// of the downstream property on each object it links to, at or after it and before the
// upstream object's next transition. Elapsed seconds only: no value leaves this module.

import type { Duration, EdgeView } from '../../contracts/simulation/graph.contract.ts';
import { readHistory } from '../../contracts/siloes/siloes.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { dependencyEdgeRepo } from '../../repos/simulation/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { actor, demand, readManifest, recordEvent, visibility, type Context, type SimulationDeps } from './deps.service.ts';
import { edgeView } from './graph.service.ts';
import { walkEdge } from './propagation.service.ts';
import { linkReader } from './scenarios.service.ts';

/** Observations a lead time needs before it is proposed. */
export const MIN_LEAD_OBSERVATIONS = 30;
/** Observations kept on the edge for probabilistic runs (39.5): every one, or this many evenly spaced order statistics. */
export const MAX_KEPT_SAMPLES = 2_000;

/** The observations themselves, sorted, thinned to evenly spaced order statistics past the cap: the empirical distribution, no shape assumed. */
export function keptSamples(seconds: readonly number[]): number[] {
  const s = [...seconds].sort((a, b) => a - b);
  if (s.length <= MAX_KEPT_SAMPLES) return s;
  return Array.from({ length: MAX_KEPT_SAMPLES }, (_, i) => s[Math.round((i * (s.length - 1)) / (MAX_KEPT_SAMPLES - 1))]!);
}
/** Transitions read per side in one observation; more is refused as bounded, never judged in part. */
export const LEAD_HISTORY_LIMIT = 10_000;

export interface Moment { objectRef: string; observedAt: string }

export function pairLeadTimes(upstream: readonly Moment[], downstream: readonly Moment[], links: ReadonlyMap<string, readonly string[]>): number[] {
  const sorted = (list: readonly Moment[]) => {
    const by = new Map<string, number[]>();
    for (const m of list) by.set(m.objectRef, [...(by.get(m.objectRef) ?? []), Date.parse(m.observedAt)]);
    for (const times of by.values()) times.sort((a, b) => a - b);
    return by;
  };
  const up = sorted(upstream);
  const down = sorted(downstream);
  const out: number[] = [];
  for (const [a, times] of up) {
    times.forEach((at, i) => {
      const until = times[i + 1] ?? Number.POSITIVE_INFINITY;
      for (const b of links.get(a) ?? []) {
        const next = (down.get(b) ?? []).find((t) => t >= at && t < until);
        if (next !== undefined) out.push((next - at) / 1000);
      }
    });
  }
  return out;
}

const nearestRank = (sorted: readonly number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;

export function distributionOf(seconds: readonly number[]) {
  const s = [...seconds].sort((a, b) => a - b);
  return { observations: s.length, min: s[0]!, p10: nearestRank(s, 0.1), p50: nearestRank(s, 0.5), p90: nearestRank(s, 0.9), max: s.at(-1)! };
}

/** Seconds as a lead time in the largest unit that keeps it at least one. */
export function durationOf(seconds: number): Duration {
  const [unit, size] = seconds >= 86_400 ? ['days', 86_400] as const : seconds >= 3_600 ? ['hours', 3_600] as const : ['minutes', 60] as const;
  return { value: Math.round((seconds / size) * 10) / 10, unit };
}

export async function observeLeadTimes(deps: SimulationDeps, ctx: Context, edgeId: string, input: {
  upstreamProperty: string; downstreamProperty: string; version: number;
}): Promise<{ state: 'observed' | 'building' | 'unavailable'; have: number; need: number; distribution: ReturnType<typeof distributionOf> | null; edge: EdgeView }> {
  const who = actor(ctx);
  await demand(deps, ctx, 'graph.propose');
  const control = deps.databases.pool('control');
  const edge = await inTransaction(control, who.request, (db) => dependencyEdgeRepo.findById(db, edgeId), { readOnly: true });
  if (edge === undefined) throw new AppError('not_found', 'no such edge', { code: 'simulation.edge_not_found' });
  if (edge.status !== 'proposed') {
    throw new AppError('conflict', 'an observed lead time is proposed on an edge not yet confirmed; revise a confirmed one', { code: 'simulation.edge_status' });
  }
  if (edge.version !== input.version) throw new AppError('conflict', 'the edge changed since you read it', { code: 'simulation.edge_stale' });
  const manifest = await readManifest(deps, ctx);
  const seen = await visibility(deps, ctx, { objectTypes: [edge.fromObjectTypeId, edge.toObjectTypeId], linkTypes: [edge.viaLinkTypeId] });
  if (!seen.typeVisible(edge.fromObjectTypeId) || !seen.typeVisible(edge.toObjectTypeId) || !seen.linkVisible(edge.viaLinkTypeId)) {
    throw new AppError('not_found', 'no such edge', { code: 'simulation.edge_not_found' });
  }
  const call = { request: ctx.request, correlationId: ctx.correlationId };
  const history = (objectTypeId: string, property: string) => deps.services.call(readHistory, {
    body: { objectTypeId, property, minimumTransitions: 0, limit: LEAD_HISTORY_LIMIT },
  }, call);
  const [up, down] = await Promise.all([history(edge.fromObjectTypeId, input.upstreamProperty), history(edge.toObjectTypeId, input.downstreamProperty)]);
  const none = { have: 0, need: MIN_LEAD_OBSERVATIONS, distribution: null, edge: edgeView(edge) };
  if (up.state !== 'silo' || down.state !== 'silo') return { state: 'unavailable', ...none };
  if (up.have > LEAD_HISTORY_LIMIT || down.have > LEAD_HISTORY_LIMIT) {
    throw new AppError('bounds', 'more history than one observation reads: narrow the edge', { code: 'simulation.history_bounded' });
  }
  const links = await linkReader(deps, ctx, manifest)(walkEdge(edge));
  if (links.kind === 'bounded') throw new AppError('bounds', 'more linked objects than one observation reads', { code: 'simulation.links_bounded' });
  const elapsed = pairLeadTimes(up.transitions, down.transitions, links.links);
  if (elapsed.length < MIN_LEAD_OBSERVATIONS) return { state: 'building', ...none, have: elapsed.length };

  const distribution = distributionOf(elapsed);
  const updated = await inTransaction(control, who.request, async (db) => {
    const row = await dependencyEdgeRepo.updateAtVersion(db, edgeId, input.version, {
      source: 'history', leadTime: durationOf(distribution.p50),
      evidenceRef: {
        ...(edge.evidenceRef as Record<string, unknown> | null ?? {}), history: {
          ...distribution, unit: 'seconds', samples: keptSamples(elapsed), upstream: { objectTypeId: edge.fromObjectTypeId, property: input.upstreamProperty, siloId: up.siloId },
          downstream: { objectTypeId: edge.toObjectTypeId, property: input.downstreamProperty, siloId: down.siloId }, observedAt: new Date().toISOString(),
        },
      } as never,
    });
    if (row === undefined) throw new AppError('conflict', 'the edge changed since you read it', { code: 'simulation.edge_stale' });
    await recordEvent(db, who, ctx.correlationId, {
      event: 'graph_edge_proposed', resource: { type: 'dependency_edge', id: edgeId }, detail: { source: 'history', observations: distribution.observations },
    });
    return row;
  });
  return { state: 'observed', have: elapsed.length, need: MIN_LEAD_OBSERVATIONS, distribution, edge: edgeView(updated) };
}
