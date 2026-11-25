// Change-stream deltas to Capture (spec 30.7, 67.2): where a Capture Silo includes a type,
// the changes a stream observes for its nominated properties are queued for capture as well
// as delivered live, so history accumulates from observed changes as well as from queries.
// Queued, never inline: a capture failure never affects live delivery.
//
// A change names a source record; Capture records a Silo object. A single-source type's
// object id is computed from the record (connection, source object, identifier), so its
// changes are captured whether or not anyone watches the object live. A resolvable type's
// object is known only after resolution, which a stream does not run: its changes are
// captured from queries, as before. A deletion is not an observation of any property.

import type { SourceChange } from '../../contracts/change-stream/delta.contract.ts';
import { getManifest, type OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { enqueueObservations, type Observation } from '../siloes-capture/intake.service.ts';
import { singleSourceObjectId } from '../../utils/siloObjectId.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { ChangeStreamDeps } from './deps.service.ts';

/** How long a manifest read for capture is reused. */
const MANIFEST_TTL_MS = 60_000;

/** The observations a connection's accepted changes make, by observation time, for the single-source types it contributes. */
export function captureObservations(manifest: OntologyManifest, organisationId: string, connectionId: string, changes: readonly SourceChange[])
  : Map<string, Observation[]> {
  const byTime = new Map<string, Observation[]>();
  for (const change of changes) {
    if (change.operation === 'delete') continue;
    for (const type of manifest.objectTypes) {
      if (type.resolutionClass !== 'single_source' || type.status !== 'active') continue;
      if (!type.contributingObjects.some((c) => c.connectionId === connectionId && c.sourceObject === change.object)) continue;
      const values: Record<string, unknown> = {};
      const connectionIds: Record<string, string> = {};
      for (const p of type.properties) {
        const mapping = p.mappings.find((m) => m.connectionId === connectionId && m.sourceObject === change.object);
        if (mapping === undefined || !Object.hasOwn(change.changed, mapping.fieldPath)) continue;
        values[p.apiName] = change.changed[mapping.fieldPath];
        connectionIds[p.apiName] = connectionId;
      }
      if (Object.keys(values).length === 0) continue;
      const objectRef = singleSourceObjectId(organisationId, type.id, connectionId, change.object, change.entityRef);
      byTime.set(change.observedAt, [...(byTime.get(change.observedAt) ?? []), { objectTypeId: type.id, objectRef, values, connectionIds }]);
    }
  }
  return byTime;
}

export function createStreamCapture(deps: ChangeStreamDeps) {
  const manifests = new Map<string, { at: number; manifest: OntologyManifest }>();

  async function manifestOf(organisationId: string): Promise<OntologyManifest> {
    const cached = manifests.get(organisationId);
    if (cached !== undefined && Date.now() - cached.at < MANIFEST_TTL_MS) return cached.manifest;
    const manifest = await deps.services.call(getManifest, { query: {} }, { request: { organisationId }, correlationId: uuidv7() });
    if (manifests.size > 1_000) manifests.clear();
    manifests.set(organisationId, { at: Date.now(), manifest });
    return manifest;
  }

  return {
    /** Queues what the changes observed; resolves to the count queued, and never throws. */
    async capture(organisationId: string, connectionId: string, changes: readonly SourceChange[]): Promise<number> {
      if (changes.length === 0) return 0;
      try {
        const manifest = await manifestOf(organisationId);
        let queued = 0;
        for (const [observedAt, observations] of captureObservations(manifest, organisationId, connectionId, changes)) {
          queued += await enqueueObservations({ databases: deps.databases, redis: deps.data, logger: deps.logger }, { organisationId }, 'change_stream',
            observations, observedAt);
        }
        return queued;
      } catch (error) {
        deps.logger.failure('changes were not queued for capture: a capture gap', error, { event: 'siloes.capture_gap', organisationId, resourceType: 'connection', resourceId: connectionId });
        return 0;
      }
    },
  };
}

export type StreamCapture = ReturnType<typeof createStreamCapture>;
