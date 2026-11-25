// Deterministic propagation (spec 39.4, 39.6): from a stated failure on named objects, walk
// the confirmed dependency graph and name every downstream object reached, with the path of
// edges from the cause and the accumulated delay.
//
// The rules, each binding:
// - A hard edge propagates the failure (the object fails). A soft edge propagates its
//   stated delay (its lead time less its buffer) and the object continues, delayed.
// - A delayed failure adds its delay at the origin; each edge on a path takes off its
//   buffer, and where a buffer absorbs the delay the path ends: nothing downstream is late.
// - Paths through any soft edge are kept apart from hard-only paths: an object reached both
//   ways appears once in each.
// - An unconfirmed edge stops the walk at that edge and is reported, never routed around.
// - An object type the runner is not cleared for stops the walk at that edge, as compile
//   drops a type rather than resolving and filtering.
// - Fan-out past the per-hop bound stops the walk and names the hop; the hop is not kept in
//   part. Live edges past the last hop allowed are reported as a bound too.
// - Resource edges (contention) do not propagate yet (build step 8): they are counted.
// - Unavailable for a period (decision 2026-11-14): a hard edge carries the outage on, and the
//   dependant is out for the longer of the outage reaching it and its recovery lead time (the
//   edge's observed lead time where history holds it, else its stated one); a soft edge makes
//   it late by the outage less its buffer, and a buffer that absorbs it ends the path.
// It states reach, never cause.

import type { DependencyEdge } from '../../models/simulation/dependencyEdge.model.ts';
import { SECONDS } from './deps.service.ts';

export interface WalkEdge {
  id: string;
  from: string;
  to: string;
  via: string;
  kind: DependencyEdge['kind'];
  source: DependencyEdge['source'];
  status: DependencyEdge['status'];
  leadSeconds: number;
  bufferSeconds: number;
}

export function walkEdge(e: DependencyEdge): WalkEdge {
  const seconds = (d: unknown): number => {
    const v = d as { value: number; unit: keyof typeof SECONDS } | null;
    return v ? v.value * SECONDS[v.unit] : 0;
  };
  return {
    id: e.id, from: e.fromObjectTypeId, to: e.toObjectTypeId, via: e.viaLinkTypeId, kind: e.kind, source: e.source, status: e.status,
    leadSeconds: seconds(e.leadTime), bufferSeconds: seconds(e.buffer),
  };
}

/** Where a walk starts: a stated failure's objects, or a branch's effects (39.8). */
export interface Origin {
  objectTypeId: string;
  objectId: string;
  /** null: unavailable; otherwise delayed by this many seconds. */
  delaySeconds: number | null;
  /** Unavailable for a period: the outage, in seconds. */
  unavailableSeconds?: number | null | undefined;
}

export interface Reach {
  objectTypeId: string;
  objectId: string;
  /** The origin's own delay on this path (null: unavailable), which a probabilistic run samples from (39.5). */
  originDelaySeconds: number | null;
  /** null: the object fails outright; otherwise it is late by this many seconds. */
  delaySeconds: number | null;
  /** Unavailable for a period: how long it is out; null where it fails outright or is delayed. */
  unavailableSeconds: number | null;
  viaSoftEdge: boolean;
  path: WalkEdge[];
}

export interface Stop {
  reason: 'unconfirmed_edge' | 'bounded_hop' | 'uncleared_object_type';
  edgeId: string | null;
  objectTypeId: string | null;
  hop: number | null;
}

export interface Walk {
  reached: Reach[];
  stopped: Stop[];
  boundedAtHop: number | null;
  resourceEdgesSkipped: number;
}

/** For one edge, each upstream object's linked downstream objects: read through the executor. */
export type LinkReader = (edge: WalkEdge) => Promise<{ kind: 'links'; links: Map<string, string[]> } | { kind: 'bounded' }>;

export interface WalkInput {
  /** One per object; several kinds of failure may start one walk (a branch's effects). */
  origins: Origin[];
  bounds: { hops: number; fanOut: number };
  /** Live edges (proposed or confirmed) leaving these object types. */
  edgesFrom: (objectTypeIds: string[]) => Promise<WalkEdge[]>;
  cleared: (objectTypeId: string) => boolean;
  links: LinkReader;
  /** Probabilistic runs keep a path a buffer absorbs here: in another iteration it may not be. */
  keepAbsorbed?: boolean;
  /** An edge's recovery lead time for unavailable for a period: observed where history holds it. Default its stated lead time. */
  recoverySeconds?: (edge: WalkEdge) => number;
}

