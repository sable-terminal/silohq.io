// The dependency graph (spec 39.2, 39.3): proposals from structure or a person, and the
// confirmation loop. Proposals never change the graph version; every confirmation,
// revision or retirement increments it first (simulation.graph_state, locked by the
// update), then records the edge's revision with the version it produced.

import type { Duration, EdgeView } from '../../contracts/simulation/graph.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { DependencyEdge } from '../../models/simulation/dependencyEdge.model.ts';
import { dependencyEdgeRepo, edgeRevisionRepo, graphStateRepo } from '../../repos/simulation/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { actor, demand, member, readManifest, recordEvent, visibility, type Context, type SimulationDeps } from './deps.service.ts';

export function edgeView(e: DependencyEdge): EdgeView {
  return {
    id: e.id, fromObjectTypeId: e.fromObjectTypeId, toObjectTypeId: e.toObjectTypeId, viaLinkTypeId: e.viaLinkTypeId, kind: e.kind,
    leadTime: e.leadTime as Duration | null, buffer: e.buffer as Duration | null, source: e.source, status: e.status,
    confirmedBy: e.confirmedBy, confirmedAt: e.confirmedAt, version: e.version,
    capacity: e.consumption === null || e.capacityPropertyId === null || e.demandPropertyId === null || e.capacityPeriod === null ? null
      : { consumption: Number(e.consumption), capacityPropertyId: e.capacityPropertyId, demandPropertyId: e.demandPropertyId,
        period: e.capacityPeriod as 'day' | 'week' | 'month' },
  };
}

type Capacity = { consumption: number; capacityPropertyId: string; demandPropertyId: string; period: 'day' | 'week' | 'month' };

/** A resource edge's capacity names a numeric property of the resource and one of the dependant (D86). */
async function checkCapacity(deps: SimulationDeps, ctx: Context, edge: DependencyEdge, capacity: Capacity): Promise<void> {
  const manifest = await readManifest(deps, ctx);
  const numeric = (typeId: string, propertyId: string) => manifest.objectTypes.find((t) => t.id === typeId)?.properties
    .some((p) => p.identityId === propertyId && p.status === 'active' && (p.dataType === 'integer' || p.dataType === 'decimal')) === true;
  if (!numeric(edge.fromObjectTypeId, capacity.capacityPropertyId) || !numeric(edge.toObjectTypeId, capacity.demandPropertyId)) {
    throw new AppError('validation', 'capacity is a number on the resource, demand a number on the dependant', { code: 'simulation.capacity_properties' });
  }
}

const capacityColumns = (c: Capacity | undefined) => c === undefined ? {}
  : { consumption: String(c.consumption), capacityPropertyId: c.capacityPropertyId, demandPropertyId: c.demandPropertyId, capacityPeriod: c.period };

const stateOf = (e: DependencyEdge) => ({
  kind: e.kind, lead_time: e.leadTime, buffer: e.buffer, source: e.source, status: e.status,
  ...(e.kind === 'resource' ? { consumption: e.consumption, capacity_property_id: e.capacityPropertyId, demand_property_id: e.demandPropertyId,
    capacity_period: e.capacityPeriod } : {}),
});
const edgeNotFound = (): AppError => new AppError('not_found', 'no such edge', { code: 'simulation.edge_not_found' });
const stale = (): AppError => new AppError('conflict', 'the edge changed since you read it', { code: 'simulation.edge_stale' });

