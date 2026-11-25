// Data access for platform.tenant_migration_tables, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  tenantMigrationTableTable,
  type NewTenantMigrationTable,
  type TenantMigrationTable,
  type TenantMigrationTableChanges,
} from '../../models/platform/tenantMigrationTable.model.ts';

export const tenantMigrationTableRepo = {
  insert(db: Queryable, row: NewTenantMigrationTable): Promise<TenantMigrationTable> {
    return insertRow(db, tenantMigrationTableTable, row);
  },

  findById(db: Queryable, id: TenantMigrationTable['id']): Promise<TenantMigrationTable | undefined> {
    return findRow(db, tenantMigrationTableTable, { id });
  },

  findByMigrationIdAndSchemaNameAndTableName(
    db: Queryable,
    key: Pick<TenantMigrationTable, 'organisationId' | 'migrationId' | 'schemaName' | 'tableName'>,
  ): Promise<TenantMigrationTable | undefined> {
    return findRow(db, tenantMigrationTableTable, key);
  },

  update(
    db: Queryable,
    id: TenantMigrationTable['id'],
    changes: TenantMigrationTableChanges,
  ): Promise<TenantMigrationTable | undefined> {
    return updateRow(db, tenantMigrationTableTable, { id }, changes);
  },

  async listForMigration(db: Queryable, migrationId: string): Promise<TenantMigrationTable[]> {
    const { rows } = await db.query(
      `select ${tenantMigrationTableTable.select} from platform.tenant_migration_tables
       where migration_id = $1 order by schema_name, table_name`, [migrationId]);
    return rows as TenantMigrationTable[];
  },
};
