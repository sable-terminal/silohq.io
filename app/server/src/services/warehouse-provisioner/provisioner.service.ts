// warehouse-provisioner (spec 69.13): "Create warehouse", and the steps behind it.
//
// Creating asks for a purpose, a retention and the object types (with their properties) to
// hold, and nothing else. In the creator's own request: silo.create is decided; the
// Warehouse's automation principal is created, owned by the creator, and granted read on
// the connections the nominated types are read through (the creator's authority bounds
// both); the Silo, its nominations and the project row are written with the Silo's lineage.
//
// Then, detached and as the principal, the steps run in order, each recorded as done:
//   project_created   a dedicated Google Cloud project per organisation, in the cell's folder
//   dataset_created   one dataset in the cell's region, its location fixed
//   key_bound         a customer-managed key per organisation, in the same region
//   access_granted    the cell's writer service accounts only; no person
//   tables_created    the tables of the nominated types (warehouse-schema)
//   backfill_started  the backfill (warehouse-sync); the Warehouse is active when it completes
// Every step is idempotent, so a failure names its step, leaves nothing half-made that a
// retry would not finish, and a retry resumes from that step.
//
// The Silo stays 'provisioning' while the federated engine cannot yet route questions to
// the Warehouse (spec 69.16 needs a query connection); the project's own status says whether
// it is built and synchronised.

import { createServicePrincipal, grantConnection } from '../../contracts/policy/governance.contract.ts';
import {
  applyWarehouseSchema, PROVISIONING_STEPS, syncWarehouse, type Nomination, type ProvisioningStep, type WarehouseView,
} from '../../contracts/warehouse/warehouse.contract.ts';
import { cellCode, idTail, labelValue } from '../../infra/bigquery.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { WarehouseProject } from '../../models/siloes/index.model.ts';
import { siloObjectTypeRepo, siloRepo, warehouseProjectRepo } from '../../repos/siloes/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { writeLineage } from '../lineage/writer.service.ts';
import { requireSiloes } from '../siloes-capture/deps.service.ts';
import { nominatedProperties } from '../warehouse-schema/schema.service.ts';
import {
  asWarehouse, datasetOf, demand, loadView, readManifest, recordEvent, warehouseView, type Context, type WarehouseDeps,
} from '../warehouse-schema/warehouse.service.ts';

export interface ProvisionerDeps extends WarehouseDeps {
  cellId: string;
  /** The cell's siloes project: where Warehouse keys live. */
  keyProjectId: string;
}

const DATASET = 'silo_warehouse';
const KEY_RING = 'silo-warehouse';
const keyName = (organisationId: string) => `wh-${idTail(organisationId, 20)}`;

function person(ctx: Context): string {
  if (ctx.request.membershipId === undefined) {
    throw new AppError('forbidden', 'a Warehouse is created by a person', { code: 'warehouse.person_required' });
  }
  return ctx.request.membershipId;
}

