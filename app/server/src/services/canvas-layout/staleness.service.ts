// Staleness thresholds (spec 28.5): how old a source's values may be before its clones are
// stale, per connection and optionally per object type.
//
// The default comes from what the connection's manifest declares for the source objects
// concerned, by the preferred change source of each:
//   webhook   three heartbeats (the declared heartbeat, or a third of the default window);
//   poll      two intervals;
//   cdc       60 seconds of lost agent heartbeat;
//   none      the type's freshness window, default 15 minutes.
// Several objects: the strictest. Setting a threshold needs state_rule.manage; one longer
// than the default is loosening ("how stale data would be made to look current") and every
// change is audited with both thresholds.

import { getManifestVersion } from '../../contracts/connect-registry/connector.contract.ts';
import { getConnection } from '../../contracts/connect-registry/connection.contract.ts';
import { manifestSchema, type Manifest } from '../../contracts/connect/manifest.contract.ts';
import { DEFAULT_FRESHNESS_SECONDS, type StalenessThresholdView } from '../../contracts/canvas-layout/stateRule.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { StalenessThreshold } from '../../models/clone/stalenessThreshold.model.ts';
import { stalenessThresholdRepo } from '../../repos/clone/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { actor, demand, mainManifest, member, recordEvent, type CanvasDeps, type Context } from './deps.service.ts';

export interface Cadence {
  kind: 'webhook' | 'poll' | 'cdc' | 'none';
  cadenceSeconds: number;
  defaultThresholdSeconds: number;
}

/** Spec 28.5's default for the objects concerned (all the manifest streams when none are named). */
export function cadenceOf(manifest: Manifest, sourceObjects?: readonly string[]): Cadence {
  const none: Cadence = { kind: 'none', cadenceSeconds: DEFAULT_FRESHNESS_SECONDS, defaultThresholdSeconds: DEFAULT_FRESHNESS_SECONDS };
  const stream = manifest.changeStream;
  if (stream === undefined) return none;
  const objects = stream.objects.filter((o) => sourceObjects === undefined || sourceObjects.includes(o.object));
  if (objects.length === 0) return none;
  let strictest: Cadence | undefined;
  for (const object of objects) {
    const source = object.sources[0]!;
    const cadence: Cadence = source.kind === 'poll'
      ? { kind: 'poll', cadenceSeconds: source.intervalSeconds, defaultThresholdSeconds: 2 * source.intervalSeconds }
      : source.kind === 'cdc'
        ? { kind: 'cdc', cadenceSeconds: 60, defaultThresholdSeconds: 60 }
        : (() => {
          const heartbeat = stream.webhook?.heartbeatSeconds ?? Math.round(DEFAULT_FRESHNESS_SECONDS / 3);
          return { kind: 'webhook' as const, cadenceSeconds: heartbeat, defaultThresholdSeconds: 3 * heartbeat };
        })();
    if (strictest === undefined || cadence.defaultThresholdSeconds < strictest.defaultThresholdSeconds) strictest = cadence;
  }
  return strictest!;
}

function view(row: StalenessThreshold, cadence: Cadence): StalenessThresholdView {
  return {
    id: row.id, connectionId: row.connectionId, objectTypeId: row.objectTypeId, thresholdSeconds: row.thresholdSeconds,
    manifestCadenceSeconds: row.manifestCadenceSeconds, defaultThresholdSeconds: cadence.defaultThresholdSeconds,
    loosened: row.thresholdSeconds > cadence.defaultThresholdSeconds, setBy: row.setBy, setAt: row.setAt,
  };
}

/** The connection's current manifest, read through the registry as the caller. */
async function connectionManifest(deps: CanvasDeps, ctx: Context, connectionId: string): Promise<Manifest> {
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  const connection = await deps.services.call(getConnection, { params: { connectionId } }, options);
  const version = await deps.services.call(getManifestVersion, {
    params: { connectorId: connection.connectorId, versionId: connection.manifestId },
  }, options);
  const parsed = manifestSchema.safeParse(version.document);
  if (!parsed.success) throw new AppError('integrity', 'the connection runs a manifest that does not read', { code: 'clone.manifest_unreadable' });
  return parsed.data;
}

