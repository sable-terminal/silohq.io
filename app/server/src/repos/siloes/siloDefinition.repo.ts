// Data access for siloes.silo_definitions, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  siloDefinitionTable,
  type NewSiloDefinition,
  type SiloDefinition,
  type SiloDefinitionChanges,
} from '../../models/siloes/siloDefinition.model.ts';

export const siloDefinitionRepo = {
  insert(db: Queryable, row: NewSiloDefinition): Promise<SiloDefinition> {
    return insertRow(db, siloDefinitionTable, row);
  },

  findById(db: Queryable, id: SiloDefinition['id']): Promise<SiloDefinition | undefined> {
    return findRow(db, siloDefinitionTable, { id });
  },

  findBySiloIdAndVersion(
    db: Queryable,
    key: Pick<SiloDefinition, 'organisationId' | 'siloId' | 'version'>,
  ): Promise<SiloDefinition | undefined> {
    return findRow(db, siloDefinitionTable, key);
  },

  update(
    db: Queryable,
    id: SiloDefinition['id'],
    changes: SiloDefinitionChanges,
  ): Promise<SiloDefinition | undefined> {
    return updateRow(db, siloDefinitionTable, { id }, changes);
  },

  async listForSilo(db: Queryable, siloId: string): Promise<SiloDefinition[]> {
    const { rows } = await db.query(`select ${siloDefinitionTable.select} from siloes.silo_definitions where silo_id = $1 order by version desc`, [siloId]);
    return rows as SiloDefinition[];
  },
};
