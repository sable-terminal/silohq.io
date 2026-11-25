// The Estate map (spec 32): built for the viewer from what the control plane holds:
// connections through the registry, agents, change-stream health through change-stream,
// object and link types from main's ontology, state rule presence from canvas-layout's own
// table. Filtered by the viewer's connection grants and markings (resolveAccess): a
// connection with no access, a type or link not visible, is absent, and the map says part
// of the estate is not visible without a count.
//
// Snapshots (32.4) keep counts and ids, never values, so two times compare without Capture.
// A comparison lists only ids the viewer may see now.

import type { EstateEdge, EstateMap, EstateNode } from '../../contracts/canvas-layout/estate.contract.ts';
import type { CloneState } from '../../contracts/canvas-layout/stateRule.contract.ts';
import { listConnections, type ConnectionView } from '../../contracts/connect-registry/connection.contract.ts';
import { getStreamStatus, type StreamStatusView } from '../../contracts/change-stream/stream.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { EstateSnapshot } from '../../models/clone/estateSnapshot.model.ts';
import { estateSnapshotRepo, stateRuleRepo } from '../../repos/clone/index.repo.ts';
import { agentRepo, connectionCredentialRepo } from '../../repos/connect/index.repo.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { access, actor, demand, mainManifest, notFound, recordEvent, type CanvasDeps, type Context } from './deps.service.ts';

/** A connection not confirmed healthy within a day is stale (its check interval, 32.1). */
const CHECK_INTERVAL_MS = 24 * 3_600_000;
const AGENT_HEARTBEAT_MS = 60_000;
const WITHHELD = 'Part of the estate is not visible to you.';

