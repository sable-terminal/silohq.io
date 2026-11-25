// Tenant migrations (spec 6.4, 6.7): moving an organisation from one cell to another, the
// only sanctioned movement of tenant data between cells.
//
//   approval → window → read-only (Actions and Crons paused) → export under tenant context
//   → encrypt to destination import key → import under silo_migrate → verify row counts and
//   checksums → re-authorise connections → directory update → source read-only 30 days →
//   source purge with receipt
//
// Cells are sealed, so no service here calls the other cell. The two cells meet through
// two files that an operator carries, and through the directory:
// - The source writes the sealed bundle to its object-backup bucket at
//   cell/tenant-migrations/<id>/bundle. Copied to the same key in the destination's bucket,
//   it is found and loaded there.
// - The destination updates the directory once the load is verified. The source sees its
//   organisation now routes elsewhere, holds read-only for 30 days, then purges and writes
//   cell/tenant-migrations/<id>/purge-receipt.json. Copied to the destination, the receipt
//   completes the migration there.
//
// Who may ask (spec 6.4):
// - Residency change: the customer's super admin in writing (the request), plus the Silo
//   security officer.
// - Rebalancing within a residency: Silo proposes with 30 days' notice; the customer may
//   approve or object, and an objection stops it.
// - Promotion to a dedicated or sovereign cell: the contract (Silo's side) plus the
//   customer's super admin, plus the sovereign security officer for sovereign.
//
// Operator routes are admin-portal's (not built): the operator id is the Silo operator
// admin-portal authenticated.

import { z } from 'zod';
import { cellIdSchema } from '../directory/registration.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

export const MIGRATION_REASONS = ['residency_change', 'rebalancing', 'promotion_dedicated', 'promotion_sovereign'] as const;
export const MIGRATION_STATUSES = [
  'requested', 'approved', 'scheduled', 'read_only', 'exporting', 'importing', 'verifying', 'reauthorising',
  'directory_updated', 'source_read_only', 'source_purged', 'completed', 'aborted',
] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

export const TENANT_MIGRATION_EVENTS = [
  'tenant_migration_requested', 'tenant_migration_approved', 'tenant_migration_started', 'tenant_migration_completed',
  'tenant_migration_aborted', 'tenant_source_purged',
  // The organisation's directory entry now names this cell (6.7).
  'directory_entry_changed',
] as const;

const category = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'a category such as customer_objected');
const pem = z.string().max(4096).regex(/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/, 'a PEM public key');
const operator = z.strictObject({
  /** The Silo operator acting, as admin-portal authenticated them. */
  operatorId: z.uuid(),
  organisationId: z.uuid(),
});

export const migrationTableView = z.object({
  schema: z.string(),
  table: z.string(),
  sourceRowCount: z.string().nullable(),
  sourceChecksum: z.string().nullable(),
  destinationRowCount: z.string().nullable(),
  destinationChecksum: z.string().nullable(),
  matched: z.boolean().nullable(),
});

export const migrationView = z.object({
  id: z.uuid(),
  sourceCellId: z.string(),
  destinationCellId: z.string(),
  reason: z.enum(MIGRATION_REASONS),
  status: z.enum(MIGRATION_STATUSES),
  /** Whether this cell is where the organisation is moving from, or to. */
  side: z.enum(['source', 'destination']),
  requestedByMembershipId: z.uuid().nullable(),
  requestedByOperatorId: z.uuid().nullable(),
  approvedByMembershipId: z.uuid().nullable(),
  securityOfficerOperatorId: z.uuid().nullable(),
  sovereignSecurityOfficerOperatorId: z.uuid().nullable(),
  contractOperatorId: z.uuid().nullable(),
  noticeGivenAt: z.string().nullable(),
  customerObjectedAt: z.string().nullable(),
  windowStartsAt: z.string().nullable(),
  windowEndsAt: z.string().nullable(),
  moveSiloes: z.boolean(),
  readOnlyAt: z.string().nullable(),
  exportCompletedAt: z.string().nullable(),
  importCompletedAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  directoryUpdatedAt: z.string().nullable(),
  sourceReadOnlyUntil: z.string().nullable(),
  sourcePurgedAt: z.string().nullable(),
  bundleChecksum: z.string().nullable(),
  connectionsPendingReauthorisation: z.int().nullable(),
  abortReason: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type MigrationView = z.infer<typeof migrationView>;

// ----------------------------------------------------------------------------- the customer

/** Where the organisation lives (org.residency.view, any member). */
export const getResidency = defineContract({
  service: 'tenant-migrations', name: 'getResidency', method: 'GET', path: '/v1/residency', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({
    cellId: z.string(),
    residency: z.enum(['uk', 'eu', 'us']),
    kind: z.enum(['commercial', 'sovereign', 'dedicated', 'self_managed']),
    location: z.string(),
    /** The migration under way, if any. */
    migration: migrationView.nullable(),
  }),
});

export const listTenantMigrations = defineContract({
  service: 'tenant-migrations', name: 'listTenantMigrations', method: 'GET', path: '/v1/tenant-migrations', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  response: z.object({ migrations: z.array(migrationView) }),
});

export const getTenantMigration = defineContract({
  service: 'tenant-migrations', name: 'getTenantMigration', method: 'GET', path: '/v1/tenant-migrations/:migrationId', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ migrationId: z.uuid() }),
  response: migrationView.extend({ tables: z.array(migrationTableView) }),
});

