// The Warehouse (spec 69.12 to 69.23): an organisation's own BigQuery warehouse, built and
// kept by Silo. Four services share these contracts:
//
//   warehouse-provisioner  creates the Warehouse Silo and walks provisioning step by step
//                          (project, dataset, key, access, tables, backfill), each step
//                          recorded, retried from where it failed;
//   warehouse-schema       turns the nominated object types into tables (current, history,
//                          links) through the warehouse generator, following the ontology;
//   warehouse-sync         reads the nominated types through the federated engine, as the
//                          Warehouse's own service principal, and writes the tables;
//   warehouse-reconcile    compares row counts and a sample of keys with the sources and
//                          resyncs drift.
//
// The Action ledger (spec 48.2, 66.4) is a table of the Warehouse too: switched on by a
// holder of silo.enable, with its own disclosure, off by default; warehouse-schema creates
// it, and warehouse-sync writes the rows the actions service sends after each receipt.
//
// Nothing here carries a record value, except the ledger's values when the person who
// switched it on chose them: views are references, counts and times.

import { z } from 'zod';
import { apiName } from '../ontology/manifest.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

export const WAREHOUSE_EVENTS = [
  'warehouse_provisioned', 'warehouse_provision_failed', 'warehouse_table_created', 'warehouse_schema_changed',
  'warehouse_backfill_completed', 'warehouse_sync_failed', 'warehouse_reconciled', 'warehouse_sql_access_granted',
  'warehouse_sql_access_revoked', 'warehouse_handed_over', 'warehouse_purged',
  // The Action ledger (48.4)
  'ledger_enabled', 'ledger_disabled', 'ledger_row_written', 'ledger_purged',
] as const;
export type WarehouseEventName = (typeof WAREHOUSE_EVENTS)[number];

/** Provisioning steps in order (spec 69.13); provisioning_step names the last one done. */
export const PROVISIONING_STEPS = ['project_created', 'dataset_created', 'key_bound', 'access_granted', 'tables_created', 'backfill_started'] as const;
export type ProvisioningStep = (typeof PROVISIONING_STEPS)[number];

export const SYNC_MODES = ['backfill', 'stream', 'scheduled', 'reconcile'] as const;

export const nomination = z.strictObject({
  objectTypeId: z.uuid(),
  /** Property API names held: nothing outside this list is stored (spec 66). */
  properties: z.array(apiName).min(1).max(200),
});
export type Nomination = z.infer<typeof nomination>;

export const warehouseTableView = z.object({
  id: z.uuid(),
  kind: z.enum(['current', 'history', 'link', 'ledger']),
  objectTypeId: z.uuid().nullable(),
  linkTypeId: z.uuid().nullable(),
  tableName: z.string(),
  ontologyVersionId: z.uuid(),
  lastSyncedAt: z.string().nullable(),
  rowCount: z.int(),
  /**
   * current: the last sync of this table completed; stale: its last sync failed, so its rows
   * are never shown as current (spec 69.15); never: not synchronised yet.
   */
  freshness: z.enum(['current', 'stale', 'never']),
});
export type WarehouseTableView = z.infer<typeof warehouseTableView>;

export const warehouseView = z.object({
  id: z.uuid(),
  siloId: z.uuid(),
  siloStatus: z.enum(['provisioning', 'active', 'purging', 'disabled']),
  purpose: z.string(),
  retentionDays: z.int(),
  status: z.enum(['provisioning', 'backfilling', 'active', 'failed', 'handed_over', 'purged']),
  provisioningStep: z.enum(['none', ...PROVISIONING_STEPS]),
  failedStep: z.string().nullable(),
  location: z.string(),
  projectId: z.string(),
  dataset: z.string(),
  nominations: z.array(nomination),
  tables: z.array(warehouseTableView),
  /** The Action ledger (48.2): off, or on with references only, or with values. */
  actionLedger: z.enum(['off', 'references', 'values']),
  createdAt: z.string(),
});
export type WarehouseView = z.infer<typeof warehouseView>;

