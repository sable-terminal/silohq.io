// Asking, approving, scheduling and stopping a tenant migration (spec 6.4, 6.7). The
// permission each customer route needs is checked at the gateway (org.migration.request,
// org.migration.approve, org.residency.view); here are the rules of the migration itself.

import { tenantImportKey } from '../../contracts/credential/tenantKeys.contract.ts';
import type { MigrationView } from '../../contracts/tenant-migrations/migration.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { Cell, TenantMigration } from '../../models/platform/index.model.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { cellRepo, operatorRepo, tenantMigrationRepo, tenantMigrationTableRepo } from '../../repos/platform/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { canonicalImportKey, importKeyId } from '../../utils/importKey.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { DAY_MS, nowOf, recordEvent, view, type Context, type TenantMigrationsDeps } from './deps.service.ts';
import { checkSiloesMayStay, Refusal } from './transfer.service.ts';

type Reason = TenantMigration['reason'];

const notFound = (): AppError => new AppError('not_found', 'no such migration', { code: 'tenant_migrations.not_found' });
const conflict = (code: string, message: string): AppError => new AppError('conflict', message, { code: `tenant_migrations.${code}` });

/** Every approval the reason needs (spec 6.4), given the operator signatures so far. */
export function approvalsComplete(m: Pick<TenantMigration, 'reason' | 'approvedByMembershipId' | 'securityOfficerOperatorId'
  | 'sovereignSecurityOfficerOperatorId' | 'contractOperatorId' | 'noticeGivenAt' | 'customerObjectedAt'>): boolean {
  switch (m.reason) {
    case 'residency_change': return m.approvedByMembershipId !== null && m.securityOfficerOperatorId !== null;
    case 'promotion_dedicated': return m.approvedByMembershipId !== null && m.contractOperatorId !== null;
    case 'promotion_sovereign':
      return m.approvedByMembershipId !== null && m.contractOperatorId !== null && m.sovereignSecurityOfficerOperatorId !== null;
    case 'rebalancing': return m.noticeGivenAt !== null && m.customerObjectedAt === null;
  }
}

/** Placement rules for a destination (spec 6.4): never across residency to find capacity. */
function checkDestination(reason: Reason, source: Cell, destination: Cell | undefined): Cell {
  if (destination === undefined) throw new AppError('validation', 'no such cell', { code: 'tenant_migrations.unknown_cell' });
  if (destination.id === source.id) throw new AppError('validation', 'the organisation is already in that cell', { code: 'tenant_migrations.same_cell' });
  if (destination.status !== 'active' && destination.status !== 'closed_to_placement') {
    throw conflict('cell_unavailable', 'that cell is not taking organisations');
  }
  const refuse = (message: string) => { throw new AppError('validation', message, { code: 'tenant_migrations.destination_refused' }); };
  if (reason === 'residency_change' && destination.residency === source.residency) refuse('a residency change goes to another residency');
  if (reason === 'rebalancing' && (destination.residency !== source.residency || destination.kind !== source.kind)) {
    refuse('rebalancing stays within the residency and the kind of cell');
  }
  if (reason === 'promotion_dedicated' && destination.kind !== 'dedicated') refuse('a dedicated promotion goes to a dedicated cell');
  if (reason === 'promotion_sovereign' && destination.kind !== 'sovereign') refuse('a sovereign promotion goes to the sovereign cell');
  // "Data never moves from the sovereign cell to a commercial cell without the customer's written instruction."
  if (source.kind === 'sovereign' && destination.kind !== 'sovereign' && reason !== 'residency_change') {
    refuse('leaving the sovereign cell needs the customer\'s own written instruction');
  }
  return destination;
}

