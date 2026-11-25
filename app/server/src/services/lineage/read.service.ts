// Reading lineage (spec 59.4, 59.5): the upstream of an artefact for a reader who can see it
// (lineage.view), and the reviewer's queries across the organisation (lineage.read): upstream,
// downstream, marking explanation and the access overlay.
//
// Every query is bounded by depth and node count and refuses with the bound named when the
// graph is larger (invariant 2). Markings always apply (57.9): a node whose markings the
// reader does not satisfy is withheld. It is counted, never named, and the walk does not
// pass through it, so nothing reached only through it is shown either. A node asked about
// that the reader may not see is "not found", as if it had no lineage.

import { auditEventMessage, type AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import type { LineageEventName } from '../../contracts/lineage/events.contract.ts';
import type { GraphView, NodeKind, NodeView, Relation } from '../../contracts/lineage/lineage.contract.ts';
import { authorise, resolveAccess } from '../../contracts/policy/decision.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { LineageNode } from '../../models/gov/lineageNode.model.ts';
import { auditEventRepo } from '../../repos/audit/index.repo.ts';
import { lineageNodeRepo, type Traversal } from '../../repos/gov/index.repo.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { explainNode, markingSets } from './markings.service.ts';

export interface LineageDeps {
  databases: Databases;
  services: ServiceClient;
  logger: Logger;
}

type Context = Pick<HandlerContext, 'request' | 'correlationId' | 'caller'>;

interface NodeQuery { kind: NodeKind; refId: string; version?: string | undefined }
interface Bounds { depth: number; maxNodes: number }

const notFound = (): AppError => new AppError('not_found', 'no lineage for that resource', { code: 'lineage.node_not_found' });

function actor(ctx: Context): { organisationId: string; membershipId?: string; servicePrincipalId?: string } {
  const { organisationId, membershipId, servicePrincipalId } = ctx.request;
  if (membershipId === undefined && servicePrincipalId === undefined) {
    throw new AppError('forbidden', 'lineage is read by a member or a service principal', { code: 'lineage.actor_required' });
  }
  return { organisationId: organisationId!, ...(membershipId ? { membershipId } : {}), ...(servicePrincipalId ? { servicePrincipalId } : {}) };
}

export async function demand(deps: LineageDeps, ctx: Context, permission: 'lineage.view' | 'lineage.read'): Promise<void> {
  // lineage.read is the organisation-wide reviewer's: a grant on part of the tree does not cover the whole graph.
  const decision = await deps.services.call(authorise, {
    body: { permission, ...(permission === 'lineage.read' ? { organisationWide: true as const } : {}) },
  }, { request: ctx.request, correlationId: ctx.correlationId });
  if (decision.decision !== 'allow') {
    throw new AppError('forbidden', `you do not hold ${permission}`, { code: 'lineage.not_permitted', details: { permission } });
  }
}

/** The markings among these the reader satisfies, decided by policy (clearances, purpose sessions). */
async function satisfied(deps: LineageDeps, ctx: Context, markingIds: readonly string[]): Promise<Set<string>> {
  if (markingIds.length === 0) return new Set();
  const result = new Set<string>();
  for (let i = 0; i < markingIds.length; i += 500) {
    const access = await deps.services.call(resolveAccess, { body: { markings: markingIds.slice(i, i + 500) } },
      { request: ctx.request, correlationId: ctx.correlationId });
    for (const m of access.markings) if (m.satisfied) result.add(m.id);
  }
  return result;
}

async function rootsOf(db: Queryable, organisationId: string, q: NodeQuery, allVersions: boolean): Promise<LineageNode[]> {
  if (q.version !== undefined) {
    const node = await lineageNodeRepo.findByKindAndRefIdAndVersion(db, { organisationId, kind: q.kind, refId: q.refId, version: q.version });
    return node === undefined ? [] : [node];
  }
  if (allVersions) return lineageNodeRepo.findVersions(db, organisationId, q.kind, q.refId, 1_000);
  const latest = await lineageNodeRepo.findLatest(db, organisationId, q.kind, q.refId);
  return latest === undefined ? [] : [latest];
}

function refuseOver(traversal: Traversal, bounds: Bounds): void {
  if (traversal.overNodes) {
    throw new AppError('bounds', `the lineage reaches more than ${bounds.maxNodes} nodes; narrow it`, {
      code: 'lineage.node_bound', details: { maxNodes: bounds.maxNodes },
    });
  }
  if (traversal.beyondDepth) {
    throw new AppError('bounds', `the lineage is deeper than ${bounds.depth} hops`, { code: 'lineage.depth_bound', details: { depth: bounds.depth } });
  }
}

interface Walked {
  roots: LineageNode[];
  graph: GraphView;
}

/** A bounded walk from the resource, with what the reader may not see withheld. */
export async function walk(deps: LineageDeps, ctx: Context, q: NodeQuery & Bounds, direction: 'upstream' | 'downstream', allVersions: boolean)
  : Promise<Walked> {
  const { organisationId } = actor(ctx);
  const loaded = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const roots = await rootsOf(db, organisationId, q, allVersions);
    if (roots.length === 0) return undefined;
    const traversal = await lineageNodeRepo.traverse(db, organisationId, roots.map((r) => r.id), direction, q.depth, q.maxNodes);
    refuseOver(traversal, q);
    const ids = traversal.nodes.map((n) => n.nodeId);
    return { roots, traversal, nodes: await lineageNodeRepo.findMany(db, organisationId, ids), markings: await markingSets(db, organisationId, ids) };
  }, { readOnly: true });
  if (loaded === undefined) throw notFound();

  const ok = await satisfied(deps, ctx, [...new Set([...loaded.markings.values()].flat())]);
  const visible = (id: string): boolean => (loaded.markings.get(id) ?? []).every((m) => ok.has(m));
  const visibleRoots = loaded.roots.filter((r) => visible(r.id));
  if (visibleRoots.length === 0) throw notFound();

  // Breadth first from the visible roots through visible nodes only.
  const next = new Map<string, { to: string; relation: Relation }[]>();
  for (const e of loaded.traversal.edges) {
    const [from, to] = direction === 'upstream' ? [e.to, e.from] : [e.from, e.to];
    next.set(from, [...(next.get(from) ?? []), { to, relation: e.relation as Relation }]);
  }
  const depthOf = new Map<string, number>(visibleRoots.map((r) => [r.id, 0]));
  const withheld = new Set<string>();
  const shownEdges: GraphView['edges'] = [];
  let frontier = visibleRoots.map((r) => r.id);
  while (frontier.length > 0) {
    const following: string[] = [];
    for (const at of frontier) {
      for (const { to, relation } of next.get(at) ?? []) {
        if (!visible(to)) { withheld.add(to); continue; }
        shownEdges.push(direction === 'upstream' ? { from: to, to: at, relation } : { from: at, to, relation });
        if (!depthOf.has(to)) {
          depthOf.set(to, depthOf.get(at)! + 1);
          following.push(to);
        }
      }
    }
    frontier = following;
  }
  const byId = new Map(loaded.nodes.map((n) => [n.id, n]));
  const nodes: NodeView[] = [...depthOf].map(([id, depth]) => {
    const n = byId.get(id)!;
    return { id, kind: n.kind, refId: n.refId, version: n.version, depth, createdAt: n.createdAt, markingIds: loaded.markings.get(id) ?? [] };
  }).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  const edgeKey = (e: GraphView['edges'][number]): string => `${e.from}:${e.to}:${e.relation}`;
  const edges = [...new Map(shownEdges.map((e) => [edgeKey(e), e])).values()];
  return { roots: visibleRoots, graph: { root: visibleRoots[0]!.id, direction, nodes, edges, withheld: withheld.size } };
}