const warehouseId = z.strictObject({ warehouseId: z.uuid() });

/** "Create warehouse" (spec 69.13): silo.create; nothing else is asked but purpose, retention and the types. */
export const createWarehouse = defineContract({
  service: 'warehouse-provisioner', name: 'createWarehouse', method: 'POST', path: '/v1/warehouses', callers: ['gateway'],
  context: 'organisation', idempotency: 'keyed',
  body: z.strictObject({
    purpose: z.string().trim().min(1).max(500),
    retentionDays: z.int().min(1).max(3_650),
    objectTypes: z.array(nomination).min(1).max(50),
  }),
  response: warehouseView, status: 202,
});

export const getWarehouse = defineContract({
  service: 'warehouse-provisioner', name: 'getWarehouse', method: 'GET', path: '/v1/warehouses/current', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: warehouseView,
});

/** Resumes provisioning from the step that failed (spec 69.13: "can be retried"). */
export const retryWarehouseProvisioning = defineContract({
  service: 'warehouse-provisioner', name: 'retryWarehouseProvisioning', method: 'POST', path: '/v1/warehouses/:warehouseId/retry',
  callers: ['gateway'], context: 'organisation', idempotency: 'none',
  params: warehouseId,
  response: warehouseView, status: 202,
});

/**
 * The Warehouse after its organisation moved cells (spec 6.4; D212): its project is the
 * organisation's, not the cell's, so it stays where it is. The cell the organisation moved to
 * adopts it (its writers granted on the dataset and as job users, then a sync from its sources
 * once they answer); the cell it left releases it (its writers' access revoked) before it purges.
 */
export const adoptWarehouse = defineContract({
  service: 'warehouse-provisioner', name: 'adoptWarehouse', method: 'POST', path: '/v1/warehouses/:warehouseId/adoption',
  callers: ['siloes-capture'], context: 'organisation', idempotency: 'none',
  params: warehouseId,
  response: z.object({ granted: z.int().min(0) }),
});
export const releaseWarehouse = defineContract({
  service: 'warehouse-provisioner', name: 'releaseWarehouse', method: 'POST', path: '/v1/warehouses/:warehouseId/release',
  callers: ['siloes-capture'], context: 'organisation', idempotency: 'none',
  params: warehouseId,
  response: z.object({ revoked: z.int().min(0) }),
});

/** Brings the tables level with the nominations and the active ontology version (spec 69.14). */
export const applyWarehouseSchema = defineContract({
  service: 'warehouse-schema', name: 'applyWarehouseSchema', method: 'POST', path: '/v1/warehouses/:warehouseId/schema',
  callers: ['warehouse-provisioner', 'warehouse-sync'], context: 'organisation', idempotency: 'none',
  params: warehouseId,
  response: z.object({
    ontologyVersionId: z.uuid(),
    created: z.array(z.string()),
    /** Columns added, as table.column; a changed type adds a versioned column (spec 69.14). */
    added: z.array(z.string()),
    tables: z.array(warehouseTableView),
  }),
});

/** Starts a sync of the nominated types (all, or those named). Answers at once; runs detached. */
export const syncWarehouse = defineContract({
  service: 'warehouse-sync', name: 'syncWarehouse', method: 'POST', path: '/v1/warehouses/:warehouseId/sync',
  callers: ['gateway', 'warehouse-provisioner', 'warehouse-reconcile'], context: 'organisation', idempotency: 'none',
  params: warehouseId,
  body: z.strictObject({
    mode: z.enum(['backfill', 'scheduled', 'reconcile']),
    objectTypeIds: z.array(z.uuid()).max(50).optional(),
  }),
  response: z.object({ started: z.array(z.object({ objectTypeId: z.uuid(), tableId: z.uuid() })) }), status: 202,
});

