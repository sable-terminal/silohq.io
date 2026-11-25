// The detector registry and each object type's configuration (spec 38.2, 38.11).
// recognition.configure names the properties (by identity, so a rename keeps them) and the
// time field a detector examines on a type, or disables it there.

import type { ConfigurationView, DetectorView } from '../../contracts/recognition/detector.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { Detector } from '../../models/recognition/detector.model.ts';
import {
  detectorConfigurationRepo, detectorRepo, detectorRunRepo, type DetectorConfiguration,
} from '../../repos/recognition/index.repo.ts';
import type { RunView } from '../../contracts/recognition/detector.contract.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { access, actor, demand, member, readManifest, recordEvent, typeOf, type Context, type RecognitionDeps } from './deps.service.ts';
import { runView } from './runs.service.ts';

export const detectorView = (d: Detector): DetectorView => ({
  id: d.id, key: d.key, name: d.name, description: d.description, executionMode: d.executionMode, requiresProperty: d.requiresProperty,
  requiresTimeField: d.requiresTimeField, minimumBaseline: d.minimumBaseline as DetectorView['minimumBaseline'], version: d.currentVersion,
});

const configurationView = (c: DetectorConfiguration, key: string): ConfigurationView => ({
  id: c.id, detector: key, objectTypeId: c.objectTypeId, properties: c.propertyIdentityIds, timeField: c.timeFieldIdentityId, enabled: c.enabled,
  version: c.version, updatedAt: c.updatedAt,
});

export async function listDetectors(deps: RecognitionDeps, ctx: Context): Promise<DetectorView[]> {
  const who = actor(ctx);
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => (await detectorRepo.listActive(db)).map(detectorView), { readOnly: true });
}

async function visibleType(deps: RecognitionDeps, ctx: Context, objectTypeId: string) {
  const manifest = await readManifest(deps, ctx);
  const type = typeOf(manifest, objectTypeId);
  const decision = await access(deps, ctx, { objectTypes: [type.id] });
  if (!decision.allowed || !decision.typeVisible(type.id)) {
    throw new AppError('not_found', 'no such object type', { code: 'recognition.object_type_not_found' });
  }
  return type;
}

export async function listConfigurations(deps: RecognitionDeps, ctx: Context, objectTypeId: string): Promise<ConfigurationView[]> {
  const who = actor(ctx);
  const type = await visibleType(deps, ctx, objectTypeId);
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const registry = await detectorRepo.listActive(db);
    return (await detectorConfigurationRepo.listForType(db, type.id))
      .map((c) => configurationView(c, registry.find((d) => d.id === c.detectorId)?.key ?? 'retired'));
  }, { readOnly: true });
}

export async function configureDetector(deps: RecognitionDeps, ctx: Context, objectTypeId: string, detectorKey: string,
  input: { properties: string[]; timeField: string | null; enabled: boolean; version?: number | undefined }): Promise<ConfigurationView> {
  const who = member(ctx);
  const type = await visibleType(deps, ctx, objectTypeId);
  await demand(deps, ctx, 'recognition.configure', { type: 'object_type', id: type.id });
  for (const id of input.properties) {
    if (!type.properties.some((p) => p.identityId === id && p.status === 'active')) {
      throw new AppError('validation', 'the object type has no such property', { code: 'recognition.property_unknown', details: { property: id } });
    }
  }
  if (input.timeField !== null && !type.timeFields.some((t) => t.propertyIdentityId === input.timeField)) {
    throw new AppError('validation', 'that is not a declared time field of the object type', { code: 'recognition.time_field_unknown' });
  }
  const properties = [...new Set(input.properties)];
  return inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const detector = await detectorRepo.findByKey(db, detectorKey);
    if (!detector || detector.status !== 'active') throw new AppError('not_found', 'no such detector', { code: 'recognition.detector_unknown' });
    if (properties.length > 0 && !detector.requiresProperty) {
      throw new AppError('validation', `${detector.key} examines no named property`, { code: 'recognition.property_not_taken' });
    }
    const existing = await detectorConfigurationRepo.find(db, detector.id, type.id);
    let saved: DetectorConfiguration | undefined;
    if (existing === undefined) {
      saved = await detectorConfigurationRepo.insert(db, {
        id: uuidv7(), organisationId: who.organisationId, detectorId: detector.id, objectTypeId: type.id, propertyIdentityIds: properties,
        timeFieldIdentityId: input.timeField, enabled: input.enabled, configuredBy: who.membershipId,
      });
    } else {
      if (input.version === undefined) {
        throw new AppError('conflict', 'this detector is already configured on the type; send the version you read', { code: 'recognition.configuration_exists' });
      }
      saved = await detectorConfigurationRepo.updateAtVersion(db, existing.id, input.version, {
        propertyIdentityIds: properties, timeFieldIdentityId: input.timeField, enabled: input.enabled, configuredBy: who.membershipId,
      });
      if (saved === undefined) throw new AppError('conflict', 'the configuration changed since you read it', { code: 'recognition.configuration_stale' });
    }
    await recordEvent(db, who, ctx.correlationId, {
      event: 'detector_configured', resource: { type: 'object_type', id: type.id },
      detail: { detector: detector.key, properties: properties.length, time_field: input.timeField !== null, enabled: input.enabled },
    });
    return configurationView(saved, detector.key);
  });
}

export async function getRun(deps: RecognitionDeps, ctx: Context, runId: string): Promise<RunView> {
  const who = actor(ctx);
  const found = await inTransaction(deps.databases.pool('control'), who.request, async (db) => {
    const run = await detectorRunRepo.findById(db, runId);
    return run === undefined ? undefined : { run, detector: await detectorRepo.findById(db, run.detectorId) };
  }, { readOnly: true });
  if (found === undefined) throw new AppError('not_found', 'no such run', { code: 'recognition.run_not_found' });
  const decision = await access(deps, ctx, { objectTypes: [found.run.objectTypeId] });
  if (!decision.typeVisible(found.run.objectTypeId)) throw new AppError('not_found', 'no such run', { code: 'recognition.run_not_found' });
  return runView(found.run, found.detector?.key ?? 'retired');
}
