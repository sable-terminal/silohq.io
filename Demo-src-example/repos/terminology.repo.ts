import type { Executor } from '../infra/db.infra';

/**
 * §12 — what an organisation calls a concept, and what one person calls it.
 *
 * TWO TABLES, ONE SHAPE, READ TOGETHER. The resolution order is the service's;
 * this returns both layers and decides nothing.
 */

export interface Term {
  conceptId: string;
  term: string;
}

export async function forOrganisation(db: Executor, organisationId: string): Promise<Term[]> {
  const { rows } = await db.query<{ concept_id: string; term: string }>(
    `SELECT concept_id, term FROM terminology WHERE organisation_id = $1`,
    [organisationId],
  );
  return rows.map((row) => ({ conceptId: row.concept_id, term: row.term }));
}

export async function forMembership(db: Executor, membershipId: string): Promise<Term[]> {
  const { rows } = await db.query<{ concept_id: string; term: string }>(
    `SELECT concept_id, term FROM presentation_lenses WHERE membership_id = $1`,
    [membershipId],
  );
  return rows.map((row) => ({ conceptId: row.concept_id, term: row.term }));
}

/** Returns the word it replaced, so the audit row can say what changed. */
export async function setForOrganisation(
  db: Executor,
  input: { id: string; organisationId: string; conceptId: string; term: string; setBy: string },
): Promise<string | null> {
  const { rows } = await db.query<{ previous: string | null }>(
    `INSERT INTO terminology (id, organisation_id, concept_id, term, set_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organisation_id, concept_id) DO UPDATE
        SET term = EXCLUDED.term, set_by = EXCLUDED.set_by, set_at = now()
     RETURNING (SELECT t.term FROM terminology t
                 WHERE t.organisation_id = $2 AND t.concept_id = $3) AS previous`,
    [input.id, input.organisationId, input.conceptId, input.term, input.setBy],
  );
  return rows[0]?.previous ?? null;
}

export async function clearForOrganisation(
  db: Executor,
  input: { organisationId: string; conceptId: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM terminology WHERE organisation_id = $1 AND concept_id = $2`,
    [input.organisationId, input.conceptId],
  );
  return (rowCount ?? 0) > 0;
}

export async function setForMembership(
  db: Executor,
  input: { id: string; organisationId: string; membershipId: string; conceptId: string; term: string },
): Promise<void> {
  await db.query(
    `INSERT INTO presentation_lenses (id, organisation_id, membership_id, concept_id, term)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (membership_id, concept_id) DO UPDATE
        SET term = EXCLUDED.term, set_at = now()`,
    [input.id, input.organisationId, input.membershipId, input.conceptId, input.term],
  );
}

export async function clearForMembership(
  db: Executor,
  input: { membershipId: string; conceptId: string },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM presentation_lenses WHERE membership_id = $1 AND concept_id = $2`,
    [input.membershipId, input.conceptId],
  );
  return (rowCount ?? 0) > 0;
}
