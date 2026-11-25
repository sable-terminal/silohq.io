// Data access for recognition.finding_scores, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  findingScoreTable,
  type FindingScore,
  type FindingScoreChanges,
  type FindingScorePrimaryKey,
  type NewFindingScore,
} from '../../models/recognition/findingScore.model.ts';

export const findingScoreRepo = {
  insert(db: Queryable, row: NewFindingScore): Promise<FindingScore> {
    return insertRow(db, findingScoreTable, row);
  },

  findByKey(db: Queryable, key: FindingScorePrimaryKey): Promise<FindingScore | undefined> {
    return findRow(db, findingScoreTable, key);
  },

  update(
    db: Queryable,
    key: FindingScorePrimaryKey,
    changes: FindingScoreChanges,
  ): Promise<FindingScore | undefined> {
    return updateRow(db, findingScoreTable, key, changes);
  },

  async listFor(db: Queryable, findingIds: readonly string[]): Promise<{ findingId: string; score: string }[]> {
    if (findingIds.length === 0) return [];
    const { rows } = await db.query(
      `select finding_id as "findingId", score::text as score from recognition.finding_scores where finding_id = any($1::uuid[])`, [findingIds]);
    return rows as { findingId: string; score: string }[];
  },
};