/** graph.propose from structure: one proposal per link type the reader may see, in its direction (39.3). */
export async function deriveEdges(deps: SimulationDeps, ctx: Context, linkTypeIds: string[] | undefined)
  : Promise<{ proposed: EdgeView[]; alreadyPresent: number }> {
  const who = actor(ctx);
  await demand(deps, ctx, 'graph.propose');
  const manifest = await readManifest(deps, ctx);
  const links = manifest.linkTypes.filter((l) => l.status === 'active' && (linkTypeIds === undefined || linkTypeIds.includes(l.id)));
  const seen = await visibility(deps, ctx, { objectTypes: links.flatMap((l) => [l.fromTypeId, l.toTypeId]), linkTypes: links.map((l) => l.id) });
  const usable = links.filter((l) => seen.linkVisible(l.id) && seen.typeVisible(l.fromTypeId) && seen.typeVisible(l.toTypeId));
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const proposed: EdgeView[] = [];
    let alreadyPresent = 0;
    for (const l of usable) {
      const key = { fromObjectTypeId: l.fromTypeId, toObjectTypeId: l.toTypeId, viaLinkTypeId: l.id, kind: 'hard' as const };
      if (await dependencyEdgeRepo.findLive(db, key)) { alreadyPresent += 1; continue; }
      const edge = await dependencyEdgeRepo.insert(db, {
        id: uuidv7(), organisationId: who.organisationId, ...key, source: 'structure', status: 'proposed',
        evidenceRef: { linkTypeId: l.id, cardinality: l.cardinality }, proposedByMembershipId: who.membershipId ?? null,
        proposedByServicePrincipalId: who.membershipId === undefined ? who.servicePrincipalId ?? null : null,
      });
      await recordEvent(db, who, ctx.correlationId, { event: 'graph_edge_proposed', resource: { type: 'dependency_edge', id: edge.id }, detail: { source: 'structure' } });
      proposed.push(edgeView(edge));
    }
    return { proposed, alreadyPresent };
  });
}

/** graph.propose: a person states an edge. It is a proposal until confirmed. */
export async function proposeEdge(deps: SimulationDeps, ctx: Context, input: {
  fromObjectTypeId: string; toObjectTypeId: string; viaLinkTypeId: string; kind: DependencyEdge['kind']; leadTime?: Duration | undefined;
  buffer?: Duration | undefined;
}): Promise<EdgeView> {
  const who = actor(ctx);
  await demand(deps, ctx, 'graph.propose');
  const manifest = await readManifest(deps, ctx);
  const link = manifest.linkTypes.find((l) => l.id === input.viaLinkTypeId && l.status === 'active');
  const joins = link !== undefined && ((link.fromTypeId === input.fromObjectTypeId && link.toTypeId === input.toObjectTypeId)
    || (link.toTypeId === input.fromObjectTypeId && link.fromTypeId === input.toObjectTypeId));
  if (!joins) throw new AppError('validation', 'the link type does not join those object types', { code: 'simulation.link_mismatch' });
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const edge = await dependencyEdgeRepo.insert(db, {
      id: uuidv7(), organisationId: who.organisationId, fromObjectTypeId: input.fromObjectTypeId, toObjectTypeId: input.toObjectTypeId,
      viaLinkTypeId: input.viaLinkTypeId, kind: input.kind, leadTime: input.leadTime ?? null, buffer: input.buffer ?? null, source: 'stated',
      status: 'proposed', proposedByMembershipId: who.membershipId ?? null,
      proposedByServicePrincipalId: who.membershipId === undefined ? who.servicePrincipalId ?? null : null,
    }).catch((error: unknown) => {
      if (fromDatabaseError(error).category === 'conflict') {
        throw new AppError('conflict', 'that edge is already proposed or confirmed', { code: 'simulation.edge_exists' });
      }
      throw error;
    });
    await recordEvent(db, who, ctx.correlationId, { event: 'graph_edge_proposed', resource: { type: 'dependency_edge', id: edge.id }, detail: { source: 'stated' } });
    return edgeView(edge);
  });
}

export async function listEdges(deps: SimulationDeps, ctx: Context, status: DependencyEdge['status'] | undefined)
  : Promise<{ edges: EdgeView[]; graphVersion: number }> {
  const who = actor(ctx);
  const { edges, graphVersion } = await inTransaction(deps.databases.pool('control'), who.request, async (db) => ({
    edges: await dependencyEdgeRepo.list(db, status), graphVersion: await graphStateRepo.current(db, who.organisationId),
  }), { readOnly: true });
  // An edge between types the reader is not cleared for is not theirs to see.
  const seen = await visibility(deps, ctx, { objectTypes: edges.flatMap((e) => [e.fromObjectTypeId, e.toObjectTypeId]) });
  return { edges: edges.filter((e) => seen.typeVisible(e.fromObjectTypeId) && seen.typeVisible(e.toObjectTypeId)).map(edgeView), graphVersion };
}

type Change = 'confirmed' | 'revised' | 'retired';

