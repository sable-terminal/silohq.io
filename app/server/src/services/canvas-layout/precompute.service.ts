// Precomputed layouts (spec 29.8): above the client threshold, positions and clusters are
// computed here for a graph the caller resolved (node references, edges by index, times
// and lanes for a timeline) and held in the state plane under TTL, never on disk. The
// control plane records the parameters, the set definition's hash, a hash of the graph and
// the cache key: nothing derived from the set's members.
//
// The same graph, layout and ontology version reuse an unexpired computation. Any change
// to the graph is a new computation, which is stricter than spec 29.8's tolerance of 5%
// membership change: positions are addressed by index, so reusing them for a changed graph
// would place the wrong clones.

import { layoutPositionKeys } from '../../infra/keyspaces.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { layoutPrecomputationRepo } from '../../repos/clone/index.repo.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { actor, demand, notFound, recordEvent, type CanvasDeps, type Context } from './deps.service.ts';
import { layout, type LayoutKind } from './layoutEngine.service.ts';

/** Default TTL of a precomputation (29.8): 24 hours. */
const TTL_SECONDS = 24 * 3_600;

export interface PrecomputeInput {
  layout: LayoutKind;
  setDefinitionHash: string;
  objectSetId: string;
  ontologyVersion: number;
  nodes: { ref: string; time?: number | undefined; lane?: number | undefined }[];
  edges: [number, number][];
}

export async function precompute(deps: CanvasDeps, ctx: Context, input: PrecomputeInput)
  : Promise<{ id: string; cacheKey: string; nodeCount: number; expiresAt: string; reused: boolean }> {
  const who = actor(ctx);
  await demand(deps, ctx, { permission: 'clone.view' });
  const graphHash = sha256(canonicalJsonBytes({ nodes: input.nodes, edges: input.edges })).toString('hex');
  const pool = deps.databases.pool('control');
  const reusable = await inTransaction(pool, who.request, (db) => layoutPrecomputationRepo.findReusable(db, {
    setDefinitionHash: input.setDefinitionHash, layoutKind: input.layout, ontologyVersion: String(input.ontologyVersion), graphHash,
  }), { readOnly: true });
  if (reusable && await deps.state.read(layoutPositionKeys, layoutPositionKeys.key(who.organisationId, { precomputationId: reusable.id })) !== undefined) {
    return { id: reusable.id, cacheKey: reusable.cacheKey, nodeCount: reusable.nodeCount, expiresAt: reusable.expiresAt, reused: true };
  }
  const started = performance.now();
  const laid = layout(input.layout, {
    n: input.nodes.length, edges: input.edges, time: input.nodes.map((node) => node.time), lane: input.nodes.map((node) => node.lane),
  });
  const id = uuidv7();
  const cacheKey = layoutPositionKeys.key(who.organisationId, { precomputationId: id });
  await deps.state.put(layoutPositionKeys, cacheKey, { layout: input.layout, positions: laid.positions, notPlaced: laid.notPlaced }, { ttlSeconds: TTL_SECONDS });
  const computedAt = new Date();
  const expiresAt = new Date(computedAt.getTime() + TTL_SECONDS * 1_000).toISOString();
  await inTransaction(pool, who.request, async (db) => {
    await layoutPrecomputationRepo.insert(db, {
      id, organisationId: who.organisationId, objectSetRef: input.objectSetId, setDefinitionHash: input.setDefinitionHash,
      ontologyVersion: String(input.ontologyVersion), layoutKind: input.layout,
      parameters: { graphHash, edgeCount: input.edges.length, notPlaced: laid.notPlaced },
      nodeCount: input.nodes.length, cacheKey, computedAt: computedAt.toISOString(), expiresAt,
    });
    await recordEvent(db, who, ctx.correlationId, {
      event: 'layout_precomputed', resource: { type: 'object_set', id: input.objectSetId },
      detail: { layout: input.layout, nodes: input.nodes.length, edges: input.edges.length, not_placed: laid.notPlaced,
        duration_ms: Math.round(performance.now() - started) },
    });
  });
  return { id, cacheKey, nodeCount: input.nodes.length, expiresAt, reused: false };
}

export async function read(deps: CanvasDeps, ctx: Context, precomputationId: string) {
  const who = actor(ctx);
  await demand(deps, ctx, { permission: 'clone.view' });
  const row = await inTransaction(deps.databases.pool('control'), who.request, (db) => layoutPrecomputationRepo.findById(db, precomputationId),
    { readOnly: true });
  // Expired or evicted: gone, and the caller computes again.
  if (!row || Date.parse(row.expiresAt) <= Date.now()) throw notFound('precomputed layout', 'clone.layout_not_found');
  const held = await deps.state.read(layoutPositionKeys, layoutPositionKeys.key(who.organisationId, { precomputationId }));
  if (held === undefined) throw notFound('precomputed layout', 'clone.layout_not_found');
  return {
    layout: row.layoutKind, nodeCount: row.nodeCount, positions: held.positions, notPlaced: held.notPlaced, computedAt: row.computedAt,
    expiresAt: row.expiresAt,
  };
}
