// Data access for ontology.property_identities, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  propertyIdentityTable,
  type NewPropertyIdentity,
  type PropertyIdentity,
} from '../../models/ontology/propertyIdentity.model.ts';

export const propertyIdentityRepo = {
  insert(db: Queryable, row: NewPropertyIdentity): Promise<PropertyIdentity> {
    return insertRow(db, propertyIdentityTable, row);
  },

  findById(db: Queryable, id: PropertyIdentity['id']): Promise<PropertyIdentity | undefined> {
    return findRow(db, propertyIdentityTable, { id });
  },

  /** Inserts the identities not yet known; a property keeps its identity across type versions. */
  async ensure(db: Queryable, rows: readonly { id: string; organisationId: string; objectTypeId: string }[]): Promise<void> {
    if (rows.length === 0) return;
    await db.query(
      `insert into ontology.property_identities (id, organisation_id, object_type_id)
       select * from unnest($1::uuid[], $2::uuid[], $3::uuid[]) on conflict (id) do nothing`,
      [rows.map((r) => r.id), rows.map((r) => r.organisationId), rows.map((r) => r.objectTypeId)]);
  },
};