async function change(deps: SimulationDeps, ctx: Context, edgeId: string, kind: Change, version: number, reason: string,
  apply: (edge: DependencyEdge, now: string, by: string) => Parameters<typeof dependencyEdgeRepo.updateAtVersion>[3])
  : Promise<{ edge: EdgeView; graphVersion: number }> {
  const who = member(ctx);
  await demand(deps, ctx, 'graph.confirm');
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const edge = await dependencyEdgeRepo.findById(db, edgeId);
    if (edge === undefined) throw edgeNotFound();
    const allowedFrom: Record<Change, DependencyEdge['status'][]> = { confirmed: ['proposed'], revised: ['confirmed'], retired: ['proposed', 'confirmed'] };
    if (!allowedFrom[kind].includes(edge.status)) {
      throw new AppError('conflict', `a ${edge.status} edge cannot be ${kind}`, { code: 'simulation.edge_status', details: { status: edge.status } });
    }
    if (edge.version !== version) throw stale();
    // The graph version first, under its row lock: every change produces one version (39.3).
    const graphVersion = await graphStateRepo.bump(db, who.organisationId);
    const now = new Date().toISOString();
    const updated = await dependencyEdgeRepo.updateAtVersion(db, edgeId, version, apply(edge, now, who.membershipId));
    if (updated === undefined) throw stale();
    await edgeRevisionRepo.insert(db, {
      id: uuidv7(), organisationId: who.organisationId, edgeId, changeKind: kind, previousState: kind === 'confirmed' ? null : stateOf(edge),
      newState: stateOf(updated), reason, revisedBy: who.membershipId, graphVersion: String(graphVersion),
    });
    const event = kind === 'confirmed' ? 'graph_edge_confirmed' : kind === 'revised' ? 'graph_edge_revised' : 'graph_edge_retired';
    await recordEvent(db, who, ctx.correlationId, {
      event, resource: { type: 'dependency_edge', id: edgeId }, detail: { kind: updated.kind, source: updated.source, graph_version: graphVersion },
    });
    return { edge: edgeView(updated), graphVersion };
  });
}

/** graph.confirm: a person states the kind and lead time; a structure proposal becomes stated (39.3). */
export async function confirmEdge(deps: SimulationDeps, ctx: Context, edgeId: string,
  input: { kind: DependencyEdge['kind']; leadTime: Duration; buffer: Duration | null; reason: string; version: number; capacity?: Capacity | undefined }) {
  if (input.capacity !== undefined) {
    const edge = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => dependencyEdgeRepo.findById(db, edgeId), { readOnly: true });
    if (edge === undefined) throw edgeNotFound();
    await checkCapacity(deps, ctx, edge, input.capacity);
  }
  return change(deps, ctx, edgeId, 'confirmed', input.version, input.reason, (edge, now, by) => ({
    kind: input.kind, leadTime: input.leadTime, buffer: input.buffer, status: 'confirmed', confirmedBy: by, confirmedAt: now,
    ...capacityColumns(input.capacity),
    // A structural proposal carries no lead time: the person who confirms states it. An observed
    // one stays history only if the person confirms the lead time observed (39.3: the output says which).
    source: edge.source === 'structure' || (edge.source === 'history' && JSON.stringify(input.leadTime) !== JSON.stringify(edge.leadTime)) ? 'stated' : edge.source,
  }));
}

export async function reviseEdge(deps: SimulationDeps, ctx: Context, edgeId: string,
  input: { kind?: DependencyEdge['kind'] | undefined; leadTime?: Duration | undefined; buffer?: Duration | null | undefined; reason: string; version: number;
    capacity?: Capacity | undefined }) {
  if (input.capacity !== undefined) {
    const edge = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => dependencyEdgeRepo.findById(db, edgeId), { readOnly: true });
    if (edge === undefined) throw edgeNotFound();
    await checkCapacity(deps, ctx, edge, input.capacity);
  }
  return change(deps, ctx, edgeId, 'revised', input.version, input.reason, () => ({
    ...capacityColumns(input.capacity),
    ...(input.kind === undefined ? {} : { kind: input.kind }), ...(input.leadTime === undefined ? {} : { leadTime: input.leadTime, source: 'stated' as const }),
    ...(input.buffer === undefined ? {} : { buffer: input.buffer }),
  }));
}

export function retireEdge(deps: SimulationDeps, ctx: Context, edgeId: string, input: { reason: string; version: number }) {
  return change(deps, ctx, edgeId, 'retired', input.version, input.reason, (_edge, now) => ({ status: 'retired', retiredAt: now }));
}
