// Data access for recognition.finding_connections, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  findingConnectionTable,
  type FindingConnection,
  type FindingConnectionPrimaryKey,
  type NewFindingConnection,
} from '../../models/recognition/findingConnection.model.ts';

export const findingConnectionRepo = {
  insert(db: Queryable, row: NewFindingConnection): Promise<FindingConnection> {
    return insertRow(db, findingConnectionTable, row);
  },

  findByKey(db: Queryable, key: FindingConnectionPrimaryKey): Promise<FindingConnection | undefined> {
    return findRow(db, findingConnectionTable, key);
  },

  async insertMany(db: Queryable, organisationId: string, rows: readonly { findingId: string; connectionId: string }[]): Promise<void> {
    if (rows.length === 0) return;
    await db.query(
      `insert into recognition.finding_connections (organisation_id, finding_id, connection_id)
       select $1, f, c from unnest($2::uuid[], $3::uuid[]) as u (f, c) on conflict do nothing`,
      [organisationId, rows.map((r) => r.findingId), rows.map((r) => r.connectionId)]);
  },

  async listFor(db: Queryable, findingIds: readonly string[]): Promise<{ findingId: string; connectionId: string }[]> {
    if (findingIds.length === 0) return [];
    const { rows } = await db.query(
      `select finding_id as "findingId", connection_id as "connectionId" from recognition.finding_connections
        where finding_id = any($1::uuid[]) order by finding_id, connection_id`, [findingIds]);
    return rows as { findingId: string; connectionId: string }[];
  },
};
