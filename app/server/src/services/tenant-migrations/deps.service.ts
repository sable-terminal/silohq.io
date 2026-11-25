// What every part of tenant-migrations shares: its dependencies, the view of a migration,
// the audit events, and where bundles and receipts sit in object-backup.

import type { AuditActor } from '../../contracts/audit/auditEvent.contract.ts';
import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import type { MigrationView, TENANT_MIGRATION_EVENTS } from '../../contracts/tenant-migrations/migration.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { objectKey, type ObjectKey, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import { inTransaction, type createPool, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { ServiceClient } from '../../infra/serviceClient.infra.ts';
import type { TenantMigration } from '../../models/platform/index.model.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { tenantDataRepo } from '../../repos/platform/tenantData.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

/** "source read-only 30 days" (spec 6.4). */
export const READ_ONLY_DAYS = 30;
export const DAY_MS = 86_400_000;
/**
 * How long after the window opens the export waits, so a write admitted just before it (the
 * gateway refuses every one after, spec 6.4) has finished: the longest request bound a cell
 * may configure (HTTP_REQUEST_TIMEOUT_MS, at most ten minutes) and a minute more.
 */
export const WRITES_SETTLE_MS = 11 * 60_000;
/** Connections halted in the destination until someone re-authorises them. */
export const REAUTHORISE_REASON = 'tenant_migration';

export interface TenantMigrationsDeps {
  /** The application role: requests, and the export under the organisation's context. */
  databases: Databases;
  /** The platform workers' migration login: loads, purges and the cross-organisation stage sweep. */
  migrate: ReturnType<typeof createPool>;
  objects: ObjectStore;
  /** Rows fetched from a table's cursor at a time during the export and the verification (default ROW_BATCH). */
  rowBatch?: number;
  services: ServiceClient;
  logger: Logger;
  /** This cell. */
  cellId: string;
  /** Whether this cell reaches the directory: without it no organisation can move (the directory routes the move). */
  directory: boolean;
  now?: () => Date;
}

export const nowOf = (deps: Pick<TenantMigrationsDeps, 'now'>): Date => deps.now?.() ?? new Date();

/** Work as silo_migrate, in one transaction. */
export function asMigrate<T>(deps: Pick<TenantMigrationsDeps, 'migrate'>, work: (db: Queryable) => Promise<T>): Promise<T> {
  return inTransaction(deps.migrate, {}, async (db) => {
    await tenantDataRepo.actAsMigrate(db);
    return work(db);
  });
}

export const bundleKey = (migrationId: string): ObjectKey => objectKey.cell('tenant-migrations', migrationId, 'bundle');
export const purgeReceiptKey = (migrationId: string): ObjectKey => objectKey.cell('tenant-migrations', migrationId, 'purge-receipt.json');
export const refusalKey = (migrationId: string): ObjectKey => objectKey.cell('tenant-migrations', migrationId, 'import-refused.json');
export const INBOX = objectKey.cell('tenant-migrations');

const hex = (value: Buffer | null): string | null => (value === null ? null : value.toString('hex'));

export function view(row: TenantMigration, cellId: string): MigrationView {
  return {
    id: row.id, sourceCellId: row.sourceCellId, destinationCellId: row.destinationCellId, reason: row.reason, status: row.status,
    side: row.sourceCellId === cellId ? 'source' : 'destination',
    requestedByMembershipId: row.requestedByMembershipId, requestedByOperatorId: row.requestedByOperatorId,
    approvedByMembershipId: row.approvedByMembershipId, securityOfficerOperatorId: row.securityOfficerOperatorId,
    sovereignSecurityOfficerOperatorId: row.sovereignSecurityOfficerOperatorId, contractOperatorId: row.contractOperatorId,
    noticeGivenAt: row.noticeGivenAt, customerObjectedAt: row.customerObjectedAt, windowStartsAt: row.windowStartsAt,
    windowEndsAt: row.windowEndsAt, moveSiloes: row.moveSiloes, readOnlyAt: row.readOnlyAt, exportCompletedAt: row.exportCompletedAt,
    importCompletedAt: row.importCompletedAt, verifiedAt: row.verifiedAt, directoryUpdatedAt: row.directoryUpdatedAt,
    sourceReadOnlyUntil: row.sourceReadOnlyUntil, sourcePurgedAt: row.sourcePurgedAt, bundleChecksum: hex(row.bundleChecksum),
    connectionsPendingReauthorisation: row.connectionsPendingReauthorisation, abortReason: row.abortReason,
    completedAt: row.completedAt, createdAt: row.createdAt,
  };
}

export type MigrationEvent = (typeof TENANT_MIGRATION_EVENTS)[number];

/** A tenancy audit event (spec 6.7), through the outbox in the same transaction. */
export async function recordEvent(db: Queryable, e: {
  organisationId: string; correlationId: string; event: MigrationEvent; migrationId: string;
  /** The super admin who acted; otherwise this service (operators act through admin-portal, named in detail). */
  membershipId?: string | undefined;
  detail: Record<string, string | number | boolean | null>;
}): Promise<void> {
  const actor: AuditActor = e.membershipId !== undefined
    ? { kind: 'membership', membershipId: e.membershipId }
    : { kind: 'service', service: 'tenant-migrations' };
  const payload = auditEventMessage.schema.parse({
    event: e.event, actor, subjectMembershipId: null, scopeId: null, resource: { type: 'tenant_migration', id: e.migrationId },
    purposeSessionId: null, operatorAccessSessionId: null, ipHash: null, detail: e.detail,
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: e.organisationId, topic: auditEventMessage.topic, orderingKey: e.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId: e.correlationId,
  });
}