/** A stable node id derived from another id, for nodes that are not rows of their own (a connection's stream). */
export function derivedId(kind: string, id: string): string {
  const h = sha256(`${kind}:${id}`).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${(8 + (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function connectionHealth(c: ConnectionView, refreshFailed: boolean, now: number): { health: CloneState; reason: string } {
  if (c.status === 'halted' || c.status === 'revoked') return { health: 'failed', reason: c.status };
  if (refreshFailed) return { health: 'warning', reason: 'token_refresh_failed' };
  if (c.lastHealthyAt === null) return { health: 'unknown', reason: 'never_probed' };
  if (now - Date.parse(c.lastHealthyAt) > CHECK_INTERVAL_MS) return { health: 'stale', reason: 'check_overdue' };
  return { health: 'normal', reason: 'healthy' };
}

const STREAM_HEALTH: Record<StreamStatusView['objects'][number]['status'], CloneState> = {
  live: 'normal', delayed: 'warning', stale: 'stale', stopped: 'failed', not_streamed: 'unknown',
};
const SEVERITY: CloneState[] = ['normal', 'unknown', 'stale', 'warning', 'failed'];
const worst = (states: CloneState[]): CloneState => states.reduce((a, b) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a), 'normal');

export async function build(deps: CanvasDeps, ctx: Context): Promise<EstateMap> {
  const who = actor(ctx);
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const now = Date.now();
  const [listed, manifest] = await Promise.all([
    deps.services.call(listConnections, { query: { limit: 500 } }, options),
    mainManifest(deps, ctx),
  ]);
  const types = manifest.objectTypes.filter((t) => t.status === 'active' || t.status === 'proposed');
  const decided = await access(deps, ctx, {
    connections: listed.connections.map((c) => c.id), objectTypes: types.map((t) => t.id), linkTypes: manifest.linkTypes.map((l) => l.id),
  });
  let withheld = decided.decision !== 'allow';
  const reach = new Map(decided.connections.map((c) => [c.id, c.access]));
  const connections = listed.connections.filter((c) => {
    const ok = decided.decision === 'allow' && (reach.get(c.id) ?? 'none') !== 'none';
    if (!ok) withheld = true;
    return ok;
  });
  const visibleTypes = new Set(decided.objectTypes.filter((t) => t.visible).map((t) => t.id));
  if (types.some((t) => !visibleTypes.has(t.id))) withheld = true;
  const visibleLinks = new Set(decided.linkTypes.filter((l) => l.visible).map((l) => l.id));

  const { agents, refreshFailed, ruled } = await inTransaction(deps.databases.pool('control'), who.request, async (db) => ({
    agents: await agentRepo.listForEstate(db, 500),
    refreshFailed: new Set(await connectionCredentialRepo.connectionsWithRefreshFailures(db, connections.map((c) => c.id))),
    ruled: new Set((await stateRuleRepo.activeFor(db, [...visibleTypes])).map((r) => r.objectTypeId)),
  }), { readOnly: true });

  const nodes: EstateNode[] = [];
  const edges: EstateEdge[] = [];
  const missing: EstateMap['missing'] = [
    { kind: 'discovered_systems', reason: 'agent discovery has not run for this organisation' },
    { kind: 'source_structure', reason: 'introspection comes with discovery' },
    { kind: 'siloes', reason: 'no Silo is enabled for this organisation' },
    { kind: 'object_counts', reason: 'object counts are not taken (open decision 32.8)' },
  ];

  // Agents: one per enrolment, serving the connections of their pool.
  for (const agent of agents) {
    const heartbeat = agent.lastHeartbeatAt === null ? undefined : Date.parse(agent.lastHeartbeatAt);
    const served = connections.filter((c) => c.agentPoolId === agent.poolId);
    const state: { health: CloneState; reason: string } = agent.status === 'offline' || agent.status === 'revoked'
      ? { health: 'failed', reason: agent.status }
      : agent.status === 'unhealthy' ? { health: 'warning', reason: 'unhealthy' }
        : heartbeat === undefined || now - heartbeat > AGENT_HEARTBEAT_MS ? { health: 'stale', reason: 'heartbeat_lost' } : { health: 'normal', reason: 'healthy' };
    nodes.push({
      id: agent.id, kind: 'agent', label: agent.name, health: state.health, healthReason: state.reason, trustTier: null, ownerMembershipId: null,
      updatedAt: agent.lastHeartbeatAt, size: { measure: 'connections_served', value: served.length },
      attributes: { hostname: agent.hostname, version: agent.version, version_state: agent.versionState, platform: agent.platform, status: agent.status },
      actionable: false,
    });
    for (const c of served) edges.push({ from: agent.id, to: c.id, kind: 'serves', evidence: 'agent_pool', confirmed: true });
  }

  // Connections, and the change stream of each that runs.
  let streamsUnavailable = false;
  for (const c of connections) {
    const state = connectionHealth(c, refreshFailed.has(c.id), now);
    const contributing = types.filter((t) => visibleTypes.has(t.id) && t.contributingObjects.some((o) => o.connectionId === c.id));
    nodes.push({
      id: c.id, kind: 'connection', label: c.name, health: state.health, healthReason: state.reason, trustTier: c.trustTier,
      ownerMembershipId: c.owningMembershipId, updatedAt: c.lastHealthyAt ?? c.createdAt,
      size: { measure: 'mapped_properties', value: contributing.reduce((n, t) => n + t.properties.filter((p) => p.mappings.some((m) => m.connectionId === c.id)).length, 0) },
      attributes: { status: c.status, provider: c.provider, writes_enabled: c.writesEnabled, through_agent: c.agentPoolId !== null },
      // Awaiting credentials, a probe or confirmation: a person can act (32.2).
      actionable: c.status === 'draft' || c.status === 'probing' || c.status === 'verified',
    });
    if (c.status !== 'active' && c.status !== 'halted') continue;
    let stream: StreamStatusView | undefined;
    try {
      stream = await deps.services.call(getStreamStatus, { params: { connectionId: c.id } }, options);
    } catch (error) {
      if (!isAppError(error) || (error.category !== 'not_found' && error.category !== 'unavailable')) throw error;
      if (error.category === 'unavailable') streamsUnavailable = true;
    }
    if (stream === undefined || (stream.webhook === null && stream.objects.length === 0)) continue;
    const streamId = derivedId('change_stream', c.id);
    const latest = stream.objects.map((o) => o.lastDeltaAt).filter((t): t is string => t !== null).sort().at(-1) ?? stream.webhook?.lastDeliveryAt ?? null;
    const health = stream.objects.length === 0 ? 'unknown' : worst(stream.objects.map((o) => STREAM_HEALTH[o.status]));
    nodes.push({
      id: streamId, kind: 'change_stream', label: `${c.name} stream`, health, healthReason: stream.webhook?.status ?? null, trustTier: null,
      ownerMembershipId: c.owningMembershipId, updatedAt: latest, size: { measure: 'objects_streamed', value: stream.objects.length },
      attributes: { webhook: stream.webhook !== null, in_use: [...new Set(stream.objects.map((o) => o.inUse))].sort().join(',') },
      actionable: false,
    });
    edges.push({ from: streamId, to: c.id, kind: 'streams', evidence: 'change_stream', confirmed: true });
  }
  if (streamsUnavailable) missing.push({ kind: 'change_streams', reason: 'stream health could not be read just now' });

  // Object types, mapped from connections; link types between them.
  for (const t of types) {
    if (!visibleTypes.has(t.id)) continue;
    const via = [...new Set(t.contributingObjects.map((o) => o.connectionId))];
    nodes.push({
      id: t.id, kind: 'object_type', label: t.displayName, health: null, healthReason: null, trustTier: null, ownerMembershipId: null,
      updatedAt: null, size: { measure: 'contributing_connections', value: via.length },
      attributes: { api_name: t.apiName, status: t.status, properties: t.properties.length, state_rule: ruled.has(t.id), resolution: t.resolutionClass },
      // A proposed type is confirmed by a person (32.2).
      actionable: t.status === 'proposed',
    });
    for (const connectionId of via) {
      if (connections.some((c) => c.id === connectionId)) {
        edges.push({ from: connectionId, to: t.id, kind: 'maps_to', evidence: 'confirmed_mapping', confirmed: t.status === 'active' });
      }
    }
  }
  for (const l of manifest.linkTypes) {
    if (!visibleLinks.has(l.id) || !visibleTypes.has(l.fromTypeId) || !visibleTypes.has(l.toTypeId)) continue;
    const route = l.routes.find((r) => r.id === l.defaultRouteId) ?? l.routes[0];
    edges.push({
      from: l.fromTypeId, to: l.toTypeId, kind: 'link', evidence: route?.origin === 'declared_fk' ? 'declared_fk' : 'person_declared',
      confirmed: l.status === 'active',
    });
  }

  return {
    nodes, edges, opensAs: nodes.some((n) => n.actionable) || edges.some((e) => !e.confirmed) ? 'graph' : 'list',
    statement: withheld ? WITHHELD : null, missing, generatedAt: new Date(now).toISOString(),
  };
}

export async function open(deps: CanvasDeps, ctx: Context): Promise<EstateMap> {
  const who = actor(ctx);
  await demand(deps, ctx, { permission: 'estate.view' });
  const map = await build(deps, ctx);
  await inTransaction(deps.databases.pool('control'), who.request, (db) => recordEvent(db, who, ctx.correlationId, {
    event: 'estate_map_opened', resource: null, detail: { nodes: map.nodes.length, edges: map.edges.length, opens_as: map.opensAs },
  }));
  return map;
}

function snapshotView(row: EstateSnapshot) {
  return {
    id: row.id, takenAt: row.takenAt, discoveryRunId: row.discoveryRunId,
    nodeCounts: row.nodeCounts as Record<string, Record<string, number>>, edgeCounts: row.edgeCounts as Record<string, number>,
  };
}

export async function snapshot(deps: CanvasDeps, ctx: Context, discoveryRunId: string | undefined) {
  const who = actor(ctx);
  await demand(deps, ctx, { permission: 'estate.view' });
  const map = await build(deps, ctx);
  const nodeCounts: Record<string, Record<string, number>> = {};
  const nodeRefs: Record<string, string[]> = {};
  for (const node of map.nodes) {
    const byHealth = (nodeCounts[node.kind] ??= {});
    const health = node.health ?? 'none';
    byHealth[health] = (byHealth[health] ?? 0) + 1;
    (nodeRefs[node.kind] ??= []).push(node.id);
  }
  const edgeCounts: Record<string, number> = {};
  for (const edge of map.edges) edgeCounts[edge.kind] = (edgeCounts[edge.kind] ?? 0) + 1;
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const row = await estateSnapshotRepo.insert(db, {
      id: uuidv7(), organisationId: who.organisationId, takenAt: map.generatedAt, nodeCounts, edgeCounts,
      nodeRefs: Object.fromEntries(Object.entries(nodeRefs).map(([k, v]) => [k, v.sort()])), discoveryRunId: discoveryRunId ?? null,
    });
    await recordEvent(db, who, ctx.correlationId, {
      event: 'estate_snapshot_taken', resource: { type: 'estate_snapshot', id: row.id },
      detail: { nodes: map.nodes.length, edges: map.edges.length, after_discovery: discoveryRunId !== undefined },
    });
    return snapshotView(row);
  });
}

export async function listSnapshots(deps: CanvasDeps, ctx: Context, limit: number) {
  const who = actor(ctx);
  await demand(deps, ctx, { permission: 'estate.view' });
  const rows = await inTransaction(deps.databases.pool('control'), who.request, (db) => estateSnapshotRepo.listRecent(db, limit), { readOnly: true });
  return rows.map((r) => ({ id: r.id, takenAt: r.takenAt, discoveryRunId: r.discoveryRunId }));
}

/** What appeared and went between two snapshots, listing only ids the viewer may see now. */
export async function compare(deps: CanvasDeps, ctx: Context, fromId: string, toId: string) {
  const who = actor(ctx);
  await demand(deps, ctx, { permission: 'estate.view' });
  const [from, to] = await inTransaction(deps.databases.pool('control'), who.request, async (db) => [
    await estateSnapshotRepo.findById(db, fromId), await estateSnapshotRepo.findById(db, toId),
  ], { readOnly: true });
  if (!from || !to) throw notFound('estate snapshot', 'clone.estate_snapshot_not_found');
  const now = await build(deps, ctx);
  const visible = new Set(now.nodes.map((n) => n.id));
  const refs = (s: EstateSnapshot) => s.nodeRefs as Record<string, string[]>;
  // Gone since: a connection or type is listed only if the viewer would still be allowed to
  // see it; agents and streams carry no markings of their own.
  const gone = (kind: string) => [...(refs(from)[kind] ?? [])].filter((id) => !(refs(to)[kind] ?? []).includes(id) && !visible.has(id));
  const goneDecided = await access(deps, ctx, { connections: gone('connection'), objectTypes: gone('object_type') });
  for (const c of goneDecided.connections) if (c.access !== 'none') visible.add(c.id);
  for (const t of goneDecided.objectTypes) if (t.visible) visible.add(t.id);
  for (const kind of ['agent', 'change_stream']) for (const id of gone(kind)) visible.add(id);
  const added: Record<string, string[]> = {};
  const removed: Record<string, string[]> = {};
  let hidden = false;
  const shown = (id: string): boolean => {
    if (visible.has(id)) return true;
    hidden = true;
    return false;
  };
  for (const kind of new Set([...Object.keys(refs(from)), ...Object.keys(refs(to))])) {
    const before = new Set(refs(from)[kind] ?? []);
    const after = new Set(refs(to)[kind] ?? []);
    added[kind] = [...after].filter((id) => !before.has(id)).filter(shown);
    removed[kind] = [...before].filter((id) => !after.has(id)).filter(shown);
  }
  return {
    from: { id: from.id, takenAt: from.takenAt }, to: { id: to.id, takenAt: to.takenAt }, added, removed,
    statement: hidden ? WITHHELD : null,
  };
}
