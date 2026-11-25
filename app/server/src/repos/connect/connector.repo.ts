// Data access for connect.connectors, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  connectorTable,
  type Connector,
  type ConnectorChanges,
  type NewConnector,
} from '../../models/connect/connector.model.ts';

export const connectorRepo = {
  insert(db: Queryable, row: NewConnector): Promise<Connector> {
    return insertRow(db, connectorTable, row);
  },

  findById(db: Queryable, id: Connector['id']): Promise<Connector | undefined> {
    return findRow(db, connectorTable, { id });
  },

  update(db: Queryable, id: Connector['id'], changes: ConnectorChanges): Promise<Connector | undefined> {
    return updateRow(db, connectorTable, { id }, changes);
  },

  /** Global catalogue rows and this organisation's own, as row-level security shows them. Withdrawn rows are left out. */
  async listVisible(db: Queryable, limit: number): Promise<Connector[]> {
    const { rows } = await db.query(
      `select ${connectorTable.select} from connect.connectors where status <> 'withdrawn'
       order by organisation_id nulls first, name, id limit $1`, [limit]);
    return rows as Connector[];
  },

  /**
   * The catalogue as this organisation sees it (row-level security: global rows and its
   * own), filtered by trust tier, kind and a name search. The search is a plain substring,
   * never a pattern.
   */
  async browse(db: Queryable, filter: { tier?: string | undefined; kind?: string | undefined; search?: string | undefined; limit: number })
    : Promise<Connector[]> {
    const { rows } = await db.query(
      `select ${connectorTable.select} from connect.connectors
       where status <> 'withdrawn' and ($1::text is null or trust_tier = $1) and ($2::text is null or kind = $2)
         and ($3::text is null or position(lower($3) in lower(name)) > 0)
       order by array_position(array['certified', 'private'], trust_tier), name, id limit $4`,
      [filter.tier ?? null, filter.kind ?? null, filter.search ?? null, filter.limit]);
    return rows as Connector[];
  },

  /** A global catalogue row by its slug. */
  /** The organisation's private connector of this slug (RLS keeps it to the organisation). */
  async findPrivateBySlug(db: Queryable, slug: string): Promise<Connector | undefined> {
    const { rows } = await db.query(`select ${connectorTable.select} from connect.connectors where organisation_id is not null and slug = $1 limit 1`, [slug]);
    return rows[0] as Connector | undefined;
  },

  async findGlobalBySlug(db: Queryable, slug: string): Promise<Connector | undefined> {
    const { rows } = await db.query(
      `select ${connectorTable.select} from connect.connectors where organisation_id is null and slug = $1`, [slug]);
    return rows[0] as Connector | undefined;
  },
};