export const reconcileWarehouse = defineContract({
  service: 'warehouse-reconcile', name: 'reconcileWarehouse', method: 'POST', path: '/v1/warehouses/:warehouseId/reconcile',
  callers: ['gateway'], context: 'organisation', idempotency: 'none',
  params: warehouseId,
  response: z.object({
    tables: z.array(z.object({
      tableId: z.uuid(),
      objectTypeId: z.uuid(),
      /** Objects the sources hold, and rows the table holds. */
      sourceCount: z.int(),
      tableCount: z.int(),
      sampled: z.int(),
      missing: z.int(),
      outcome: z.enum(['in_step', 'resynced', 'source_unreachable']),
    })),
  }),
});

// ----------------------------------------------------------------------------- the Action ledger (48.2)

export const ACTION_LEDGER_MODES = ['off', 'references', 'values'] as const;

/** Switches the ledger on (with or without values) or off. On, it needs the disclosure acknowledged (invariant 8). */
export const setActionLedger = defineContract({
  service: 'warehouse-schema', name: 'setActionLedger', method: 'POST', path: '/v1/warehouses/:warehouseId/action-ledger',
  callers: ['gateway'], context: 'organisation', idempotency: 'none',
  params: warehouseId,
  body: z.strictObject({
    mode: z.enum(ACTION_LEDGER_MODES),
    /** The person has read the disclosure the Warehouse view shows for the ledger. */
    disclosureAcknowledged: z.boolean().default(false),
  }),
  response: z.object({ mode: z.enum(ACTION_LEDGER_MODES), disclosure: z.string(), table: warehouseTableView.nullable() }),
});

const id = z.uuid();
export const ledgerRow = z.strictObject({
  ledgerId: id, mutationId: id, receiptId: id, commitId: id.nullable(),
  /** API name and version. */
  actionType: z.string().max(100), genericEdit: z.boolean(), riskClass: z.enum(['data', 'bulk', 'external', 'physical']),
  objectType: z.string().max(100), objectId: id, connectionId: id.nullable(),
  operation: z.enum(['create', 'update_full', 'update_partial', 'delete', 'upsert', 'custom']), fields: z.array(z.string()).max(500),
  /** Record values: sent only when the ledger holds values. */
  priorValues: z.record(z.string(), z.json()).nullable(), newValues: z.record(z.string(), z.json()).nullable(),
  proposer: id.nullable(), approvers: z.array(id), selfApproved: z.boolean(), origin: z.enum(['action', 'revert']),
  outcome: z.enum(['verified', 'diverged', 'failed']), revertsMutationId: id.nullable(), proposedAt: z.string().nullable(), executedAt: z.string(),
  markingIds: z.array(id),
});
export type LedgerRow = z.infer<typeof ledgerRow>;

/**
 * Receipt purge reaches the ledger (48.2): where it holds values, those of these receipts'
 * rows are cleared; references and outcomes stay. ledger_purged with the counts.
 */
export const purgeActionLedgerValues = defineContract({
  service: 'warehouse-sync', name: 'purgeActionLedgerValues', method: 'POST', path: '/v1/warehouses/current/action-ledger/value-purges',
  callers: ['actions'], context: 'organisation', idempotency: 'none',
  body: z.strictObject({ receiptIds: z.array(id).min(1).max(1_000) }),
  response: z.object({ rows: z.int().min(0), mode: z.enum(ACTION_LEDGER_MODES) }),
  maxBodyBytes: 64 * 1024,
});

/** The rows of one executed Action (actions, after its receipt). Values are kept only where the ledger holds them. */
export const writeActionLedger = defineContract({
  service: 'warehouse-sync', name: 'writeActionLedger', method: 'POST', path: '/v1/warehouses/current/action-ledger/rows',
  callers: ['actions'], context: 'organisation', idempotency: 'none',
  body: z.strictObject({ receiptId: id, rows: z.array(ledgerRow).min(1).max(10_000) }),
  response: z.object({ written: z.int().min(0), mode: z.enum(ACTION_LEDGER_MODES) }),
  maxBodyBytes: 32 * 1024 * 1024,
});
