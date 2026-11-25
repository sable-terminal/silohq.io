// warehouse-access (spec 69.16, 69.17, 69.20; catalogue): direct SQL for a customer's own
// analysts, and the Warehouse's exit.
//
// - Direct SQL is off by default. A super admin (warehouse.sql_access, never delegable) may
//   give a named Google identity read-only access: dataViewer on the Warehouse dataset and
//   jobUser on its project, applied and removed with the grant row. Its queries bill to the
//   Warehouse project and are metered at cost plus 10%.
// - BigQuery does not enforce Silo's markings, so a grant is refused while any table holds a
//   marked property, and a live grant is revoked by the system (revokedReason marked_data)
//   as soon as a marking reaches what the dataset holds. warehouse_sql_access_granted is the
//   event a reviewer reads first: it is the only way a person reaches the Warehouse outside
//   Silo's authorisation gates.
// - Exit (69.17), on request or on cancellation: the project moves into the customer's own
//   Google Cloud organisation (silo.purge: Silo stops holding it), or every table is exported
//   as Parquet with schema.json and lineage.json (part of the organisation export).

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';

const instant = z.string();
/** A Google identity's email, lower-cased: a user, a group or a service account. */
export const googleIdentity = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const sqlGrantView = z.object({
  id: z.uuid(),
  warehouseId: z.uuid(),
  googleIdentity: z.string(),
  grantedBy: z.uuid(),
  grantedAt: instant,
  revokedBy: z.uuid().nullable(),
  revokedAt: instant.nullable(),
  revokedReason: z.enum(['revoked', 'marked_data', 'handed_over', 'purged']).nullable(),
});
export type SqlGrantView = z.infer<typeof sqlGrantView>;

const warehouseParams = z.strictObject({ warehouseId: z.uuid() });

export const grantWarehouseSqlAccess = defineContract({
  service: 'warehouse-access', name: 'grantWarehouseSqlAccess', method: 'POST', path: '/v1/warehouses/:warehouseId/sql-grants',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: warehouseParams,
  body: z.strictObject({ googleIdentity }),
  response: sqlGrantView, status: 201,
});

export const revokeWarehouseSqlAccess = defineContract({
  service: 'warehouse-access', name: 'revokeWarehouseSqlAccess', method: 'POST', path: '/v1/warehouses/:warehouseId/sql-grants/:grantId/revoke',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: warehouseParams.extend({ grantId: z.uuid() }),
  response: sqlGrantView,
});

export const listWarehouseSqlGrants = defineContract({
  service: 'warehouse-access', name: 'listWarehouseSqlGrants', method: 'GET', path: '/v1/warehouses/:warehouseId/sql-grants',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: warehouseParams,
  response: z.object({ grants: z.array(sqlGrantView) }),
});

export const handOverWarehouse = defineContract({
  service: 'warehouse-access', name: 'handOverWarehouse', method: 'POST', path: '/v1/warehouses/:warehouseId/hand-over',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: warehouseParams,
  body: z.strictObject({
    /** The customer's Google Cloud organisation or folder the project moves under. */
    destination: z.string().regex(/^(organizations|folders)\/\d{1,30}$/, 'organizations/<number> or folders/<number>'),
  }),
  response: z.object({ warehouseId: z.uuid(), status: z.literal('handed_over'), handedOverAt: instant, destination: z.string(), grantsRevoked: z.int() }),
});

export const exportWarehouse = defineContract({
  service: 'warehouse-access', name: 'exportWarehouse', method: 'POST', path: '/v1/warehouses/:warehouseId/exports',
  callers: ['gateway', 'org-export'],
  context: 'organisation', idempotency: 'none',
  params: warehouseParams,
  response: z.object({
    exportId: z.uuid(),
    /** Each table's Parquet parts, under org/<organisation>/exports/<export>/warehouse/<table>/ in object-files. */
    tables: z.array(z.object({ table: z.string(), kind: z.string(), uri: z.string(), jobId: z.string() })),
    schemaKey: z.string(),
    lineageKey: z.string(),
  }),
  status: 201,
});

/** Disable and purge (69.20, 70.2): the dataset and the project go, the key's versions are destroyed; a receipt follows. */
export const purgeWarehouse = defineContract({
  service: 'warehouse-access', name: 'purgeWarehouse', method: 'POST', path: '/v1/warehouses/:warehouseId/purge',
  callers: ['siloes-capture'],
  context: 'organisation', idempotency: 'none',
  params: warehouseParams,
  response: z.object({ dataset: z.string(), projectDeleted: z.boolean(), keyDestroyed: z.boolean(), grantsRevoked: z.int(), tables: z.int() }),
});

/** Purge concept (70.2): one object type's rows in the Warehouse: its current and history tables, and links touching it. */
export const purgeWarehouseType = defineContract({
  service: 'warehouse-access', name: 'purgeWarehouseType', method: 'POST', path: '/v1/warehouses/:warehouseId/types/:objectTypeId/purge',
  callers: ['siloes-capture'],
  context: 'organisation', idempotency: 'none',
  params: warehouseParams.extend({ objectTypeId: z.uuid() }),
  response: z.object({ tables: z.int(), rowsDeleted: z.int() }),
});
