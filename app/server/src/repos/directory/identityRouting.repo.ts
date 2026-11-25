// Data access for directory.identity_routing, in plain SQL through base.repo.ts; no ORM.
// Read by directory_writer, directory_reader; written by directory_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  identityRoutingTable,
  type IdentityRouting,
  type IdentityRoutingChanges,
  type IdentityRoutingPrimaryKey,
  type NewIdentityRouting,
} from '../../models/directory/identityRouting.model.ts';

export const identityRoutingRepo = {
  insert(db: Queryable, row: NewIdentityRouting): Promise<IdentityRouting> {
    return insertRow(db, identityRoutingTable, row);
  },

  findByKey(db: Queryable, key: IdentityRoutingPrimaryKey): Promise<IdentityRouting | undefined> {
    return findRow(db, identityRoutingTable, key);
  },

  update(
    db: Queryable,
    key: IdentityRoutingPrimaryKey,
    changes: IdentityRoutingChanges,
  ): Promise<IdentityRouting | undefined> {
    return updateRow(db, identityRoutingTable, key, changes);
  },

  /** Registers a route; true when it was new. Registering it again changes nothing. */
  async insertIfAbsent(db: Queryable, row: NewIdentityRouting): Promise<boolean> {
    const { rowCount } = await db.query(
      `insert into directory.identity_routing (email_hash, cell_id, hash_key_version) values ($1, $2, $3)
       on conflict (email_hash, cell_id) do nothing`,
      [row.emailHash, row.cellId, row.hashKeyVersion]);
    return rowCount === 1;
  },

  /** The cells an address routes to, given its hash under each key version; retired cells excluded. */
  async cellsForHashes(db: Queryable, emailHashes: readonly Buffer[]): Promise<string[]> {
    const { rows } = await db.query(
      `select distinct r.cell_id as "cellId" from directory.identity_routing r
       join directory.cells c on c.id = r.cell_id
       where r.email_hash = any($1::bytea[]) and c.status <> 'retired'
       order by 1`,
      [emailHashes]);
    return rows.map((row: { cellId: string }) => row.cellId);
  },
};
