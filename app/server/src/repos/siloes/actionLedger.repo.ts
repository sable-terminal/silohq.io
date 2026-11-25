// Data access for siloes.action_ledger, in plain SQL through base.repo.ts; no ORM.
// Read by silo_app, silo_report; written by silo_app.
// Row-level security applies: call it inside inTransaction with the request context.
// Scaffolded once by npm run db:models; this table's own queries belong here.

import { findRow, type Queryable } from '../base.repo.ts';
import { actionLedgerTable, type ActionLedger, type NewActionLedger } from '../../models/siloes/actionLedger.model.ts';

const CHUNK = 1_000;

export const actionLedgerRepo = {
  findByLedgerId(db: Queryable, ledgerId: ActionLedger['ledgerId']): Promise<ActionLedger | undefined> {
    return findRow(db, actionLedgerTable, { ledgerId });
  },

  /** Rows by ledger id, each inserted once: a repeated write of the same Action adds nothing. The count inserted. */
  async insertMissing(db: Queryable, rows: readonly NewActionLedger[]): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => ({
        ledger_id: r.ledgerId, organisation_id: r.organisationId, silo_id: r.siloId, mutation_id: r.mutationId, receipt_id: r.receiptId,
        commit_id: r.commitId ?? null, action_type: r.actionType, generic_edit: r.genericEdit, risk_class: r.riskClass, object_type: r.objectType,
        object_id: r.objectId, connection_id: r.connectionId ?? null, operation: r.operation, fields: r.fields,
        prior_values: r.priorValues == null ? null : r.priorValues.toString('base64'), new_values: r.newValues == null ? null : r.newValues.toString('base64'),
        proposer: r.proposer ?? null, approvers: r.approvers, self_approved: r.selfApproved, origin: r.origin, outcome: r.outcome,
        reverts_mutation_id: r.revertsMutationId ?? null, proposed_at: r.proposedAt ?? null, executed_at: r.executedAt, marking_ids: r.markingIds ?? [],
      }));
      const result = await db.query(
        `insert into siloes.action_ledger (ledger_id, organisation_id, silo_id, mutation_id, receipt_id, commit_id, action_type, generic_edit, risk_class,
           object_type, object_id, connection_id, operation, fields, prior_values, new_values, proposer, approvers, self_approved, origin, outcome,
           reverts_mutation_id, proposed_at, executed_at, marking_ids)
         select x.ledger_id, x.organisation_id, x.silo_id, x.mutation_id, x.receipt_id, x.commit_id, x.action_type, x.generic_edit, x.risk_class,
           x.object_type, x.object_id, x.connection_id, x.operation, x.fields, decode(x.prior_values, 'base64'), decode(x.new_values, 'base64'),
           x.proposer, x.approvers, x.self_approved, x.origin, x.outcome, x.reverts_mutation_id, x.proposed_at, x.executed_at, x.marking_ids
         from jsonb_to_recordset($1::jsonb) as x(ledger_id uuid, organisation_id uuid, silo_id uuid, mutation_id uuid, receipt_id uuid, commit_id uuid,
           action_type text, generic_edit boolean, risk_class text, object_type text, object_id uuid, connection_id uuid, operation text, fields text[],
           prior_values text, new_values text, proposer uuid, approvers uuid[], self_approved boolean, origin text, outcome text,
           reverts_mutation_id uuid, proposed_at timestamptz, executed_at timestamptz, marking_ids uuid[])
         on conflict (organisation_id, ledger_id) do nothing`, [JSON.stringify(chunk)]);
      inserted += result.rowCount ?? 0;
    }
    return inserted;
  },

  /** Receipt purge (48.2): the values of these receipts' rows cleared, once; references and outcomes stay. The count cleared. */
  async clearValues(db: Queryable, receiptIds: readonly string[]): Promise<number> {
    const result = await db.query(
      `update siloes.action_ledger set prior_values = null, new_values = null, values_cleared_at = now()
       where receipt_id = any($1::uuid[]) and values_cleared_at is null and (prior_values is not null or new_values is not null)`, [receiptIds]);
    return result.rowCount ?? 0;
  },

  /** Whether any row of these receipts still holds values: where a receipt purge has something to clear. */
  async holdsValuesFor(db: Queryable, receiptIds: readonly string[]): Promise<boolean> {
    const { rows } = await db.query(
      `select exists (select 1 from siloes.action_ledger where receipt_id = any($1::uuid[]) and (prior_values is not null or new_values is not null)) as held`,
      [receiptIds]);
    return (rows[0] as { held: boolean }).held;
  },

  /** A Silo's rows, newest executed first, after a (executed_at, ledger_id) cursor; filtered by receipt or object. */
  async page(db: Queryable, f: {
    siloId: string; receiptId?: string | undefined; objectId?: string | undefined; after?: { executedAt: string; ledgerId: string } | undefined; limit: number;
  }): Promise<ActionLedger[]> {
    const { rows } = await db.query(
      `select ${actionLedgerTable.select} from siloes.action_ledger
       where silo_id = $1 and ($2::uuid is null or receipt_id = $2) and ($3::uuid is null or object_id = $3)
         and ($4::timestamptz is null or (executed_at, ledger_id) < ($4::timestamptz, $5::uuid))
       order by executed_at desc, ledger_id desc limit $6`,
      [f.siloId, f.receiptId ?? null, f.objectId ?? null, f.after?.executedAt ?? null, f.after?.ledgerId ?? null, f.limit]);
    return rows as ActionLedger[];
  },
};
