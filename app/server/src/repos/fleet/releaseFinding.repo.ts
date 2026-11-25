// Data access for fleet.release_findings, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  releaseFindingTable,
  type NewReleaseFinding,
  type ReleaseFinding,
  type ReleaseFindingChanges,
  type ReleaseFindingPrimaryKey,
} from '../../models/fleet/releaseFinding.model.ts';

export const releaseFindingRepo = {
  insert(db: Queryable, row: NewReleaseFinding): Promise<ReleaseFinding> {
    return insertRow(db, releaseFindingTable, row);
  },

  findByKey(db: Queryable, key: ReleaseFindingPrimaryKey): Promise<ReleaseFinding | undefined> {
    return findRow(db, releaseFindingTable, key);
  },

  update(
    db: Queryable,
    key: ReleaseFindingPrimaryKey,
    changes: ReleaseFindingChanges,
  ): Promise<ReleaseFinding | undefined> {
    return updateRow(db, releaseFindingTable, key, changes);
  },

  /** A check's findings: each kept or added, seen now; any earlier one not found again is cleared. */
  async record(db: Queryable, releaseId: string, findings: readonly {
    advisoryId: string; purl: string; subject: string; severity: string; score: number | null; resolution: 'affected' | 'unresolved';
    vexStatementId: string | null; blocking: boolean;
  }[], at: string): Promise<void> {
    const unique = [...new Map(findings.map((f) => [`${f.advisoryId}\u0000${f.purl}\u0000${f.subject}`, f])).values()];
    const rows = JSON.stringify(unique.map((f) => ({
      advisory_id: f.advisoryId, purl: f.purl, subject: f.subject, severity: f.severity, score: f.score, resolution: f.resolution,
      vex_statement_id: f.vexStatementId, blocking: f.blocking,
    })));
    await db.query(
      `insert into fleet.release_findings (release_id, advisory_id, purl, subject, severity, score, resolution, vex_statement_id, blocking,
                                           first_found_at, last_seen_at, cleared_at)
       select $1, f.advisory_id, f.purl, f.subject, f.severity, f.score, f.resolution, f.vex_statement_id, f.blocking, $3, $3, null
         from jsonb_to_recordset($2::jsonb) as f(advisory_id text, purl text, subject text, severity text, score numeric,
                                                 resolution text, vex_statement_id uuid, blocking boolean)
       on conflict (release_id, advisory_id, purl, subject) do update set severity = excluded.severity, score = excluded.score,
         resolution = excluded.resolution, vex_statement_id = excluded.vex_statement_id, blocking = excluded.blocking,
         last_seen_at = excluded.last_seen_at, cleared_at = null`, [releaseId, rows, at]);
    await db.query(
      `update fleet.release_findings f set cleared_at = $3, blocking = false
        where f.release_id = $1 and f.cleared_at is null
          and not exists (select 1 from jsonb_to_recordset($2::jsonb) as k(advisory_id text, purl text, subject text)
                           where k.advisory_id = f.advisory_id and k.purl = f.purl and k.subject = f.subject)`, [releaseId, rows, at]);
  },

  /** The release's blocking findings in one family of artefacts (image or agent). */
  async blockingFor(db: Queryable, releaseId: string, family: 'image' | 'agent'): Promise<{ advisoryId: string; purl: string; subject: string }[]> {
    const { rows } = await db.query(
      `select advisory_id as "advisoryId", purl, subject from fleet.release_findings
        where release_id = $1 and blocking and subject like $2 order by advisory_id, purl`, [releaseId, `${family}:%`]);
    return rows as { advisoryId: string; purl: string; subject: string }[];
  },

  /** The release's findings not cleared, blocking first, then by rating. */
  async openFor(db: Queryable, releaseId: string): Promise<{
    advisoryId: string; aliases: string[]; summary: string | null; purl: string; subject: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'none' | 'unrated'; score: number | null; resolution: 'affected' | 'unresolved';
    blocking: boolean; vexStatus: 'not_affected' | 'affected' | 'fixed' | 'under_investigation' | null; firstFoundAt: string;
  }[]> {
    const { rows } = await db.query(
      `select f.advisory_id as "advisoryId", a.aliases, a.summary, f.purl, f.subject, f.severity, f.score::float8 as score, f.resolution,
              f.blocking, v.status as "vexStatus", f.first_found_at as "firstFoundAt"
         from fleet.release_findings f
         join fleet.advisories a on a.id = f.advisory_id
         left join fleet.vex_statements v on v.id = f.vex_statement_id
        where f.release_id = $1 and f.cleared_at is null
        order by f.blocking desc,
                 case f.severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end,
                 f.advisory_id, f.purl, f.subject`, [releaseId]);
    return rows as never;
  },
};
