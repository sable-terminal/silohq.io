// Data access for recognition.finding_links, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  findingLinkTable,
  type FindingLink,
  type FindingLinkPrimaryKey,
  type NewFindingLink,
} from '../../models/recognition/findingLink.model.ts';

export const findingLinkRepo = {
  insert(db: Queryable, row: NewFindingLink): Promise<FindingLink> {
    return insertRow(db, findingLinkTable, row);
  },

  findByKey(db: Queryable, key: FindingLinkPrimaryKey): Promise<FindingLink | undefined> {
    return findRow(db, findingLinkTable, key);
  },

  /** Each link in both directions, in one statement (the constraint trigger checks at commit). */
  async insertBothWays(db: Queryable, organisationId: string, links: readonly { findingId: string; linkedFindingId: string; shared: number }[])
    : Promise<void> {
    if (links.length === 0) return;
    const a = [...links.map((l) => l.findingId), ...links.map((l) => l.linkedFindingId)];
    const b = [...links.map((l) => l.linkedFindingId), ...links.map((l) => l.findingId)];
    const n = [...links.map((l) => l.shared), ...links.map((l) => l.shared)];
    await db.query(
      `insert into recognition.finding_links (organisation_id, finding_id, linked_finding_id, shared_refs_count)
       select $1, x, y, c from unnest($2::uuid[], $3::uuid[], $4::int[]) as u (x, y, c) on conflict do nothing`,
      [organisationId, a, b, n]);
  },

  async listFor(db: Queryable, findingIds: readonly string[]): Promise<{ findingId: string; linkedFindingId: string; sharedRefsCount: number }[]> {
    if (findingIds.length === 0) return [];
    const { rows } = await db.query(
      `select finding_id as "findingId", linked_finding_id as "linkedFindingId", shared_refs_count as "sharedRefsCount"
         from recognition.finding_links where finding_id = any($1::uuid[]) order by finding_id, linked_finding_id`, [findingIds]);
    return rows as { findingId: string; linkedFindingId: string; sharedRefsCount: number }[];
  },
};
