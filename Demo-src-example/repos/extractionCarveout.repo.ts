import type { Executor } from '../infra/db.infra';

/**
 * Import §8 — whether this organisation has chosen to have documents read by a
 * model, who chose it, and against which words.
 */

export interface ExtractionCarveout {
  acknowledgedBy: string;
  disclosureVersion: string;
  acknowledgedAt: Date;
}

export async function find(db: Executor): Promise<ExtractionCarveout | null> {
  const { rows } = await db.query<{ acknowledged_by: string; disclosure_version: string; acknowledged_at: Date }>(
    `SELECT acknowledged_by, disclosure_version, acknowledged_at FROM extraction_carveouts`,
  );
  const row = rows[0];
  return row
    ? { acknowledgedBy: row.acknowledged_by, disclosureVersion: row.disclosure_version, acknowledgedAt: row.acknowledged_at }
    : null;
}

/** Chosen again against newer words replaces the older choice. */
export async function acknowledge(
  db: Executor,
  input: { organisationId: string; membershipId: string; disclosureVersion: string },
): Promise<void> {
  await db.query(
    `INSERT INTO extraction_carveouts (organisation_id, acknowledged_by, disclosure_version)
     VALUES ($1, $2, $3)
     ON CONFLICT (organisation_id) DO UPDATE
       SET acknowledged_by = EXCLUDED.acknowledged_by,
           disclosure_version = EXCLUDED.disclosure_version,
           acknowledged_at = now()`,
    [input.organisationId, input.membershipId, input.disclosureVersion],
  );
}

export async function withdraw(db: Executor): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM extraction_carveouts`);
  return (rowCount ?? 0) > 0;
}
