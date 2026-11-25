import type { Executor } from '../infra/db.infra';

/**
 * Whether this organisation has switched off answers written up by a model,
 * who did, and when (129). No row is the default: on.
 */

export interface AnswerReadingOptOut {
  switchedOffBy: string;
  switchedOffAt: Date;
}

export async function find(db: Executor): Promise<AnswerReadingOptOut | null> {
  const { rows } = await db.query<{ switched_off_by: string; switched_off_at: Date }>(
    `SELECT switched_off_by, switched_off_at FROM answer_reading_opt_outs`,
  );
  const row = rows[0];
  return row ? { switchedOffBy: row.switched_off_by, switchedOffAt: row.switched_off_at } : null;
}

export async function switchOff(db: Executor, input: { organisationId: string; membershipId: string }): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO answer_reading_opt_outs (organisation_id, switched_off_by)
     VALUES ($1, $2)
     ON CONFLICT (organisation_id) DO NOTHING`,
    [input.organisationId, input.membershipId],
  );
  return (rowCount ?? 0) > 0;
}

export async function switchOn(db: Executor): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM answer_reading_opt_outs`);
  return (rowCount ?? 0) > 0;
}