export async function createWarehouse(deps: ProvisionerDeps, ctx: Context, input: { purpose: string; retentionDays: number; objectTypes: Nomination[] })
  : Promise<WarehouseView> {
  await requireSiloes(deps, ctx);
  const creator = person(ctx);
  const organisationId = ctx.request.organisationId!;
  await demand(deps, ctx, 'silo.create');
  const pool = deps.databases.pool('control');
  const existing = await inTransaction(pool, ctx.request, (db) => warehouseProjectRepo.findByOrganisationId(db, organisationId), { readOnly: true });
  if (existing !== undefined && existing.status !== 'purged') {
    throw new AppError('conflict', 'this organisation already has a Warehouse', { code: 'warehouse.exists' });
  }

  // The nominations, against the ontology the creator can see.
  const manifest = await readManifest(deps, ctx);
  const connections = new Set<string>();
  const inputs: { objectTypeId: string; typeVersionId: string }[] = [];
  for (const n of input.objectTypes) {
    const type = manifest.objectTypes.find((t) => t.id === n.objectTypeId && t.status === 'active');
    if (type === undefined) throw new AppError('validation', 'a nominated object type is not in the ontology', { code: 'warehouse.unknown_type', details: { objectTypeId: n.objectTypeId } });
    const found = nominatedProperties(manifest, n.objectTypeId, n.properties);
    const unknown = n.properties.filter((p) => !found.some((f) => f.apiName === p));
    if (unknown.length > 0) {
      throw new AppError('validation', `${type.apiName} has no property ${unknown[0]}`, { code: 'warehouse.unknown_property', details: { property: unknown[0]! } });
    }
    for (const c of type.contributingObjects) connections.add(c.connectionId);
    inputs.push({ objectTypeId: type.id, typeVersionId: type.typeVersionId });
  }

  // The principal the Warehouse acts as, granted what it reads, in the creator's authority.
  const call = { request: ctx.request, correlationId: ctx.correlationId };
  const principal = await deps.services.call(createServicePrincipal, { body: { kind: 'automation', name: 'Warehouse' } }, call);
  for (const connectionId of connections) {
    await deps.services.call(grantConnection, {
      body: { connectionId, grantee: { kind: 'service_principal', id: principal.id }, access: 'read', includeDescendants: true },
    }, call);
  }

  const siloId = uuidv7();
  const projectId = uuidv7();
  const gcpProjectId = `silo-${cellCode(deps.cellId)}-${idTail(organisationId, 12)}`;
  const location = deps.bigQuery.location;
  const project = await inTransaction(pool, ctx.request, async (db) => {
    await siloRepo.insert(db, {
      id: siloId, organisationId, kind: 'warehouse', name: 'Warehouse', purpose: input.purpose, retentionDays: input.retentionDays,
      location, status: 'provisioning', storeRef: DATASET, createdBy: creator,
    });
    for (const n of input.objectTypes) {
      await siloObjectTypeRepo.insert(db, {
        id: uuidv7(), organisationId, siloId, objectTypeId: n.objectTypeId, nominatedProperties: n.properties, addedBy: creator,
      });
    }
    const row = await warehouseProjectRepo.insert(db, {
      id: projectId, organisationId, siloId, gcpProjectId, dataset: DATASET, location,
      kmsKeyRef: `projects/${deps.keyProjectId}/locations/${location}/keyRings/${KEY_RING}/cryptoKeys/${keyName(organisationId)}`,
      servicePrincipalId: principal.id, createdBy: creator,
    });
    await writeLineage(db, { organisationId, createdBy: { membershipId: creator } }, {
      artefact: { kind: 'silo', refId: siloId, version: '1' },
      inputs: inputs.map((i) => ({ node: { kind: 'object_type_version', refId: i.objectTypeId, version: i.typeVersionId }, relation: 'derives' })),
    });
    return row;
  });
  startProvisioning(deps, project, ctx.correlationId);
  return loadView(deps, ctx.request, project);
}

export async function getWarehouse(deps: WarehouseDeps, ctx: Context): Promise<WarehouseView> {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.manage');
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const project = await warehouseProjectRepo.findByOrganisationId(db, ctx.request.organisationId!);
    if (project === undefined) throw new AppError('not_found', 'this organisation has no Warehouse', { code: 'warehouse.not_found' });
    return warehouseView(db, project);
  }, { readOnly: true });
}

export async function retryProvisioning(deps: ProvisionerDeps, ctx: Context, warehouseId: string): Promise<WarehouseView> {
  await requireSiloes(deps, ctx);
  await demand(deps, ctx, 'silo.manage');
  const project = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const found = await warehouseProjectRepo.findById(db, warehouseId);
    if (!found) throw new AppError('not_found', 'no such Warehouse', { code: 'warehouse.not_found' });
    if (found.status !== 'failed') throw new AppError('conflict', 'only a failed provisioning is retried', { code: 'warehouse.not_failed' });
    return (await warehouseProjectRepo.update(db, found.id, { status: 'provisioning', failedStep: null }))!;
  });
  startProvisioning(deps, project, ctx.correlationId);
  return loadView(deps, ctx.request, project);
}

function startProvisioning(deps: ProvisionerDeps, project: WarehouseProject, correlationId: string): void {
  void provision(deps, project, correlationId).catch((error: unknown) => {
    deps.logger.failure('Warehouse provisioning stopped outside its record', error, { event: 'warehouse.provision_crashed', organisationId: project.organisationId });
  });
}

