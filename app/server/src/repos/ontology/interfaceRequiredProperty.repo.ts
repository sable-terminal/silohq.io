// Data access for ontology.interface_required_properties, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  interfaceRequiredPropertyTable,
  type InterfaceRequiredProperty,
  type InterfaceRequiredPropertyChanges,
  type NewInterfaceRequiredProperty,
} from '../../models/ontology/interfaceRequiredProperty.model.ts';

export const interfaceRequiredPropertyRepo = {
  insert(db: Queryable, row: NewInterfaceRequiredProperty): Promise<InterfaceRequiredProperty> {
    return insertRow(db, interfaceRequiredPropertyTable, row);
  },

  findById(
    db: Queryable,
    id: InterfaceRequiredProperty['id'],
  ): Promise<InterfaceRequiredProperty | undefined> {
    return findRow(db, interfaceRequiredPropertyTable, { id });
  },

  update(
    db: Queryable,
    id: InterfaceRequiredProperty['id'],
    changes: InterfaceRequiredPropertyChanges,
  ): Promise<InterfaceRequiredProperty | undefined> {
    return updateRow(db, interfaceRequiredPropertyTable, { id }, changes);
  },

  async liveForInterface(db: Queryable, interfaceId: string): Promise<InterfaceRequiredProperty[]> {
    const { rows } = await db.query(
      `select ${interfaceRequiredPropertyTable.select} from ontology.interface_required_properties
        where interface_id = $1 and removed_at is null`, [interfaceId]);
    return rows as InterfaceRequiredProperty[];
  },
};
