import type { Executor } from '../infra/db.infra';
import type {
  HealChangeKind,
  HealDecision,
  HealProposal,
  SandboxStatus,
} from '../models/connectorLifecycle.model';
import { generateId } from '../utils/tokens.util';

/**
 * §8's repair proposals — `heal_proposals`, and nothing else.
 *
 * WHAT MAY BE APPLIED IS 018'S QUESTION AND THE SERVICE'S, NOT THIS FILE'S.
 * Whether a proposal has already been decided, whether an auto-applied rename
 * may be decided again, and whether accepting one adopts a field are all
 * judgements about the caller, so they live in `connectorHeal.service`. The
 * CHECK constraints are the backstop underneath both.
 */

/**
 * What the review queue shows.
 *
 * A SUBSET, DELIBERATELY. The queue is a list somebody scans, and neither the
 * proposed diff nor the sandbox result is readable at that size — reading them
 * for two hundred rows would cost two jsonb documents a row to render nothing.
 */
export type QueuedProposal = Pick<
  HealProposal,
  'id' | 'changeKind' | 'subject' | 'autoApplied' | 'sandboxStatus' | 'decision' | 'createdAt'
>;

/** What deciding a proposal needs: what it proposed, and whether it is still open. */
export type DecidableProposal = Pick<
  HealProposal,
  'id' | 'connectionId' | 'changeKind' | 'subject' | 'proposedDiff' | 'decision' | 'autoApplied'
>;

interface QueuedRow {
  id: string;
  change_kind: HealChangeKind;
  subject: string;
  auto_applied: boolean;
  sandbox_status: SandboxStatus | null;
  decision: HealDecision | null;
  created_at: Date;
}

interface DecidableRow {
  id: string;
  connection_id: string;
  change_kind: HealChangeKind;
  subject: string;
  proposed_diff: Record<string, unknown>;
  decision: HealDecision | null;
  auto_applied: boolean;
}

function mapQueued(row: QueuedRow): QueuedProposal {
  return {
    id: row.id,
    changeKind: row.change_kind,
    subject: row.subject,
    autoApplied: row.auto_applied,
    sandboxStatus: row.sandbox_status,
    decision: row.decision,
    createdAt: row.created_at,
  };
}

function mapDecidable(row: DecidableRow): DecidableProposal {
  return {
    id: row.id,
    connectionId: row.connection_id,
    changeKind: row.change_kind,
    subject: row.subject,
    proposedDiff: row.proposed_diff,
    decision: row.decision,
    autoApplied: row.auto_applied,
  };
}

/**
 * Record what a re-check wants to change. Returns the proposal's id.
 *
 * A NULL SANDBOX STATUS IS "NOT TRIED", NOT "FAILED", and 018's
 * `heal_auto_apply_was_tested` distinguishes the two with `IS NOT DISTINCT
 * FROM` for exactly that reason. Only a rename arrives here having been tested.
 */
export async function insert(
  db: Executor,
  input: {
    connectionId: string;
    manifestId: string;
    changeKind: HealChangeKind;
    subject: string;
    proposedDiff: Record<string, unknown>;
    sandboxStatus?: SandboxStatus | null;
    sandboxResult?: Record<string, unknown> | null;
  },
): Promise<string> {
  const id = generateId();

  await db.query(
    `INSERT INTO heal_proposals
       (id, connection_id, manifest_id, change_kind, subject, proposed_diff,
        sandbox_status, sandbox_result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      input.connectionId,
      input.manifestId,
      input.changeKind,
      input.subject,
      JSON.stringify(input.proposedDiff),
      input.sandboxStatus ?? null,
      input.sandboxResult ? JSON.stringify(input.sandboxResult) : null,
    ],
  );

  return id;
}

/** One connection's proposals, newest first. */
export async function listFor(db: Executor, connectionId: string): Promise<QueuedProposal[]> {
  const { rows } = await db.query<QueuedRow>(
    `SELECT id, change_kind, subject, auto_applied, sandbox_status, decision, created_at
       FROM heal_proposals WHERE connection_id = $1
      ORDER BY created_at DESC LIMIT 200`,
    [connectionId],
  );

  return rows.map(mapQueued);
}

/** Null when there is no such proposal; the service decides what that means. */
export async function read(db: Executor, id: string): Promise<DecidableProposal | null> {
  const { rows } = await db.query<DecidableRow>(
    `SELECT id, connection_id, change_kind, subject, proposed_diff, decision, auto_applied
       FROM heal_proposals WHERE id = $1`,
    [id],
  );

  const row = rows[0];
  return row ? mapDecidable(row) : null;
}

/**
 * Note that the repair went into a manifest.
 *
 * `automatically` IS NOT A DETAIL. 018 permits `auto_applied` only for a
 * sandbox-tested rename, so a field adopted because a person accepted it has to
 * be written as false — recording it as automatic both violates the CHECK and
 * misattributes the decision.
 */
export async function markApplied(
  db: Executor,
  input: { id: string; automatically: boolean },
): Promise<void> {
  await db.query(
    `UPDATE heal_proposals SET auto_applied = $2, applied_at = now() WHERE id = $1`,
    [input.id, input.automatically],
  );
}

/**
 * A person accepted or rejected it.
 *
 * NO `WHERE decision IS NULL`. A second decision would silently write nothing
 * and look like the first succeeded — the service reads the proposal, refuses a
 * decided one by name, and this writes what it decided.
 */
export async function recordDecision(
  db: Executor,
  input: { id: string; decision: HealDecision; reviewedBy: string },
): Promise<void> {
  await db.query(
    `UPDATE heal_proposals SET decision = $2, reviewed_by = $3, reviewed_at = now()
      WHERE id = $1`,
    [input.id, input.decision, input.reviewedBy],
  );
}
