// Data access for fleet.release_components, in plain SQL through base.repo.ts; no ORM.
// Read by directory_reader, fleet_writer; written by fleet_writer.
// No row-level security: every caller sees every row.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, insertRow, type Queryable } from '../base.repo.ts';
import {
  releaseComponentTable,
  type NewReleaseComponent,
  type ReleaseComponent,
  type ReleaseComponentPrimaryKey,
} from '../../models/fleet/releaseComponent.model.ts';

export const releaseComponentRepo = {
  insert(db: Queryable, row: NewReleaseComponent): Promise<ReleaseComponent> {
    return insertRow(db, releaseComponentTable, row);
  },

  findByKey(db: Queryable, key: ReleaseComponentPrimaryKey): Promise<ReleaseComponent | undefined> {
    return findRow(db, releaseComponentTable, key);
  },

  /** An SBOM's components, a batch at a time; one listed twice is kept once. */
  async insertMany(db: Queryable, releaseId: string, sbomDigest: string,
    components: readonly { purl: string; ecosystem: string | null; name: string; version: string }[]): Promise<void> {
    for (let i = 0; i < components.length; i += 5_000) {
      await db.query(
        `insert into fleet.release_components (release_id, sbom_digest, purl, ecosystem, name, version)
         select $1, $2, c.purl, c.ecosystem, c.name, c.version
           from jsonb_to_recordset($3::jsonb) as c(purl text, ecosystem text, name text, version text)
         on conflict do nothing`,
        [releaseId, sbomDigest, JSON.stringify(components.slice(i, i + 5_000))]);
    }
  },

  /** How many components the release's SBOMs list, and how many no advisory can match (no ecosystem). */
  async countsFor(db: Queryable, releaseId: string): Promise<{ components: number; unmatched: number }> {
    const { rows } = await db.query(
      `select count(*)::int as components, count(*) filter (where ecosystem is null)::int as unmatched
         from fleet.release_components where release_id = $1`, [releaseId]);
    return rows[0] as { components: number; unmatched: number };
  },

  /** The OSV ecosystems the releases' components come from. */
  async ecosystemsFor(db: Queryable, releaseIds: readonly string[]): Promise<string[]> {
    const { rows } = await db.query(
      `select distinct ecosystem from fleet.release_components where release_id = any($1::text[]) and ecosystem is not null order by 1`,
      [releaseIds]);
    return (rows as { ecosystem: string }[]).map((r) => r.ecosystem);
  },

  /** The components of a release's image SBOMs, with the image each is in. */
  async imageComponents(db: Queryable, releaseId: string): Promise<{ subject: string; purl: string; version: string }[]> {
    const { rows } = await db.query(
      `select s.subject, c.purl, c.version from fleet.release_components c
         join fleet.release_sboms s on s.release_id = c.release_id and s.digest = c.sbom_digest
        where c.release_id = $1 and s.subject like 'image:%' order by s.subject, c.purl`, [releaseId]);
    return rows as { subject: string; purl: string; version: string }[];
  },
};
