// Data access for directory.cells, in plain SQL through base.repo.ts; no ORM.
// Read by directory_writer, directory_reader; written by directory_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import { cellTable, type Cell, type CellChanges, type NewCell } from '../../models/directory/cell.model.ts';

export const cellRepo = {
  insert(db: Queryable, row: NewCell): Promise<Cell> {
    return insertRow(db, cellTable, row);
  },

  findById(db: Queryable, id: Cell['id']): Promise<Cell | undefined> {
    return findRow(db, cellTable, { id });
  },

  findByHostname(db: Queryable, hostname: Cell['hostname']): Promise<Cell | undefined> {
    return findRow(db, cellTable, { hostname });
  },

  update(db: Queryable, id: Cell['id'], changes: CellChanges): Promise<Cell | undefined> {
    return updateRow(db, cellTable, { id }, changes);
  },

  /** Every cell, by identifier. The registry is small (one row per cell). */
  /**
   * Where a sign-up may be placed (spec 6.4): the residency's shared commercial cells whose
   * status is active (closed_to_placement is how a cell stops taking organisations) and below
   * both placement limits (spec 6.3: its live organisations, its connections as last reported),
   * the one with the most headroom (fewest live organisations) first.
   */
  async placementCandidates(db: Queryable, residency: string, limits: { organisations: number; connections: number }): Promise<(Cell & { organisations: number })[]> {
    const { rows } = await db.query(
      `select ${cellTable.select.split(', ').map((c) => `c.${c}`).join(', ')},
              (select count(*)::int from directory.organisation_directory o where o.cell_id = c.id and o.status <> 'closed') as organisations
         from directory.cells c
        where c.residency = $1 and c.kind = 'commercial' and c.status = 'active' and c.connection_count < $3
          and (select count(*) from directory.organisation_directory o where o.cell_id = c.id and o.status <> 'closed') < $2
        order by organisations, c.id`, [residency, limits.organisations, limits.connections]);
    return rows as (Cell & { organisations: number })[];
  },

  /** Each cell in service with its live organisations and its connections as last reported (spec 6.3; D203). */
  async capacity(db: Queryable): Promise<(Cell & { organisations: number })[]> {
    const { rows } = await db.query(
      `select ${cellTable.select.split(', ').map((c) => `c.${c}`).join(', ')},
              (select count(*)::int from directory.organisation_directory o where o.cell_id = c.id and o.status <> 'closed') as organisations
         from directory.cells c where c.status in ('provisioning', 'active', 'closed_to_placement', 'draining') order by c.id`);
    return rows as (Cell & { organisations: number })[];
  },

  /** Whether placement is open, as fleet-control's capacity check finds it (D207). True where it changed. */
  async setPlacementOpen(db: Queryable, id: Cell['id'], open: boolean): Promise<boolean> {
    const result = await db.query('update directory.cells set placement_open = $2 where id = $1 and placement_open is distinct from $2', [id, open]);
    return (result.rowCount ?? 0) > 0;
  },

  async list(db: Queryable): Promise<Cell[]> {
    const { rows } = await db.query(`select ${cellTable.select} from directory.cells order by id`);
    return rows as Cell[];
  },

  /** The cell, locked until the transaction ends, so concurrent registrations serialise. */
  async findForUpdate(db: Queryable, id: Cell['id']): Promise<Cell | undefined> {
    const { rows } = await db.query(`select ${cellTable.select} from directory.cells where id = $1 for update`, [id]);
    return rows[0] as Cell | undefined;
  },
};
