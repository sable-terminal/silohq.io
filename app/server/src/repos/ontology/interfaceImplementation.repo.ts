// Data access for ontology.interface_implementations, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  interfaceImplementationTable,
  type InterfaceImplementation,
  type NewInterfaceImplementation,
} from '../../models/ontology/interfaceImplementation.model.ts';

export const interfaceImplementationRepo = {
  insert(db: Queryable, row: NewInterfaceImplementation): Promise<InterfaceImplementation> {
    return insertRow(db, interfaceImplementationTable, row);
  },

  findById(db: Queryable, id: InterfaceImplementation['id']): Promise<InterfaceImplementation | undefined> {
    return findRow(db, interfaceImplementationTable, { id });
  },

  findByInterfaceIdAndObjectTypeVersionId(
    db: Queryable,
    key: Pick<InterfaceImplementation, 'organisationId' | 'interfaceId' | 'objectTypeVersionId'>,
  ): Promise<InterfaceImplementation | undefined> {
    return findRow(db, interfaceImplementationTable, key);
  },

  /** The rows of these object type versions. */
  async listForVersions(db: Queryable, typeVersionIds: readonly string[]): Promise<InterfaceImplementation[]> {
    if (typeVersionIds.length === 0) return [];
    const { rows } = await db.query(
      `select ${interfaceImplementationTable.select} from ontology.interface_implementations where object_type_version_id = any($1::uuid[])`, [typeVersionIds]);
    return rows as InterfaceImplementation[];
  },
};