/** A super admin asks to move (org.migration.request, not delegable): the request is the customer's written instruction. */
export const requestTenantMigration = defineContract({
  service: 'tenant-migrations', name: 'requestTenantMigration', method: 'POST', path: '/v1/tenant-migrations', callers: ['gateway'],
  // One live migration per organisation (tenant_migrations_live): asking again is refused.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    destinationCellId: cellIdSchema,
    reason: z.enum(['residency_change', 'promotion_dedicated', 'promotion_sovereign']),
  }),
  response: migrationView,
  status: 201,
});

/** The customer's answer to a rebalancing notice (org.migration.approve): approve, or object, which stops it. */
export const respondToRebalancing = defineContract({
  service: 'tenant-migrations', name: 'respondToRebalancing', method: 'POST', path: '/v1/tenant-migrations/:migrationId/response',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ migrationId: z.uuid() }),
  body: z.strictObject({
    decision: z.enum(['approve', 'object']),
    note: z.string().trim().min(1).max(2_000).optional(),
  }),
  response: migrationView,
});

/** The requester's super admin withdraws a request before the window opens. */
export const withdrawTenantMigration = defineContract({
  service: 'tenant-migrations', name: 'withdrawTenantMigration', method: 'POST', path: '/v1/tenant-migrations/:migrationId/withdraw',
  callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ migrationId: z.uuid() }),
  response: migrationView,
});

// ----------------------------------------------------------------------------- Silo operators

/** Silo proposes moving an organisation within its residency, with 30 days' notice. */
export const proposeRebalancing = defineContract({
  service: 'tenant-migrations', name: 'proposeRebalancing', method: 'POST', path: '/v1/tenant-migrations/rebalancing',
  callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  body: operator.extend({ destinationCellId: cellIdSchema }),
  response: migrationView,
  status: 201,
});

/**
 * A Silo signature: the security officer (residency change), the sovereign security officer
 * (sovereign promotion), or the operator confirming the contract (promotions). With every
 * approval the reason needs, the migration is approved.
 */
export const signTenantMigration = defineContract({
  service: 'tenant-migrations', name: 'signTenantMigration', method: 'POST', path: '/v1/tenant-migrations/:migrationId/signatures',
  callers: ['admin-portal'],
  // Signing again as the same role by the same operator changes nothing.
  context: 'none', idempotency: 'none',
  params: z.strictObject({ migrationId: z.uuid() }),
  body: operator.extend({ role: z.enum(['security_officer', 'sovereign_security_officer', 'contract']) }),
  response: migrationView,
});

/** The window, and the destination's import key the export will be sealed to. */
export const scheduleTenantMigration = defineContract({
  service: 'tenant-migrations', name: 'scheduleTenantMigration', method: 'POST', path: '/v1/tenant-migrations/:migrationId/schedule',
  callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ migrationId: z.uuid() }),
  body: operator.extend({
    windowStartsAt: z.iso.datetime({ offset: true }),
    windowEndsAt: z.iso.datetime({ offset: true }),
    destinationKey: pem,
    /** Whether the destination's residency permits Siloes; when not, the organisation must have none. */
    moveSiloes: z.boolean(),
  }),
  response: migrationView,
});

/** Stops a migration before the directory moves. In the source, Actions and Crons resume. */
export const abortTenantMigration = defineContract({
  service: 'tenant-migrations', name: 'abortTenantMigration', method: 'POST', path: '/v1/tenant-migrations/:migrationId/abort',
  callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  params: z.strictObject({ migrationId: z.uuid() }),
  body: operator.extend({ reason: category }),
  response: migrationView,
});

/** This cell's import key, which the operator gives the source when scheduling. */
export const getTenantImportKey = defineContract({
  service: 'tenant-migrations', name: 'getTenantImportKey', method: 'GET', path: '/v1/import-key',
  callers: ['admin-portal'],
  context: 'none', idempotency: 'none',
  response: z.object({ keyId: z.string(), publicKey: z.string() }),
});