/** The source objects of a type on a connection, from main's ontology. */
async function sourceObjectsOf(deps: CanvasDeps, ctx: Context, connectionId: string, objectTypeId: string): Promise<string[]> {
  const manifest = await mainManifest(deps, ctx);
  const type = manifest.objectTypes.find((t) => t.id === objectTypeId && t.status === 'active');
  if (!type) throw new AppError('validation', 'no such object type on main', { code: 'clone.object_type_unknown' });
  const objects = type.contributingObjects.filter((o) => o.connectionId === connectionId).map((o) => o.sourceObject);
  if (objects.length === 0) {
    throw new AppError('validation', 'the type has no contributing object on that connection', { code: 'clone.connection_not_contributing' });
  }
  return objects;
}

export async function set(deps: CanvasDeps, ctx: Context, connectionId: string, input: { objectTypeId?: string | undefined; thresholdSeconds: number })
  : Promise<StalenessThresholdView> {
  const me = member(ctx);
  await demand(deps, ctx, input.objectTypeId !== undefined
    ? { permission: 'state_rule.manage', resource: { type: 'object_type', id: input.objectTypeId } }
    : { permission: 'state_rule.manage', resource: { type: 'connection', id: connectionId } });
  const manifest = await connectionManifest(deps, ctx, connectionId);
  const cadence = cadenceOf(manifest, input.objectTypeId === undefined ? undefined : await sourceObjectsOf(deps, ctx, connectionId, input.objectTypeId));
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const existing = await stalenessThresholdRepo.findForUpdate(db, connectionId, input.objectTypeId ?? null);
    const before = existing?.thresholdSeconds ?? cadence.defaultThresholdSeconds;
    const now = new Date().toISOString();
    const row = existing
      ? (await stalenessThresholdRepo.update(db, existing.id, {
        thresholdSeconds: input.thresholdSeconds, manifestCadenceSeconds: cadence.cadenceSeconds, setBy: me.membershipId, setAt: now,
      }))!
      : await stalenessThresholdRepo.insert(db, {
        id: uuidv7(), organisationId: me.organisationId, connectionId, objectTypeId: input.objectTypeId ?? null,
        thresholdSeconds: input.thresholdSeconds, manifestCadenceSeconds: cadence.cadenceSeconds, setBy: me.membershipId, setAt: now,
      });
    // Both thresholds: loosening is how stale data would be made to look current (32.7).
    await recordEvent(db, me, ctx.correlationId, {
      event: 'staleness_threshold_changed', resource: { type: 'connection', id: connectionId },
      detail: {
        object_type_id: input.objectTypeId ?? null, from_seconds: before, to_seconds: input.thresholdSeconds,
        default_seconds: cadence.defaultThresholdSeconds, cadence_kind: cadence.kind, loosened: input.thresholdSeconds > cadence.defaultThresholdSeconds,
      },
    });
    return view(row, cadence);
  });
}

export async function list(deps: CanvasDeps, ctx: Context, connectionId: string | undefined): Promise<StalenessThresholdView[]> {
  const who = actor(ctx);
  const rows = await inTransaction(deps.databases.pool('control'), who.request, (db) => stalenessThresholdRepo.list(db, connectionId), { readOnly: true });
  if (rows.length === 0) return [];
  // Each default against the connection's manifest now; one read per connection.
  const ontology = await mainManifest(deps, ctx);
  const manifests = new Map<string, Manifest | undefined>();
  const out: StalenessThresholdView[] = [];
  for (const row of rows) {
    if (!manifests.has(row.connectionId)) manifests.set(row.connectionId, await connectionManifest(deps, ctx, row.connectionId).catch(() => undefined));
    const manifest = manifests.get(row.connectionId);
    const objects = row.objectTypeId === null ? undefined
      : ontology.objectTypes.find((t) => t.id === row.objectTypeId)?.contributingObjects
        .filter((o) => o.connectionId === row.connectionId).map((o) => o.sourceObject);
    // A connection whose manifest no longer reads (revoked) keeps the cadence recorded with the row.
    out.push(view(row, manifest !== undefined ? cadenceOf(manifest, objects)
      : { kind: 'none', cadenceSeconds: row.manifestCadenceSeconds, defaultThresholdSeconds: row.manifestCadenceSeconds }));
  }
  return out;
}