export async function walk(input: WalkInput): Promise<Walk> {
  const key = (r: { objectTypeId: string; objectId: string }) => `${r.objectTypeId}:${r.objectId}`;
  const origins = new Set(input.origins.map(key));
  const hard = new Map<string, Reach>();
  const soft = new Map<string, Reach>();
  const stopped: Stop[] = [];
  const stoppedAt = new Set<string>();
  const stop = (s: Stop) => {
    const k = `${s.reason}:${s.edgeId ?? s.objectTypeId ?? s.hop}`;
    if (!stoppedAt.has(k)) { stoppedAt.add(k); stopped.push(s); }
  };
  let resourceEdgesSkipped = 0;
  let boundedAtHop: number | null = null;
  const linkCache = new Map<string, Map<string, string[]>>();

  const recovery = input.recoverySeconds ?? ((e: WalkEdge) => e.leadSeconds);
  let frontier: Reach[] = input.origins.map((o) => ({
    objectTypeId: o.objectTypeId, objectId: o.objectId, delaySeconds: o.delaySeconds, originDelaySeconds: o.delaySeconds,
    unavailableSeconds: o.delaySeconds === null ? o.unavailableSeconds ?? null : null, viaSoftEdge: false, path: [],
  }));
  for (let hop = 1; hop <= input.bounds.hops && frontier.length > 0; hop += 1) {
    const edges = await input.edgesFrom([...new Set(frontier.map((r) => r.objectTypeId))]);
    const next: Reach[] = [];
    let bounded = false;
    for (const edge of edges) {
      if (edge.status !== 'confirmed') { stop({ reason: 'unconfirmed_edge', edgeId: edge.id, objectTypeId: null, hop: null }); continue; }
      if (edge.kind === 'resource') { resourceEdgesSkipped += 1; continue; }
      if (!input.cleared(edge.to)) { stop({ reason: 'uncleared_object_type', edgeId: null, objectTypeId: edge.to, hop: null }); continue; }
      const upstream = frontier.filter((r) => r.objectTypeId === edge.from);
      if (upstream.length === 0) continue;
      let links = linkCache.get(edge.id);
      if (links === undefined) {
        const read = await input.links(edge);
        if (read.kind === 'bounded') { bounded = true; break; }
        links = read.links;
        linkCache.set(edge.id, links);
      }
      for (const r of upstream) {
        for (const objectId of links.get(r.objectId) ?? []) {
          let delaySeconds: number | null;
          let unavailableSeconds: number | null = null;
          if (r.delaySeconds === null && r.unavailableSeconds !== null) {
            // Out for a period: hard carries the outage on, soft makes it late by the outage less the buffer.
            if (edge.kind === 'hard') {
              delaySeconds = null;
              unavailableSeconds = Math.max(r.unavailableSeconds, recovery(edge));
            } else {
              delaySeconds = r.unavailableSeconds - edge.bufferSeconds;
              if (delaySeconds <= 0 && input.keepAbsorbed !== true) continue;
            }
          } else if (r.delaySeconds === null) {
            delaySeconds = edge.kind === 'hard' ? null : Math.max(edge.leadSeconds - edge.bufferSeconds, 0);
          } else {
            delaySeconds = r.delaySeconds - edge.bufferSeconds;
            if (delaySeconds <= 0 && input.keepAbsorbed !== true) continue; // the buffer absorbs it: nothing downstream is late on this path
          }
          const viaSoftEdge = r.viaSoftEdge || edge.kind === 'soft';
          const reach: Reach = {
            objectTypeId: edge.to, objectId, delaySeconds, unavailableSeconds, originDelaySeconds: r.originDelaySeconds, viaSoftEdge, path: [...r.path, edge],
          };
          const k = key(reach);
          if (origins.has(k)) continue;
          const seen = viaSoftEdge ? soft : hard;
          if (!seen.has(k)) { seen.set(k, reach); next.push(reach); }
        }
      }
    }
    if (bounded || next.length > input.bounds.fanOut) {
      // Never kept in part: the hop's objects are taken back out, and the hop is named.
      for (const r of next) (r.viaSoftEdge ? soft : hard).delete(key(r));
      stop({ reason: 'bounded_hop', edgeId: null, objectTypeId: null, hop });
      boundedAtHop = hop;
      frontier = [];
      break;
    }
    frontier = next;
    if (hop === input.bounds.hops && frontier.length > 0) {
      const beyond = await input.edgesFrom([...new Set(frontier.map((r) => r.objectTypeId))]);
      if (beyond.length > 0) {
        stop({ reason: 'bounded_hop', edgeId: null, objectTypeId: null, hop: hop + 1 });
        boundedAtHop = hop + 1;
      }
    }
  }
  return { reached: [...hard.values(), ...soft.values()], stopped, boundedAtHop, resourceEdgesSkipped };
}
