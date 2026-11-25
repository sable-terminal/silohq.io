// Resolving a subscribed set, once, under the holder's own permissions (spec 24.3, 30.1).
//
// The set is the saved object set the reference names, read from the ontology with the
// type from main's head. Its type must be visible to the holder (policy resolveAccess:
// markings, connection grants, field policies), and so must every property its predicate
// reads; the properties asked for are granted where visible with no field policy, else
// withheld by name (a masked or redacted field is withheld from live state rather than
// transformed). The permission fingerprint is the hash of what the holder was granted: two
// holders with the same fingerprint may share a group, never two with different ones.
//
// The snapshot is a bounded read through connect-runtime of the type's contributing source
// object: the identifier and the fields mapped to the granted and predicate properties, at
// most the per-subscription bound plus one, so a set too large is refused with the bound,
// never truncated (spec 24.3, 30.5). This build resolves filter and explicit sets over a
// single-source type; resolvable types, traversals, composites and saved views need the
// federated engine and entity resolution, and are refused as unresolvable until the state
// plane resolves through them.

import { createHash } from 'node:crypto';
import { readObject } from '../../contracts/connect-runtime/read.contract.ts';
import type { SetReference } from '../../contracts/gateway/live.contract.ts';
import { getManifest, type ObjectTypeView, type PropertyView } from '../../contracts/ontology/manifest.contract.ts';
import { getObjectSet, type ObjectSetView } from '../../contracts/ontology/objectSet.contract.ts';
import { resolveAccess } from '../../contracts/policy/decision.contract.ts';
import { LIMITS } from '../../config/limits.config.ts';
import type { RequestContext } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import { isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { compileCel } from '../expression-evaluator/cel.service.ts';
import { identifierText } from '../../utils/siloObjectId.util.ts';
import { singleSourceObjectId } from './objectIds.service.ts';

/** Spec 30.5 bounds (targets, untested until the load tests of chapter 12). */
export const LIVE_BOUNDS = {
  objectsPerSubscription: LIMITS.bus.objectsPerSubscription,
  objectsPerUser: 250_000,
  objectsPerOrganisation: LIMITS.statePlane.liveObjectsPerOrganisation,
  subscriptionsPerUser: 20,
  watchedPropertiesPerType: 64,
} as const;

/** A property the group serves: by API name to the client, by identity in state, by field at the source. */
export interface PlanProperty {
  apiName: string;
  identityId: string;
  connectionId: string;
  sourceObject: string;
  fieldPath: string;
}

/** What a group serves: names, ids and the source, never values. Kept with the group. */
export interface GroupPlan {
  set: SetReference;
  objectTypeId: string;
  ontologyVersionId: string;
  connectionId: string;
  sourceObject: string;
  identifier: string[];
  /** Granted: sent to subscribers. */
  properties: PlanProperty[];
  /** Read for the predicate only, never sent unless granted too. */
  predicateProperties: PlanProperty[];
  withheld: string[];
  predicate: { cel: string } | null;
  /** An explicit set's members. */
  explicitIds: string[] | null;
}

export interface ResolvedObject {
  objectId: string;
  entityRef: string;
  /** Property identity to value, for granted and predicate properties. */
  values: Map<string, unknown>;
}

export type Resolution =
  | { outcome: 'resolved'; plan: GroupPlan; objectSetHash: string; fingerprint: string; projectionHash: string; read: () => Promise<Snapshot> }
  | { outcome: 'refused'; reason: 'bound' | 'unresolvable' | 'permission'; bound?: string; limit?: number; count?: number };

export interface Snapshot {
  /** When the read began: deltas observed after it apply over it (spec 18.5). */
  readStartedAt: number;
  objects: ResolvedObject[];
}

const hex = (value: unknown): string => createHash('sha256').update(canonicalJsonBytes(value)).digest('hex');
const unresolvable = (): Resolution => ({ outcome: 'refused', reason: 'unresolvable' });

/** Evaluates a saved set's predicate over an object's properties by API name. */
export function predicateOf(cel: string): (object: Record<string, unknown>, now: Date) => boolean {
  const program = compileCel(cel, { object: 'map', now: 'timestamp' });
  return (object, now) => {
    try {
      return program.evaluate({ object, now }, { steps: 10_000, timeMs: 10 }) === true;
    } catch {
      return false;
    }
  };
}

export async function resolveSet(services: ServiceClient, request: RequestContext, set: SetReference, requested: readonly string[],
  correlationId: string): Promise<Resolution> {
  const options = { request, correlationId };
  if (set.kind !== 'object_set') return unresolvable();
  let objectSet: ObjectSetView;
  try {
    objectSet = await services.call(getObjectSet, { params: { objectSetId: set.id } }, options);
  } catch (error) {
    if (isAppError(error) && (error.category === 'not_found' || error.category === 'forbidden')) return unresolvable();
    throw error;
  }
  const definition = objectSet.definition;
  if (definition.kind !== 'filter' && definition.kind !== 'explicit') return unresolvable();
  const typeId = definition.kind === 'filter' ? ('objectTypeId' in definition.base ? definition.base.objectTypeId : undefined) : definition.objectTypeId;
  if (typeId === undefined) return unresolvable();
  const manifest = await services.call(getManifest, { query: {} }, options);
  const type: ObjectTypeView | undefined = manifest.objectTypes.find((t) => t.id === typeId);
  if (type === undefined || type.resolutionClass !== 'single_source' || type.contributingObjects.length !== 1) return unresolvable();
  const contributing = type.contributingObjects[0]!;

  if (new Set(requested).size > LIVE_BOUNDS.watchedPropertiesPerType) {
    return { outcome: 'refused', reason: 'bound', bound: 'watched_properties_per_type', limit: LIVE_BOUNDS.watchedPropertiesPerType, count: new Set(requested).size };
  }
  const predicate = definition.kind === 'filter' ? definition.predicate : null;
  const byName = new Map(type.properties.map((p) => [p.apiName, p]));
  const byIdentity = new Map(type.properties.map((p) => [p.identityId, p]));
  const asked = [...new Set(requested)].map((name) => byName.get(name)).filter((p): p is PropertyView => p !== undefined);
  const predicateProps = (predicate?.properties ?? []).map((id) => byIdentity.get(id)).filter((p): p is PropertyView => p !== undefined);
  const access = await services.call(resolveAccess, {
    body: {
      objectTypes: [type.id], connections: [contributing.connectionId],
      properties: [...new Set([...asked, ...predicateProps].map((p) => p.identityId))],
    },
  }, options);
  const typeVisible = access.objectTypes.find((t) => t.id === type.id)?.visible === true;
  const connectionAccess = access.connections.find((c) => c.id === contributing.connectionId)?.access ?? 'none';
  if (access.decision !== 'allow' || !typeVisible || connectionAccess === 'none') return { outcome: 'refused', reason: 'permission' };
  const effect = new Map(access.properties.map((p) => [p.id, p.visible ? p.effect : 'deny' as const]));
  if (predicateProps.some((p) => effect.get(p.identityId) !== 'allow')) return { outcome: 'refused', reason: 'permission' };

  const planned = (p: PropertyView): PlanProperty | undefined => {
    const mapping = p.mappings.find((m) => m.connectionId === contributing.connectionId && m.sourceObject === contributing.sourceObject);
    return mapping === undefined ? undefined
      : { apiName: p.apiName, identityId: p.identityId, connectionId: mapping.connectionId, sourceObject: mapping.sourceObject, fieldPath: mapping.fieldPath };
  };
  const granted = asked.filter((p) => effect.get(p.identityId) === 'allow').map(planned).filter((p): p is PlanProperty => p !== undefined);
  const grantedNames = new Set(granted.map((p) => p.apiName));
  const withheld = [...new Set(requested)].filter((name) => !grantedNames.has(name)).sort();
  const predicateProperties = predicateProps.map(planned).filter((p): p is PlanProperty => p !== undefined);
  if (predicateProperties.length !== predicateProps.length) return unresolvable();

  const plan: GroupPlan = {
    set, objectTypeId: type.id, ontologyVersionId: manifest.version.id, connectionId: contributing.connectionId,
    sourceObject: contributing.sourceObject, identifier: [contributing.identifierFieldPath],
    properties: granted.sort((a, b) => a.apiName.localeCompare(b.apiName)), predicateProperties, withheld,
    predicate: predicate === null ? null : { cel: predicate.cel },
    explicitIds: definition.kind === 'explicit' ? [...definition.ids].sort() : null,
  };
  const objectSetHash = hex({ set, definition, type: type.typeVersionId, version: manifest.version.id });
  const fingerprint = hex({ type: type.id, connection: connectionAccess, granted: granted.map((p) => p.identityId).sort() });
  const projectionHash = hex({ granted: [...grantedNames].sort(), withheld });

  const read = async (): Promise<Snapshot> => {
    const readStartedAt = Date.now();
    const fields = [...new Set([contributing.identifierFieldPath, ...granted.map((p) => p.fieldPath), ...predicateProperties.map((p) => p.fieldPath)])];
    const result = await services.call(readObject, {
      body: { connectionId: contributing.connectionId, reason: 'query', step: { object: contributing.sourceObject, fields, limit: LIVE_BOUNDS.objectsPerSubscription + 1 } },
    }, { request, correlationId: uuidv7(), timeoutMs: 60_000 });
    if (result.rows.length > LIVE_BOUNDS.objectsPerSubscription) {
      throw Object.assign(new Error('bound'), { liveBound: true });
    }
    const test = plan.predicate === null ? undefined : predicateOf(plan.predicate.cel);
    const explicit = plan.explicitIds === null ? undefined : new Set(plan.explicitIds);
    const now = new Date();
    const objects: ResolvedObject[] = [];
    for (const row of result.rows) {
      const entityRef = identifierText(row[contributing.identifierFieldPath]);
      if (entityRef === undefined) continue;
      const objectId = singleSourceObjectId(request.organisationId!, type.id, contributing.connectionId, contributing.sourceObject, entityRef);
      if (explicit !== undefined && !explicit.has(objectId)) continue;
      if (test !== undefined) {
        const subject = Object.fromEntries(predicateProperties.map((p) => [p.apiName, row[p.fieldPath] ?? null]));
        if (!test(subject, now)) continue;
      }
      const values = new Map<string, unknown>();
      for (const p of [...granted, ...predicateProperties]) values.set(p.identityId, row[p.fieldPath] ?? null);
      objects.push({ objectId, entityRef, values });
    }
    return { readStartedAt, objects };
  };
  return { outcome: 'resolved', plan, objectSetHash, fingerprint, projectionHash, read };
}
