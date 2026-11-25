import type { Executor } from '../infra/db.infra';

/** Whether a super admin has switched context from the web off for this organisation (130). No row: on. */

export async function switchedOff(db: Executor): Promise<{ by: string; at: Date } | null> {
  const { rows } = await db.query<{ switched_off_by: string; switched_off_at: Date }>(
    `SELECT switched_off_by, switched_off_at FROM web_context_opt_outs`,
  );
  const row = rows[0];
  return row ? { by: row.switched_off_by, at: row.switched_off_at } : null;
}

export async function switchOff(db: Executor, input: { organisationId: string; membershipId: string }): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO web_context_opt_outs (organisation_id, switched_off_by) VALUES ($1, $2)
     ON CONFLICT (organisation_id) DO NOTHING`,
    [input.organisationId, input.membershipId],
  );
  return (rowCount ?? 0) > 0;
}

export async function switchOn(db: Executor): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM web_context_opt_outs`);
  return (rowCount ?? 0) > 0;
}
