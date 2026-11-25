import type { Executor } from '../infra/db.infra';

/**
 * The approval chain: which actions need a second person, what is waiting, and
 * who decided.
 *
 * SQL, AND THE MAPPING BETWEEN A ROW AND A MODEL. Who may configure a policy,
 * who may decide a request, and what running an approved action means are the
 * service's decisions.
 */

export type ApprovalAction = 'silo.purge' | 'mutation.purge';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'failed';

export interface ApprovalPolicy {
  action: ApprovalAction;
  approvalsRequired: number;
  configuredBy: string;
  configuredAt: Date;
}

export interface ApprovalRequest {
  id: string;
  action: ApprovalAction;
  /** References only: what the action names, never what those records said. */
  subject: Record<string, unknown>;
  approvalsRequired: number;
  requestedBy: string;
  requestedAt: Date;
  expiresAt: Date;
  status: ApprovalStatus;
  decidedAt: Date | null;
  outcome: Record<string, unknown> | null;
  /** Who has approved so far, and who has rejected. */
  approvedBy: string[];
  rejectedBy: string[];
}

/* ── Policies ────────────────────────────────────────────────────────────── */

type PolicyRow = {
  action: ApprovalAction;
  approvals_required: number;
  configured_by: string;
  configured_at: Date;
};

const mapPolicy = (row: PolicyRow): ApprovalPolicy => ({
  action: row.action,
  approvalsRequired: row.approvals_required,
  configuredBy: row.configured_by,
  configuredAt: row.configured_at,
});

export async function setPolicy(
  db: Executor,
  input: { organisationId: string; action: ApprovalAction; approvalsRequired: number; configuredBy: string },
): Promise<ApprovalPolicy> {
  const { rows } = await db.query<PolicyRow>(
    `INSERT INTO approval_policies (organisation_id, action, approvals_required, configured_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organisation_id, action) DO UPDATE
        SET approvals_required = EXCLUDED.approvals_required,
            configured_by = EXCLUDED.configured_by,
            configured_at = now()
     RETURNING action, approvals_required, configured_by, configured_at`,
    [input.organisationId, input.action, input.approvalsRequired, input.configuredBy],
  );
  return mapPolicy(rows[0]!);
}

export async function removePolicy(db: Executor, action: ApprovalAction): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM approval_policies WHERE action = $1', [action]);
  return (rowCount ?? 0) > 0;
}

export async function policies(db: Executor): Promise<ApprovalPolicy[]> {
  const { rows } = await db.query<PolicyRow>(
    `SELECT action, approvals_required, configured_by, configured_at
       FROM approval_policies ORDER BY action`,
  );
  return rows.map(mapPolicy);
}

export async function policyFor(db: Executor, action: ApprovalAction): Promise<ApprovalPolicy | null> {
  const { rows } = await db.query<PolicyRow>(
    `SELECT action, approvals_required, configured_by, configured_at
       FROM approval_policies WHERE action = $1`,
    [action],
  );
  return rows[0] ? mapPolicy(rows[0]) : null;
}

/* ── Requests ────────────────────────────────────────────────────────────── */

const REQUEST_COLUMNS = `
  r.id, r.action, r.subject, r.approvals_required, r.requested_by, r.requested_at,
  r.expires_at, r.status, r.decided_at, r.outcome,
  ARRAY(SELECT d.decided_by FROM approval_decisions d
         WHERE d.request_id = r.id AND d.decision = 'approve' ORDER BY d.decided_at) AS approved_by,
  ARRAY(SELECT d.decided_by FROM approval_decisions d
         WHERE d.request_id = r.id AND d.decision = 'reject' ORDER BY d.decided_at) AS rejected_by
`;

type RequestRow = {
  id: string;
  action: ApprovalAction;
  subject: Record<string, unknown>;
  approvals_required: number;
  requested_by: string;
  requested_at: Date;
  expires_at: Date;
  status: ApprovalStatus;
  decided_at: Date | null;
  outcome: Record<string, unknown> | null;
  approved_by: string[];
  rejected_by: string[];
};

const mapRequest = (row: RequestRow): ApprovalRequest => ({
  id: row.id,
  action: row.action,
  subject: row.subject,
  approvalsRequired: row.approvals_required,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at,
  expiresAt: row.expires_at,
  status: row.status,
  decidedAt: row.decided_at,
  outcome: row.outcome,
  approvedBy: row.approved_by,
  rejectedBy: row.rejected_by,
});

export async function createRequest(
  db: Executor,
  input: {
    id: string;
    organisationId: string;
    action: ApprovalAction;
    subject: Record<string, unknown>;
    approvalsRequired: number;
    requestedBy: string;
    expiresAt: Date;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO approval_requests
       (id, organisation_id, action, subject, approvals_required, requested_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.id, input.organisationId, input.action, JSON.stringify(input.subject),
      input.approvalsRequired, input.requestedBy, input.expiresAt,
    ],
  );
}

/**
 * The request, locked for the rest of the transaction.
 *
 * LOCKED, because two approvers deciding at once must not both see one approval
 * outstanding and both run the action.
 */
export async function lockRequest(db: Executor, id: string): Promise<ApprovalRequest | null> {
  const { rows } = await db.query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM approval_requests r WHERE r.id = $1 FOR UPDATE OF r`,
    [id],
  );
  return rows[0] ? mapRequest(rows[0]) : null;
}

export async function listRequests(
  db: Executor,
  filter: { status?: ApprovalStatus; action?: ApprovalAction },
): Promise<ApprovalRequest[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status) {
    args.push(filter.status);
    where.push(`r.status = $${args.length}`);
  }
  if (filter.action) {
    args.push(filter.action);
    where.push(`r.action = $${args.length}`);
  }

  const { rows } = await db.query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM approval_requests r
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.requested_at DESC`,
    args,
  );
  return rows.map(mapRequest);
}

export async function recordDecision(
  db: Executor,
  input: {
    requestId: string;
    organisationId: string;
    decidedBy: string;
    decision: 'approve' | 'reject';
    reason: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO approval_decisions (request_id, organisation_id, decided_by, decision, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.requestId, input.organisationId, input.decidedBy, input.decision, input.reason],
  );
}

export async function setStatus(
  db: Executor,
  id: string,
  status: ApprovalStatus,
  outcome: Record<string, unknown> | null = null,
): Promise<void> {
  await db.query(
    `UPDATE approval_requests
        SET status = $2,
            decided_at = COALESCE(decided_at, now()),
            outcome = COALESCE($3::jsonb, outcome)
      WHERE id = $1`,
    [id, status, outcome === null ? null : JSON.stringify(outcome)],
  );
}
