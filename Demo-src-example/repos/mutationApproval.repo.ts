import type { Executor } from '../infra/db.infra';
import type { ChainPolicy } from '../engine/mutation/policy.mutation';

/**
 * A change's approval chain and each decision on it.
 *
 * SQL, AND THE MAPPING BETWEEN A ROW AND A MODEL. Who may decide, whether the
 * chain is satisfied and what happens when it is are the service's.
 */

export type ChainStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface Decision {
  sequence: number;
  approver: string;
  decision: 'approve' | 'reject';
  /** Set by the database from who proposed the change, not by the caller. */
  selfApproval: boolean;
  roleIds: string[];
  comment: string | null;
  decidedAt: Date;
}

export interface Chain {
  id: string;
  mutationId: string;
  policy: ChainPolicy;
  approvalsRequired: number;
  approvalsReceived: number;
  status: ChainStatus;
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  decisions: Decision[];
}

type ChainRow = {
  id: string;
  mutation_id: string;
  policy: ChainPolicy;
  approvals_required: number;
  approvals_received: number;
  status: ChainStatus;
  created_at: Date;
  expires_at: Date;
  decided_at: Date | null;
};

type DecisionRow = {
  sequence: number;
  approver: string;
  decision: 'approve' | 'reject';
  self_approval: boolean;
  role_ids: string[];
  comment: string | null;
  decided_at: Date;
};

const COLUMNS = `id, mutation_id, policy, approvals_required, approvals_received, status,
                 created_at, expires_at, decided_at`;

async function withDecisions(db: Executor, row: ChainRow | undefined): Promise<Chain | null> {
  if (!row) return null;

  const { rows } = await db.query<DecisionRow>(
    `SELECT sequence, approver, decision, self_approval, role_ids, comment, decided_at
       FROM mutation_approvals WHERE chain_id = $1 ORDER BY sequence`,
    [row.id],
  );

  return {
    id: row.id,
    mutationId: row.mutation_id,
    policy: row.policy,
    approvalsRequired: row.approvals_required,
    approvalsReceived: row.approvals_received,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decisions: rows.map((one) => ({
      sequence: one.sequence,
      approver: one.approver,
      decision: one.decision,
      selfApproval: one.self_approval,
      roleIds: one.role_ids,
      comment: one.comment,
      decidedAt: one.decided_at,
    })),
  };
}

export async function createChain(
  db: Executor,
  input: {
    id: string;
    mutationId: string;
    organisationId: string;
    policy: ChainPolicy;
    expiresAt: Date;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO mutation_chains (id, mutation_id, organisation_id, policy, approvals_required, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.id,
      input.mutationId,
      input.organisationId,
      JSON.stringify(input.policy),
      input.policy.approvalsRequired,
      input.expiresAt,
    ],
  );
}

export async function chainOf(db: Executor, mutationId: string): Promise<Chain | null> {
  const { rows } = await db.query<ChainRow>(`SELECT ${COLUMNS} FROM mutation_chains WHERE mutation_id = $1`, [
    mutationId,
  ]);
  return withDecisions(db, rows[0]);
}

/** The chain, locked, so two approvals arriving together are counted one after the other. */
export async function lockChainOf(db: Executor, mutationId: string): Promise<Chain | null> {
  const { rows } = await db.query<ChainRow>(
    `SELECT ${COLUMNS} FROM mutation_chains WHERE mutation_id = $1 FOR UPDATE`,
    [mutationId],
  );
  return withDecisions(db, rows[0]);
}

export async function recordDecision(
  db: Executor,
  input: {
    chainId: string;
    organisationId: string;
    sequence: number;
    approver: string;
    decision: 'approve' | 'reject';
    roleIds: readonly string[];
    comment: string | null;
  },
): Promise<{ selfApproval: boolean }> {
  const { rows } = await db.query<{ self_approval: boolean }>(
    `INSERT INTO mutation_approvals
       (chain_id, organisation_id, sequence, approver, decision, role_ids, comment)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7)
     RETURNING self_approval`,
    [
      input.chainId,
      input.organisationId,
      input.sequence,
      input.approver,
      input.decision,
      [...input.roleIds],
      input.comment,
    ],
  );
  return { selfApproval: rows[0]!.self_approval };
}

export async function settle(
  db: Executor,
  input: { chainId: string; status: ChainStatus; approvalsReceived: number },
): Promise<void> {
  await db.query(
    `UPDATE mutation_chains
        SET status = $2,
            approvals_received = $3,
            decided_at = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END
      WHERE id = $1`,
    [input.chainId, input.status, input.approvalsReceived],
  );
}