/** An audit event, in its own transaction: a read changes nothing else. */
export async function recordEvent(deps: LineageDeps, ctx: Context, event: LineageEventName, resource: { type: string; id: string },
  detail: Record<string, string | number | boolean>): Promise<void> {
  const a = actor(ctx);
  const who: AuditActor = a.membershipId !== undefined ? { kind: 'membership', membershipId: a.membershipId }
    : { kind: 'service_principal', servicePrincipalId: a.servicePrincipalId! };
  const payload = auditEventMessage.schema.parse({
    event, actor: who, subjectMembershipId: null, scopeId: null, resource, purposeSessionId: null, operatorAccessSessionId: null,
    ipHash: null, detail,
  });
  await inTransaction(deps.databases.pool('control'), ctx.request, (db) => outboxRepo.insert(db, {
    id: uuidv7(), organisationId: a.organisationId, topic: auditEventMessage.topic, orderingKey: a.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: ctx.correlationId,
  }));
}

export const counts = (g: GraphView, depth: number) => ({ nodes: g.nodes.length, edges: g.edges.length, withheld: g.withheld, depth });

/** lineage.view (spec 59.1, 59.5): the sources of an artefact the reader can see. */
export async function lineageOf(deps: LineageDeps, ctx: Context, q: NodeQuery & Bounds): Promise<GraphView> {
  await demand(deps, ctx, 'lineage.view');
  const { graph } = await walk(deps, ctx, q, 'upstream', false);
  await recordEvent(deps, ctx, 'lineage_opened', { type: q.kind, id: q.refId }, counts(graph, q.depth));
  return graph;
}

