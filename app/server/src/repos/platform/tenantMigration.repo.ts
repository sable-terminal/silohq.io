// Data access for platform.tenant_migrations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  tenantMigrationTable,
  type NewTenantMigration,
  type TenantMigration,
  type TenantMigrationChanges,
} from '../../models/platform/tenantMigration.model.ts';

export const tenantMigrationRepo = {
  insert(db: Queryable, row: NewTenantMigration): Promise<TenantMigration> {
    return insertRow(db, tenantMigrationTable, row);
  },

  findById(db: Queryable, id: TenantMigration['id']): Promise<TenantMigration | undefined> {
    return findRow(db, tenantMigrationTable, { id });
  },

  update(
    db: Queryable,
    id: TenantMigration['id'],
    changes: TenantMigrationChanges,
  ): Promise<TenantMigration | undefined> {
    return updateRow(db, tenantMigrationTable, { id }, changes);
  },

  /** The organisation's migration under way (tenant_migrations_live), if any. */
  async findLive(db: Queryable, organisationId: string): Promise<TenantMigration | undefined> {
    const { rows } = await db.query(
      `select ${tenantMigrationTable.select} from platform.tenant_migrations
       where organisation_id = $1 and status not in ('completed', 'aborted')`, [organisationId]);
    return rows[0] as TenantMigration | undefined;
  },

  async listForOrganisation(db: Queryable, organisationId: string): Promise<TenantMigration[]> {
    const { rows } = await db.query(
      `select ${tenantMigrationTable.select} from platform.tenant_migrations
       where organisation_id = $1 order by created_at desc limit 100`, [organisationId]);
    return rows as TenantMigration[];
  },

  /**
   * Whether writes to the organisation's systems are paused here (spec 6.4: "read-only
   * (Actions and Crons paused)"): in the source from the window until the purge; in the
   * destination until the directory routes the organisation here. Which side this cell is
   * comes from the organisation's own cell.
   */
  async writesPaused(db: Queryable, organisationId: string): Promise<boolean> {
    const { rows } = await db.query(
      `select exists (
         select 1 from platform.tenant_migrations m join iam.organisations o on o.id = m.organisation_id
         where m.organisation_id = $1 and m.status not in ('completed', 'aborted')
           and ((m.source_cell_id = o.cell_id and m.status in ('read_only', 'exporting', 'importing', 'verifying', 'reauthorising',
                                                              'directory_updated', 'source_read_only', 'source_purged'))
             or (m.destination_cell_id = o.cell_id and m.status in ('importing', 'verifying', 'reauthorising')))
       ) as paused`, [organisationId]);
    return (rows[0] as { paused: boolean }).paused;
  },

  /** Every migration this cell has stage work for, across organisations (the migration role). */
  async withWork(db: Queryable, cellId: string): Promise<TenantMigration[]> {
    const { rows } = await db.query(
      `select ${tenantMigrationTable.select} from platform.tenant_migrations
       where (source_cell_id = $1 and status in ('scheduled', 'read_only', 'exporting', 'source_read_only'))
          or (destination_cell_id = $1 and status in ('verifying', 'reauthorising', 'directory_updated', 'source_read_only'))
          or (destination_cell_id = $1 and connections_pending_reauthorisation > 0)
       order by created_at`, [cellId]);
    return rows as TenantMigration[];
  },

  /** Loads in this cell stopped before the directory moved: their rows are removed again (the migration role). */
  async abortedLoads(db: Queryable, cellId: string): Promise<TenantMigration[]> {
    const { rows } = await db.query(
      `select ${tenantMigrationTable.select} from platform.tenant_migrations
       where destination_cell_id = $1 and status = 'aborted' and import_completed_at is not null and directory_updated_at is null`,
      [cellId]);
    return rows as TenantMigration[];
  },

  /** Whether a migration is already in this cell (an inbox bundle loaded before). */
  async exists(db: Queryable, id: string): Promise<boolean> {
    const { rows } = await db.query('select exists (select 1 from platform.tenant_migrations where id = $1) as found', [id]);
    return (rows[0] as { found: boolean }).found;
  },

  /** The organisation's outbox rows not yet published: the export waits for none. */
  async unpublishedEvents(db: Queryable, organisationId: string): Promise<number> {
    const { rows } = await db.query(
      `select count(*)::int as n from platform.outbox
       where organisation_id = $1 and published_at is null and dead_lettered_at is null`, [organisationId]);
    return (rows[0] as { n: number }).n;
  },
};

