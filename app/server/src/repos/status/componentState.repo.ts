// Data access for status.component_states, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, status_writer; written by status_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  componentStateTable,
  type ComponentState,
  type ComponentStateChanges,
  type ComponentStatePrimaryKey,
  type NewComponentState,
} from '../../models/status/componentState.model.ts';

export const componentStateRepo = {
  insert(db: Queryable, row: NewComponentState): Promise<ComponentState> {
    return insertRow(db, componentStateTable, row);
  },

  findByKey(db: Queryable, key: ComponentStatePrimaryKey): Promise<ComponentState | undefined> {
    return findRow(db, componentStateTable, key);
  },

  update(
    db: Queryable,
    key: ComponentStatePrimaryKey,
    changes: ComponentStateChanges,
  ): Promise<ComponentState | undefined> {
    return updateRow(db, componentStateTable, key, changes);
  },

  remove(db: Queryable, key: ComponentStatePrimaryKey): Promise<boolean> {
    return deleteRow(db, componentStateTable, key);
  },

  async listByCell(db: Queryable, cellId: ComponentState['cellId']): Promise<ComponentState[]> {
    const { rows } = await db.query(
      `select ${componentStateTable.select} from status.component_states where cell_id = $1 order by component`, [cellId]);
    return rows as ComponentState[];
  },

  async list(db: Queryable): Promise<ComponentState[]> {
    const { rows } = await db.query(`select ${componentStateTable.select} from status.component_states order by cell_id, component`);
    return rows as ComponentState[];
  },

  /** A report's components replace the cell's: every row is rewritten, and the ones it left out go. */
  async replace(db: Queryable, cellId: ComponentState['cellId'], states: readonly Omit<NewComponentState, 'cellId'>[]): Promise<void> {
    await db.query('delete from status.component_states where cell_id = $1', [cellId]);
    for (const state of states) {
      await db.query('insert into status.component_states (cell_id, component, state, since) values ($1, $2, $3, $4)',
        [cellId, state.component, state.state, state.since]);
    }
  },
};