/** lineage.read: upstream or downstream of a resource across the organisation (spec 59.4). */
export async function review(deps: LineageDeps, ctx: Context, q: NodeQuery & Bounds, direction: 'upstream' | 'downstream'): Promise<GraphView> {
  await demand(deps, ctx, 'lineage.read');
  const { graph } = await walk(deps, ctx, q, direction, direction === 'downstream');
  await recordEvent(deps, ctx, 'lineage_queried', { type: q.kind, id: q.refId }, { query: direction, ...counts(graph, q.depth) });
  return graph;
}

/** lineage.read: each marking an artefact carries and the path it was inherited by (spec 59.4). */
export async function explain(deps: LineageDeps, ctx: Context, q: NodeQuery): Promise<{
  node: string; markings: { markingId: string; origin: 'direct' | 'inherited' | 'pending'; path: { nodeId: string; kind: NodeKind; refId: string; version: string }[] }[];
}> {
  await demand(deps, ctx, 'lineage.read');
  const { organisationId } = actor(ctx);
  const loaded = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const [node] = await rootsOf(db, organisationId, q, false);
    if (node === undefined) return undefined;
    const paths = await explainNode(db, organisationId, node.id);
    const pathIds = [...new Set(paths.flatMap((p) => p.path))];
    return {
      node, paths, pathNodes: await lineageNodeRepo.findMany(db, organisationId, pathIds),
      markings: await markingSets(db, organisationId, [node.id, ...pathIds]),
    };
  }, { readOnly: true });
  if (loaded === undefined) throw notFound();
  const ok = await satisfied(deps, ctx, [...new Set([...loaded.markings.values()].flat())]);
  const visible = (id: string): boolean => (loaded.markings.get(id) ?? []).every((m) => ok.has(m));
  if (!visible(loaded.node.id)) throw notFound();
  const byId = new Map(loaded.pathNodes.map((n) => [n.id, n]));
  const markings = loaded.paths.map((p) => {
    // A path stops at the first step the reviewer may not see.
    const cut = p.path.findIndex((id) => !visible(id));
    const shown = cut === -1 ? p.path : p.path.slice(0, cut);
    return {
      markingId: p.markingId, origin: p.origin,
      path: shown.map((id) => ({ nodeId: id, kind: byId.get(id)!.kind, refId: byId.get(id)!.refId, version: byId.get(id)!.version })),
    };
  });
  await recordEvent(deps, ctx, 'lineage_queried', { type: q.kind, id: q.refId }, { query: 'markings', markings: markings.length });
  return { node: loaded.node.id, markings };
}

/** lineage.read: how many memberships opened artefacts downstream of a resource (spec 59.4, joined from audit). */
export async function accessOverlay(deps: LineageDeps, ctx: Context, q: NodeQuery & Bounds & { since?: string | undefined })
  : Promise<{ artefacts: number; memberships: number; withheld: number }> {
  await demand(deps, ctx, 'lineage.read');
  const { organisationId } = actor(ctx);
  const { roots, graph } = await walk(deps, ctx, q, 'downstream', true);
  const rootIds = new Set(roots.map((r) => r.id));
  const artefacts = graph.nodes.filter((n) => !rootIds.has(n.id));
  const memberships = await inTransaction(deps.databases.pool('control'), ctx.request,
    (db) => auditEventRepo.distinctMembershipsOn(db, organisationId, [...new Set(artefacts.map((n) => n.refId))], q.since ?? null),
    { readOnly: true });
  await recordEvent(deps, ctx, 'lineage_queried', { type: q.kind, id: q.refId }, { query: 'access', artefacts: artefacts.length, memberships });
  return { artefacts: artefacts.length, memberships, withheld: graph.withheld };
}