/** Runs the remaining steps, in order, recording each; stops at the first failure, naming it. */
export async function provision(deps: ProvisionerDeps, project: WarehouseProject, correlationId: string): Promise<void> {
  const ctx = asWarehouse(project, correlationId);
  const pool = deps.databases.pool('control');
  const ref = datasetOf(project);
  const labels = { organisation: labelValue(project.organisationId), service: 'warehouse-provisioner' };
  const call = { request: ctx.request, correlationId };
  const steps: Record<ProvisioningStep, () => Promise<void>> = {
    project_created: async () => { await deps.bigQuery.ensureProject({ projectId: project.gcpProjectId, displayName: 'Silo warehouse', labels }); },
    dataset_created: async () => { await deps.bigQuery.ensureDataset(ref, { labels }); },
    key_bound: async () => {
      const key = await deps.bigQuery.ensureKey({ keyRing: KEY_RING, key: keyName(project.organisationId), rotationDays: 90 });
      await deps.bigQuery.setDatasetKey(ref, key.keyRef);
      if (key.keyRef !== project.kmsKeyRef) {
        await inTransaction(pool, ctx.request, (db) => warehouseProjectRepo.update(db, project.id, { kmsKeyRef: key.keyRef }));
      }
    },
    access_granted: async () => {
      for (const member of deps.config.writerMembers) {
        await deps.bigQuery.grantDatasetAccess(ref, member, 'writer');
        await deps.bigQuery.grantJobUser(project.gcpProjectId, member);
      }
    },
    tables_created: async () => { await deps.services.call(applyWarehouseSchema, { params: { warehouseId: project.id } }, call); },
    backfill_started: async () => { await deps.services.call(syncWarehouse, { params: { warehouseId: project.id }, body: { mode: 'backfill' } }, call); },
  };
  const from = project.provisioningStep === 'none' ? 0 : PROVISIONING_STEPS.indexOf(project.provisioningStep) + 1;
  for (const step of PROVISIONING_STEPS.slice(from)) {
    try {
      // The backfill reports itself done: the project must be backfilling before it starts.
      if (step === 'backfill_started') {
        await inTransaction(pool, ctx.request, (db) => warehouseProjectRepo.update(db, project.id, { status: 'backfilling' }));
      }
      await steps[step]();
    } catch (error) {
      await inTransaction(pool, ctx.request, async (db) => {
        await warehouseProjectRepo.update(db, project.id, { status: 'failed', failedStep: step });
        await recordEvent(db, ctx.request, correlationId, {
          event: 'warehouse_provision_failed', resource: { type: 'warehouse', id: project.id },
          detail: { step, code: isAppError(error) ? error.code : 'warehouse.step_failed' },
        });
      });
      deps.logger.failure('a Warehouse provisioning step failed; it can be retried', error, { event: 'warehouse.provision_failed', organisationId: project.organisationId });
      return;
    }
    await inTransaction(pool, ctx.request, async (db) => {
      await warehouseProjectRepo.update(db, project.id, { provisioningStep: step });
      if (step === 'tables_created') {
        await recordEvent(db, ctx.request, correlationId, { event: 'warehouse_provisioned', resource: { type: 'warehouse', id: project.id } });
      }
    });
  }
}

/** This cell's writers on a Warehouse the organisation brought with it (6.4; D212), then a sync once its sources answer. */
export async function adoptWarehouse(deps: ProvisionerDeps, ctx: Context, warehouseId: string): Promise<{ granted: number }> {
  const project = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => warehouseProjectRepo.findById(db, warehouseId), { readOnly: true });
  if (project === undefined) throw new AppError('not_found', 'no such Warehouse', { code: 'warehouse.not_found' });
  if (project.status === 'purged' || project.status === 'handed_over') return { granted: 0 };
  const ref = datasetOf(project);
  for (const member of deps.config.writerMembers) {
    await deps.bigQuery.grantDatasetAccess(ref, member, 'writer');
    await deps.bigQuery.grantJobUser(project.gcpProjectId, member);
  }
  // The sources were left halted for re-authorisation: the sync catches up when they answer, and is retried on schedule.
  await deps.services.call(syncWarehouse, { params: { warehouseId }, body: { mode: 'scheduled' } }, { request: asWarehouse(project, ctx.correlationId).request, correlationId: ctx.correlationId })
    .catch((error: unknown) => deps.logger.failure('the adopted Warehouse could not sync yet; its schedule tries again', error, { event: 'warehouse.adopt_sync_deferred', organisationId: project.organisationId }));
  return { granted: deps.config.writerMembers.length };
}

/** This cell's writers off a Warehouse the organisation took with it (6.4; D212): the project stays the organisation's. */
export async function releaseWarehouse(deps: ProvisionerDeps, ctx: Context, warehouseId: string): Promise<{ revoked: number }> {
  const project = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => warehouseProjectRepo.findById(db, warehouseId), { readOnly: true });
  if (project === undefined) throw new AppError('not_found', 'no such Warehouse', { code: 'warehouse.not_found' });
  if (project.status === 'purged') return { revoked: 0 };
  const ref = datasetOf(project);
  for (const member of deps.config.writerMembers) await deps.bigQuery.revokeDatasetAccess(ref, member);
  return { revoked: deps.config.writerMembers.length };
}
