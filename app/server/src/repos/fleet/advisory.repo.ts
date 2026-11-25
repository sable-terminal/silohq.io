// Data access for fleet.advisories, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { deleteRow, findRow, insertRow, updateRow, type Queryable } from '../base.repo.ts';
import {
  advisoryTable,
  type Advisory,
  type AdvisoryChanges,
  type NewAdvisory,
} from '../../models/fleet/advisory.model.ts';

export const advisoryRepo = {
  insert(db: Queryable, row: NewAdvisory): Promise<Advisory> {
    return insertRow(db, advisoryTable, row);
  },

  findById(db: Queryable, id: Advisory['id']): Promise<Advisory | undefined> {
    return findRow(db, advisoryTable, { id });
  },

  update(db: Queryable, id: Advisory['id'], changes: AdvisoryChanges): Promise<Advisory | undefined> {
    return updateRow(db, advisoryTable, { id }, changes);
  },

  remove(db: Queryable, id: Advisory['id']): Promise<boolean> {
    return deleteRow(db, advisoryTable, { id });
  },

  /**
   * Advisories as fetched: a new one is added, a known one replaced only by a later
   * modification. The ids added or replaced.
   */
  async upsertMany(db: Queryable, advisories: readonly {
    id: string; modified: string; withdrawn: string | null; aliases: string[]; summary: string | null; severity: string; score: number | null;
    affected: unknown[];
  }[], feed: string, fetchedAt: string): Promise<string[]> {
    // A batch names each advisory once, its latest.
    const latest = new Map<string, (typeof advisories)[number]>();
    for (const a of advisories) {
      const seen = latest.get(a.id);
      if (seen === undefined || Date.parse(seen.modified) < Date.parse(a.modified)) latest.set(a.id, a);
    }
    const { rows } = await db.query(
      `insert into fleet.advisories (id, feed, modified, withdrawn, aliases, summary, severity, score, affected, fetched_at)
       select a.id, $2, a.modified, a.withdrawn, array(select jsonb_array_elements_text(a.aliases)), a.summary, a.severity, a.score,
              a.affected, $3
         from jsonb_to_recordset($1::jsonb)
           as a(id text, modified timestamptz, withdrawn timestamptz, aliases jsonb, summary text, severity text, score numeric, affected jsonb)
       on conflict (id) do update set feed = excluded.feed, modified = excluded.modified, withdrawn = excluded.withdrawn,
         aliases = excluded.aliases, summary = excluded.summary, severity = excluded.severity, score = excluded.score,
         affected = excluded.affected, fetched_at = excluded.fetched_at
       where fleet.advisories.modified < excluded.modified
       returning id`,
      [JSON.stringify([...latest.values()]), feed, fetchedAt]);
    return (rows as { id: string }[]).map((r) => r.id);
  },

  /** Each live advisory naming a package one of the release's components is, with the component. */
  async candidatesFor(db: Queryable, releaseId: string): Promise<{
    purl: string; ecosystem: string; name: string; version: string; subject: string; advisoryId: string; aliases: string[];
    severity: 'critical' | 'high' | 'medium' | 'low' | 'none' | 'unrated'; score: number | null;
    affected: { ecosystem: string; name: string; versions: string[]; ranges: { type: string; events: Record<string, string>[] }[] }[];
  }[]> {
    const { rows } = await db.query(
      `select c.purl, c.ecosystem, c.name, c.version, s.subject, a.id as "advisoryId", a.aliases, a.severity,
              a.score::float8 as score, a.affected
         from fleet.release_components c
         join fleet.release_sboms s on s.release_id = c.release_id and s.digest = c.sbom_digest
         join fleet.advisory_packages p on p.ecosystem = c.ecosystem and p.name = c.name
         join fleet.advisories a on a.id = p.advisory_id and a.withdrawn is null
        where c.release_id = $1
        order by a.id, c.purl, s.subject`, [releaseId]);
    return rows as never;
  },

  /** Rated, live advisories that are, or share an alias with, any of these names. */
  async ratedSharing(db: Queryable, names: readonly string[]): Promise<{
    id: string; aliases: string[]; severity: 'critical' | 'high' | 'medium' | 'low' | 'none'; score: number | null;
  }[]> {
    const { rows } = await db.query(
      `select id, aliases, severity, score::float8 as score from fleet.advisories
        where withdrawn is null and severity <> 'unrated' and (id = any($1::text[]) or aliases && $1::text[])`, [names]);
    return rows as never;
  },
};
