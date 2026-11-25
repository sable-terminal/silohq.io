// Capture's intake (spec 67.2): what a query or change stream observed, queued for the
// Capture Siloes holding its types, and for the Warehouse holding them, which takes the
// change stream's observations between its syncs (69.15). Kept apart from the rest of Capture so a producer (the
// executor, the state plane) loads only this: Postgres, Redis and the switch.
//
// Queued, never inline: producers call enqueueObservations without awaiting it, and a
// capture failure never fails a question. Only nominated properties are queued, nothing
// while Siloes are off, and a value the reader did not see in full is not an observation.

import type { ResultObject } from '../../contracts/executor/result.contract.ts';
import { captureQueueKeys } from '../../infra/keyspaces.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable, type RequestContext } from '../../infra/postgres.infra.ts';
import type { RedisStore } from '../../infra/redis.infra.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { indexDefinitionRepo, siloObjectTypeRepo } from '../../repos/siloes/index.repo.ts';
import { canonicalTimestamp } from '../../utils/time.util.ts';

export const MINUTE = 60_000;

/** Whether the organisation has Siloes switched on. */
export async function siloesEnabled(db: Queryable, organisationId: string): Promise<boolean> {
  return (await organisationRepo.findById(db, organisationId))?.storageEnabled === true;
}

export interface Observation {
  objectTypeId: string;
  objectRef: string;
  /** Values by property API name, as the source answered them. Record values. */
  values: Record<string, unknown>;
  /** The connection each property's value came from. */
  connectionIds: Record<string, string>;
}

export interface IntakeDeps {
  databases: Databases;
  redis: RedisStore | undefined;
  logger: Logger;
}

/**
 * Queues what a query or change stream observed, for the Capture Siloes holding its types.
 * Only nominated properties are queued; nothing when Siloes are off or no Silo holds the
 * types. A bound reached drops the batch for that Silo and is logged as a capture gap.
 */
export async function enqueueObservations(deps: IntakeDeps, request: RequestContext, origin: 'query' | 'change_stream',
  observations: Observation[], observedAt: string): Promise<number> {
  if (deps.redis === undefined || observations.length === 0 || request.organisationId === undefined) return 0;
  const organisationId = request.organisationId;
  const typeIds = [...new Set(observations.map((o) => o.objectTypeId))];
  const scope = { organisationId };
  const nominations = await inTransaction(deps.databases.pool('control'), scope, async (db) => {
    if (!await siloesEnabled(db, organisationId)) return [];
    // An Object Index's definitions take the change stream's observations as well (69.4).
    const indexed = origin === 'change_stream' ? await indexDefinitionRepo.liveForTypes(db, typeIds) : [];
    return [...await siloObjectTypeRepo.liveCaptureFor(db, typeIds),
      ...indexed.map((d) => ({ siloId: d.siloId, objectTypeId: d.objectTypeId, nominatedProperties: d.nominatedProperties }))];
  }, { readOnly: true });
  if (nominations.length === 0) return 0;
  const at = canonicalTimestamp(observedAt);
  const minute = Math.floor(Date.parse(at) / MINUTE);
  let queued = 0;
  for (const n of nominations) {
    const entries = observations.filter((o) => o.objectTypeId === n.objectTypeId).flatMap((o) => n.nominatedProperties.flatMap((property) => {
      const connectionId = o.connectionIds[property];
      if (!(property in o.values) || connectionId === undefined) return [];
      return [{ objectTypeId: o.objectTypeId, objectRef: o.objectRef, property, value: o.values[property], observedAt: at, connectionId, origin }];
    }));
    if (entries.length === 0) continue;
    try {
      await deps.redis.appendStream(captureQueueKeys, captureQueueKeys.key(organisationId, { siloId: n.siloId, minute }), entries);
      queued += entries.length;
    } catch (error) {
      deps.logger.failure('observations were not queued for capture: a capture gap', error, { event: 'siloes.capture_gap', organisationId });
    }
  }
  return queued;
}

/** The objects of an answer as observations: values the reader saw in full, with the connection each came from. */
export function observationsOf(objects: readonly ResultObject[], connectionOf: (apiName: string) => string | undefined): Observation[] {
  return objects.map((o) => {
    const values: Record<string, unknown> = {};
    const connectionIds: Record<string, string> = {};
    for (const [apiName, value] of Object.entries(o.values)) {
      const state = o.states[apiName];
      // A disputed, masked, redacted or unchecked value is not an observation of the property.
      if (o.disputed.includes(apiName) || o.masked.includes(apiName) || o.redacted.includes(apiName) || state === 'unchecked') continue;
      const connectionId = connectionOf(apiName);
      if (connectionId === undefined) continue;
      values[apiName] = value;
      connectionIds[apiName] = connectionId;
    }
    return { objectTypeId: o.objectTypeId, objectRef: o.id, values, connectionIds };
  });
}

