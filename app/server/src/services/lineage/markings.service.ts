// Markings along lineage (spec 58.6, 58.7): what a node carries, how an artefact came to
// carry a marking, and the downstream walk when a marking is added upstream.
//
// A node carries:
//   direct     the markings on the resource it references (a connection, a property, an
//              object type, ...), read from gov.resource_markings and iam.object_type_markings
//              by kind and ref_id, so every version of the resource carries them;
//   inherited  the markings stored on it in gov.artefact_markings when it was produced,
//              or added later by a propagation walk;
//   pending    a marking applied upstream whose walk has not reached it yet. Policy reads
//              it at read time, so there is no window of exposure.

import type { NodeKind } from '../../contracts/lineage/lineage.contract.ts';
import type { Queryable } from '../../infra/postgres.infra.ts';
import type { MarkingPropagation } from '../../models/gov/index.model.ts';
import {
  artefactMarkingRepo, lineageNodeRepo, markingPropagationRepo, type NodeMarking,
} from '../../repos/gov/index.repo.ts';

/** How far a propagation walk and a read-time check reach. Lineage is acyclic; this only bounds the work. */
export const PROPAGATION_DEPTH = 256;

export interface CarriedMarking {
  nodeId: string;
  markingId: string;
  origin: 'direct' | 'inherited' | 'pending';
  /** inherited: the nearest upstream node carrying it; pending: the source node. */
  fromNodeId: string | null;
}

/** Every marking these nodes carry now. */
export async function markingsOfNodes(db: Queryable, organisationId: string, ids: readonly string[]): Promise<CarriedMarking[]> {
  if (ids.length === 0) return [];
  const [carried, pending] = [await lineageNodeRepo.markings(db, organisationId, ids),
    await markingPropagationRepo.pendingFor(db, organisationId, ids, PROPAGATION_DEPTH)];
  return [
    ...carried.map((m) => ({ nodeId: m.nodeId, markingId: m.markingId, origin: m.origin, fromNodeId: m.inheritedFromNodeId })),
    ...pending.map((m) => ({ nodeId: m.nodeId, markingId: m.markingId, origin: 'pending' as const, fromNodeId: m.sourceNodeId })),
  ];
}

/** Marking ids by node, every id present. */
export async function markingSets(db: Queryable, organisationId: string, ids: readonly string[]): Promise<Map<string, string[]>> {
  const sets = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const m of await markingsOfNodes(db, organisationId, ids)) sets.get(m.nodeId)?.add(m.markingId);
  return new Map([...sets].map(([id, set]) => [id, [...set].sort()]));
}

/**
 * The markings an artefact carries now, for policy's mandatory gate on a decision about it
 * (spec 58.1): those of the latest version of its node. None when it has no lineage yet.
 */
export async function artefactMarkingsOf(db: Queryable, organisationId: string, kind: NodeKind, refId: string): Promise<string[]> {
  const node = await lineageNodeRepo.findLatest(db, organisationId, kind, refId);
  if (node === undefined) return [];
  return (await markingSets(db, organisationId, [node.id])).get(node.id) ?? [];
}

export interface MarkingPath {
  markingId: string;
  origin: 'direct' | 'inherited' | 'pending';
  /** Node ids from the artefact's input up to the node that carries the marking directly. */
  path: string[];
}

/**
 * Each marking a node carries and the path it came by (spec 59.4): an inherited marking is
 * followed upstream, input by input, to the node that carries it directly.
 */
export async function explainNode(db: Queryable, organisationId: string, nodeId: string): Promise<MarkingPath[]> {
  const own = await markingsOfNodes(db, organisationId, [nodeId]);
  const byMarking = new Map<string, CarriedMarking>();
  // direct before inherited before pending, so the strongest reason is the one explained.
  const rank = { direct: 0, inherited: 1, pending: 2 } as const;
  for (const m of own) {
    const known = byMarking.get(m.markingId);
    if (known === undefined || rank[m.origin] < rank[known.origin]) byMarking.set(m.markingId, m);
  }
  const result: MarkingPath[] = [];
  for (const m of [...byMarking.values()].sort((a, b) => a.markingId.localeCompare(b.markingId))) {
    if (m.origin !== 'inherited' || m.fromNodeId === null) {
      result.push({ markingId: m.markingId, origin: m.origin, path: m.fromNodeId === null ? [] : [m.fromNodeId] });
      continue;
    }
    const path: string[] = [];
    let at: string | null = m.fromNodeId;
    while (at !== null && path.length < PROPAGATION_DEPTH && !path.includes(at)) {
      path.push(at);
      const here: string = at;
      const there: NodeMarking[] = (await lineageNodeRepo.markings(db, organisationId, [here])).filter((x) => x.markingId === m.markingId);
      if (there.length === 0 || there.some((x) => x.origin === 'direct')) break;
      at = there[0]!.inheritedFromNodeId;
    }
    result.push({ markingId: m.markingId, origin: 'inherited', path });
  }
  return result;
}

export interface BatchOutcome {
  added: number;
  /** The walk found nothing left to mark. */
  done: boolean;
}

/**
 * One bounded batch of a propagation walk: marks the nearest nodes downstream of the source
 * that do not carry the marking, each inheriting from its nearest upstream node.
 */
export async function propagateBatch(db: Queryable, p: MarkingPropagation, limit: number): Promise<BatchOutcome> {
  const next = await markingPropagationRepo.nextUnmarked(db, p, PROPAGATION_DEPTH, limit);
  const added = await artefactMarkingRepo.addMissing(db, p.organisationId, next.map((n) => ({
    nodeId: n.nodeId, markingId: p.markingId, origin: 'inherited' as const, inheritedFromNodeId: n.parentId,
  })));
  return { added, done: next.length < limit };
}