export function createRequests(deps: TenantMigrationsDeps) {
  const control = deps.databases.pool('control');
  const tx = <T>(organisationId: string, work: (db: Queryable) => Promise<T>) => inTransaction(control, { organisationId }, work);
  const asView = (row: TenantMigration): MigrationView => view(row, deps.cellId);

  function requireDirectory(): void {
    if (!deps.directory) {
      throw conflict('no_directory', 'this cell has no directory, which routes a moved organisation: it cannot move one');
    }
  }

  async function placed(db: Queryable, organisationId: string): Promise<Cell> {
    const organisation = await organisationRepo.findById(db, organisationId);
    if (organisation === undefined) throw new AppError('not_found', 'no such organisation', { code: 'tenant_migrations.organisation_unknown' });
    if (organisation.cellId !== deps.cellId) throw conflict('not_here', 'the organisation is not in this cell');
    return (await cellRepo.findById(db, organisation.cellId))!;
  }

  async function mine(db: Queryable, migrationId: string): Promise<TenantMigration> {
    const row = await tenantMigrationRepo.findById(db, migrationId);
    if (row === undefined) throw notFound();
    return row;
  }

  async function insert(db: Queryable, row: Parameters<typeof tenantMigrationRepo.insert>[1]): Promise<TenantMigration> {
    try {
      return await tenantMigrationRepo.insert(db, row);
    } catch (error) {
      if (fromDatabaseError(error).category === 'conflict') throw conflict('already_live', 'the organisation already has a migration under way');
      throw error;
    }
  }

  async function operatorOf(db: Queryable, operatorId: string) {
    const found = await operatorRepo.findById(db, operatorId);
    if (found === undefined || found.status !== 'active') throw new AppError('forbidden', 'no such active operator', { code: 'tenant_migrations.operator_unknown' });
    return found;
  }

  /** Approved once every approval is in; rebalancing records its approval event when scheduled. */
  async function advanceIfApproved(db: Queryable, row: TenantMigration, correlationId: string): Promise<TenantMigration> {
    if (row.status !== 'requested' || row.reason === 'rebalancing' || !approvalsComplete(row)) return row;
    const approved = (await tenantMigrationRepo.update(db, row.id, { status: 'approved' }))!;
    await recordEvent(db, { organisationId: row.organisationId, correlationId, event: 'tenant_migration_approved', migrationId: row.id,
      detail: { reason: row.reason, destination_cell_id: row.destinationCellId } });
    return approved;
  }

  return {
    async residency(ctx: Context) {
      const organisationId = ctx.request.organisationId!;
      return tx(organisationId, async (db) => {
        const organisation = (await organisationRepo.findById(db, organisationId))!;
        const cell = (await cellRepo.findById(db, organisation.cellId))!;
        const live = await tenantMigrationRepo.findLive(db, organisationId);
        return { cellId: cell.id, residency: cell.residency, kind: cell.kind, location: cell.location, migration: live ? asView(live) : null };
      });
    },

    async list(ctx: Context) {
      const organisationId = ctx.request.organisationId!;
      return { migrations: (await tx(organisationId, (db) => tenantMigrationRepo.listForOrganisation(db, organisationId))).map(asView) };
    },

    async get(ctx: Context, migrationId: string) {
      return tx(ctx.request.organisationId!, async (db) => {
        const row = await mine(db, migrationId);
        const tables = await tenantMigrationTableRepo.listForMigration(db, migrationId);
        const hex = (b: Buffer | null) => (b === null ? null : b.toString('hex'));
        return {
          ...asView(row),
          tables: tables.map((t) => ({
            schema: t.schemaName, table: t.tableName, sourceRowCount: t.sourceRowCount, sourceChecksum: hex(t.sourceChecksum),
            destinationRowCount: t.destinationRowCount, destinationChecksum: hex(t.destinationChecksum), matched: t.matched,
          })),
        };
      });
    },

    /** The super admin's request is the customer's written instruction, and so their approval. */
    async request(ctx: Context, input: { destinationCellId: string; reason: Exclude<Reason, 'rebalancing'> }) {
      const organisationId = ctx.request.organisationId!;
      const membershipId = ctx.request.membershipId!;
      requireDirectory();
      return tx(organisationId, async (db) => {
        const source = await placed(db, organisationId);
        const destination = checkDestination(input.reason, source, await cellRepo.findById(db, input.destinationCellId));
        const row = await insert(db, {
          id: uuidv7(), organisationId, sourceCellId: source.id, destinationCellId: destination.id, reason: input.reason,
          requestedByMembershipId: membershipId, approvedByMembershipId: membershipId,
        });
        await recordEvent(db, { organisationId, correlationId: ctx.correlationId, event: 'tenant_migration_requested', migrationId: row.id,
          membershipId, detail: { reason: input.reason, source_cell_id: source.id, destination_cell_id: destination.id } });
        return asView(row);
      });
    },

    /** Rebalancing: approve, or object, which stops it (spec 6.4: "customer may object"). */
    async respond(ctx: Context, migrationId: string, input: { decision: 'approve' | 'object'; note?: string | undefined }) {
      const organisationId = ctx.request.organisationId!;
      const membershipId = ctx.request.membershipId!;
      return tx(organisationId, async (db) => {
        const row = await mine(db, migrationId);
        if (row.reason !== 'rebalancing') throw conflict('not_rebalancing', 'only a rebalancing is answered this way');
        if (!['requested', 'approved', 'scheduled'].includes(row.status)) throw conflict('too_late', 'the migration has started');
        if (input.decision === 'approve') {
          const updated = (await tenantMigrationRepo.update(db, row.id, { approvedByMembershipId: membershipId }))!;
          return asView(updated);
        }
        const at = nowOf(deps).toISOString();
        const stopped = (await tenantMigrationRepo.update(db, row.id, {
          customerObjectedAt: at, objectionNote: input.note ?? null, status: 'aborted', abortedAt: at, abortReason: 'customer_objected',
        }))!;
        await recordEvent(db, { organisationId, correlationId: ctx.correlationId, event: 'tenant_migration_aborted', migrationId: row.id,
          membershipId, detail: { reason: 'customer_objected' } });
        return asView(stopped);
      });
    },

    async withdraw(ctx: Context, migrationId: string) {
      const organisationId = ctx.request.organisationId!;
      return tx(organisationId, async (db) => {
        const row = await mine(db, migrationId);
        if (row.reason === 'rebalancing') throw conflict('not_withdrawable', 'object to a rebalancing instead');
        if (!['requested', 'approved', 'scheduled'].includes(row.status)) throw conflict('too_late', 'the migration has started');
        const at = nowOf(deps).toISOString();
        const stopped = (await tenantMigrationRepo.update(db, row.id, { status: 'aborted', abortedAt: at, abortReason: 'withdrawn' }))!;
        await recordEvent(db, { organisationId, correlationId: ctx.correlationId, event: 'tenant_migration_aborted', migrationId: row.id,
          membershipId: ctx.request.membershipId, detail: { reason: 'withdrawn' } });
        return asView(stopped);
      });
    },

    // ----------------------------------------------------------------------------- operators

    async proposeRebalancing(correlationId: string, input: { operatorId: string; organisationId: string; destinationCellId: string }) {
      requireDirectory();
      return tx(input.organisationId, async (db) => {
        await operatorOf(db, input.operatorId);
        const source = await placed(db, input.organisationId);
        const destination = checkDestination('rebalancing', source, await cellRepo.findById(db, input.destinationCellId));
        const row = await insert(db, {
          id: uuidv7(), organisationId: input.organisationId, sourceCellId: source.id, destinationCellId: destination.id, reason: 'rebalancing',
          requestedByOperatorId: input.operatorId, noticeGivenAt: nowOf(deps).toISOString(),
        });
        await recordEvent(db, { organisationId: input.organisationId, correlationId, event: 'tenant_migration_requested', migrationId: row.id,
          detail: { reason: 'rebalancing', operator_id: input.operatorId, source_cell_id: source.id, destination_cell_id: destination.id } });
        return asView(row);
      });
    },

    async sign(correlationId: string, migrationId: string, input: {
      operatorId: string; organisationId: string; role: 'security_officer' | 'sovereign_security_officer' | 'contract';
    }) {
      return tx(input.organisationId, async (db) => {
        const operator = await operatorOf(db, input.operatorId);
        const row = await mine(db, migrationId);
        if (row.status !== 'requested') throw conflict('not_awaiting', 'the migration is not awaiting approval');
        if (input.role === 'security_officer' && row.reason !== 'residency_change') throw conflict('not_needed', 'only a residency change needs the security officer');
        if (input.role === 'sovereign_security_officer') {
          if (row.reason !== 'promotion_sovereign') throw conflict('not_needed', 'only a sovereign promotion needs the sovereign security officer');
          if (!operator.sovereignAccessListed) throw new AppError('forbidden', 'the sovereign security officer is on the sovereign access list', { code: 'tenant_migrations.not_sovereign_listed' });
        }
        if (input.role === 'contract' && !['promotion_dedicated', 'promotion_sovereign'].includes(row.reason)) {
          throw conflict('not_needed', 'only a promotion needs a contract');
        }
        const signed = (await tenantMigrationRepo.update(db, row.id, input.role === 'security_officer'
          ? { securityOfficerOperatorId: input.operatorId }
          : input.role === 'sovereign_security_officer' ? { sovereignSecurityOfficerOperatorId: input.operatorId } : { contractOperatorId: input.operatorId }))!;
        return asView(await advanceIfApproved(db, signed, correlationId));
      });
    },

    async schedule(correlationId: string, migrationId: string, input: {
      operatorId: string; organisationId: string; windowStartsAt: string; windowEndsAt: string; destinationKey: string; moveSiloes: boolean;
    }) {
      const publicKey = canonicalImportKey(input.destinationKey);
      if (!input.moveSiloes) {
        try {
          await checkSiloesMayStay(deps, input.organisationId);
        } catch (error) {
          if (error instanceof Refusal) throw conflict(error.refusedFor, error.message);
          throw error;
        }
      }
      return tx(input.organisationId, async (db) => {
        await operatorOf(db, input.operatorId);
        let row = await mine(db, migrationId);
        if (row.sourceCellId !== deps.cellId) throw conflict('not_source', 'a migration is scheduled in its source cell');
        const startsAt = Date.parse(input.windowStartsAt);
        if (Date.parse(input.windowEndsAt) <= startsAt) throw new AppError('validation', 'the window ends after it starts', { code: 'tenant_migrations.window' });
        if (row.reason === 'rebalancing') {
          if (row.status !== 'requested' && row.status !== 'approved') throw conflict('not_approved', 'the migration is not awaiting a window');
          if (startsAt < Date.parse(row.noticeGivenAt!) + 30 * DAY_MS) {
            throw new AppError('validation', 'rebalancing gives 30 days\' notice before its window', { code: 'tenant_migrations.notice' });
          }
          if (row.status === 'requested') {
            row = (await tenantMigrationRepo.update(db, row.id, { status: 'approved' }))!;
            await recordEvent(db, { organisationId: row.organisationId, correlationId, event: 'tenant_migration_approved', migrationId: row.id,
              detail: { reason: 'rebalancing', customer_approved: row.approvedByMembershipId !== null } });
          }
        } else if (row.status !== 'approved') {
          throw conflict('not_approved', 'the migration needs every approval first');
        }
        const scheduled = (await tenantMigrationRepo.update(db, row.id, {
          status: 'scheduled', windowStartsAt: input.windowStartsAt, windowEndsAt: input.windowEndsAt,
          destinationImportKey: publicKey, destinationKeyId: importKeyId(publicKey), moveSiloes: input.moveSiloes,
        }))!;
        return asView(scheduled);
      });
    },

    /** Stops the migration before the directory moves. A load already in this cell is removed by the stage sweep. */
    async abort(correlationId: string, migrationId: string, input: { operatorId: string; organisationId: string; reason: string }) {
      return tx(input.organisationId, async (db) => {
        await operatorOf(db, input.operatorId);
        const row = await mine(db, migrationId);
        const source = row.sourceCellId === deps.cellId;
        const open = source
          ? ['requested', 'approved', 'scheduled', 'read_only', 'exporting'].includes(row.status) && row.directoryUpdatedAt === null
          : ['verifying', 'reauthorising'].includes(row.status);
        if (!open) throw conflict('too_late', 'the migration is past the point it can be stopped here');
        const at = nowOf(deps).toISOString();
        const stopped = (await tenantMigrationRepo.update(db, row.id, { status: 'aborted', abortedAt: at, abortReason: input.reason }))!;
        await recordEvent(db, { organisationId: row.organisationId, correlationId, event: 'tenant_migration_aborted', migrationId: row.id,
          detail: { reason: input.reason, operator_id: input.operatorId, side: source ? 'source' : 'destination' } });
        return asView(stopped);
      });
    },

    async importKey(correlationId: string) {
      return deps.services.call(tenantImportKey, {}, { correlationId });
    },
  };
}

export type Requests = ReturnType<typeof createRequests>;
