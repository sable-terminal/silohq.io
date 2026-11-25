// Approval policies and floors (spec 44.2, 44.4, 44.8). A policy is never edited in place: a
// change supersedes the row and inserts a new one, so the policy in force at any past time
// can be reconstructed. mutation.policy is decided at the connection's owning scope (an
// organisation default needs it organisation-wide); the database adds the policy authority
// rules (a locked connection takes policy only from a super admin, a delegated one only from
// the named admin) and refuses a policy weaker than an applicable floor unless a super admin
// sets it. Floors are set by a super admin only (the database checks set_by).

import type { PolicyView } from '../../contracts/approvals/approval.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { ApprovalPolicy } from '../../models/action/approvalPolicy.model.ts';
import { approvalPolicyRepo, policyFloorRepo } from '../../repos/action/index.repo.ts';
import { authorise } from '../../contracts/policy/decision.contract.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { callOptions, memberOf, readConnections, type Context, type WriteBackDeps } from '../actions/deps.service.ts';
import { recordActionEvent } from '../actions/events.service.ts';

export interface PolicyFields {
  connectionId: string | null;
  scopeId: string | null;
  approvalsRequired: number;
  approverQualification: ApprovalPolicy['approverQualification'];
  qualifyingRoleId: string | null;
  requiresAdmin: boolean;
  sameScopeRequired: boolean;
  selfApprovalPermitted: boolean;
  sequential: boolean;
  rowThreshold: number | null;
  riskClassCondition: ('data' | 'bulk' | 'external' | 'physical')[] | null;
  markingCondition: string[] | null;
  expiryHours: number;
}

const viewOf = (p: ApprovalPolicy): PolicyView => ({
  id: p.id, connectionId: p.connectionId, scopeId: p.scopeId, approvalsRequired: p.approvalsRequired, approverQualification: p.approverQualification,
  qualifyingRoleId: p.qualifyingRoleId, requiresAdmin: p.requiresAdmin, sameScopeRequired: p.sameScopeRequired, selfApprovalPermitted: p.selfApprovalPermitted,
  sequential: p.sequential, rowThreshold: p.rowThreshold, riskClassCondition: p.riskClassCondition as PolicyView['riskClassCondition'],
  markingCondition: p.markingCondition, expiryHours: p.expiryHours, createdBy: p.createdBy, createdAt: p.createdAt, supersededAt: p.supersededAt, supersededById: p.supersededById,
});

function refusedByDatabase(error: unknown): never {
  const mapped = fromDatabaseError(error);
  if (mapped.category === 'forbidden' || mapped.details['sqlstate'] === '42501') {
    throw new AppError('forbidden', 'the connection\'s policy authority or a floor refuses this policy', { code: 'approval_policy.refused' });
  }
  if (mapped.details['sqlstate'] === '23503') {
    throw new AppError('validation', 'the marking condition names a marking this organisation does not have', { code: 'approval_policy.marking_unknown' });
  }
  if (mapped.details['sqlstate'] === '23514') {
    throw new AppError('validation', 'the policy breaks a rule the database holds (a physical policy needs two approvers; a scope_admin policy needs an admin)', { code: 'approval_policy.invalid' });
  }
  throw error;
}

export function createPolicies(deps: WriteBackDeps) {
  const control = deps.databases.pool('control');

  async function mayPolicy(ctx: Context, connectionId: string | null): Promise<void> {
    let body: { permission: string; scopeId?: string; organisationWide?: true };
    if (connectionId === null) {
      body = { permission: 'mutation.policy', organisationWide: true };
    } else {
      const connections = await readConnections(deps, ctx.request, [connectionId]);
      body = { permission: 'mutation.policy', scopeId: connections.get(connectionId)!.connection.owningScopeId };
    }
    const decision = await deps.services.call(authorise, { body }, callOptions(ctx));
    if (decision.decision !== 'allow') throw new AppError('forbidden', 'you need mutation.policy for this connection', { code: 'approval_policy.not_permitted' });
  }

  async function insert(ctx: Context, fields: PolicyFields, supersedes?: ApprovalPolicy): Promise<PolicyView> {
    const { organisationId, membershipId } = memberOf(ctx, 'setting approval policy');
    const id = uuidv7();
    try {
      await inTransaction(control, ctx.request, async (db) => {
        await approvalPolicyRepo.insert(db, {
          id, organisationId, connectionId: fields.connectionId, scopeId: fields.scopeId, approvalsRequired: fields.approvalsRequired,
          approverQualification: fields.approverQualification, qualifyingRoleId: fields.qualifyingRoleId, requiresAdmin: fields.requiresAdmin,
          sameScopeRequired: fields.sameScopeRequired, selfApprovalPermitted: fields.selfApprovalPermitted, sequential: fields.sequential,
          rowThreshold: fields.rowThreshold, riskClassCondition: fields.riskClassCondition, markingCondition: fields.markingCondition,
          expiryHours: fields.expiryHours, createdBy: membershipId,
        });
        if (supersedes !== undefined) {
          await approvalPolicyRepo.update(db, supersedes.id, { supersededAt: new Date().toISOString(), supersededById: id });
        }
        await recordActionEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: supersedes === undefined ? 'approval_policy_created' : 'approval_policy_superseded',
          request: ctx.request, service: 'approvals', resource: { type: 'approval_policy', id },
          detail: { connection_id: fields.connectionId, approvals_required: fields.approvalsRequired, qualification: fields.approverQualification, ...(supersedes === undefined ? {} : { supersedes: supersedes.id }) },
        });
        // policy_changed (44.9): what now governs the connection's Actions, before and after, so a weakening reads in one row.
        await recordActionEvent(db, {
          organisationId, correlationId: ctx.correlationId, event: 'policy_changed', request: ctx.request, service: 'approvals',
          resource: { type: 'approval_policy', id },
          detail: {
            connection_id: fields.connectionId, scope_id: fields.scopeId, from_policy_id: supersedes?.id ?? null,
            approvals_required_before: supersedes?.approvalsRequired ?? null, approvals_required_after: fields.approvalsRequired,
            self_approval_before: supersedes?.selfApprovalPermitted ?? null, self_approval_after: fields.selfApprovalPermitted,
          },
        });
      });
    } catch (error) {
      refusedByDatabase(error);
    }
    return viewOf((await inTransaction(control, ctx.request, (db) => approvalPolicyRepo.findById(db, id), { readOnly: true }))!);
  }

  return {
    async create(ctx: Context, fields: PolicyFields): Promise<PolicyView> {
      await mayPolicy(ctx, fields.connectionId);
      return insert(ctx, fields);
    },

    async supersede(ctx: Context, policyId: string, fields: PolicyFields): Promise<PolicyView> {
      const old = await inTransaction(control, ctx.request, (db) => approvalPolicyRepo.findById(db, policyId), { readOnly: true });
      if (!old) throw new AppError('not_found', 'no such approval policy', { code: 'approval_policy.not_found' });
      if (old.supersededAt !== null) throw new AppError('conflict', 'that policy has been superseded already', { code: 'approval_policy.superseded' });
      if (fields.connectionId !== old.connectionId) throw new AppError('validation', 'a superseding policy is for the same connection', { code: 'approval_policy.connection_changed' });
      await mayPolicy(ctx, old.connectionId);
      return insert(ctx, fields, old);
    },

    async list(ctx: Context, connectionId: string | undefined, includeSuperseded: boolean): Promise<PolicyView[]> {
      const rows = await inTransaction(control, ctx.request, (db) => includeSuperseded ? approvalPolicyRepo.listAll(db, connectionId) : approvalPolicyRepo.listLive(db, connectionId), { readOnly: true });
      return rows.map(viewOf);
    },

    async setFloor(ctx: Context, input: {
      connectionId: string | null; minimumApprovals: number; minimumQualification: ApprovalPolicy['approverQualification']; riskClass: string | null;
      unwaivableMarkings: string[];
    }) {
      const { organisationId, membershipId } = memberOf(ctx, 'setting a policy floor');
      const id = uuidv7();
      try {
        await inTransaction(control, ctx.request, async (db) => {
          await policyFloorRepo.insert(db, {
            id, organisationId, connectionId: input.connectionId, minimumApprovals: input.minimumApprovals, minimumQualification: input.minimumQualification,
            riskClass: input.riskClass as never, unwaivableMarkings: input.unwaivableMarkings, setBy: membershipId,
          });
          await recordActionEvent(db, {
            organisationId, correlationId: ctx.correlationId, event: 'policy_floor_set', request: ctx.request, service: 'approvals',
            resource: { type: 'approval_policy', id }, detail: { connection_id: input.connectionId, minimum_approvals: input.minimumApprovals },
          });
        });
      } catch (error) {
        const mapped = fromDatabaseError(error);
        if (mapped.category === 'forbidden') throw new AppError('forbidden', 'policy floors are set by a super admin', { code: 'policy_floor.not_permitted' });
        if (mapped.details['sqlstate'] === '23503') {
          throw new AppError('validation', 'an unwaivable marking is not one this organisation has', { code: 'policy_floor.marking_unknown' });
        }
        throw error;
      }
      const floor = (await inTransaction(control, ctx.request, (db) => policyFloorRepo.findById(db, id), { readOnly: true }))!;
      return {
        id: floor.id, connectionId: floor.connectionId, minimumApprovals: floor.minimumApprovals, minimumQualification: floor.minimumQualification,
        riskClass: floor.riskClass, unwaivableMarkings: floor.unwaivableMarkings, setBy: floor.setBy, setAt: floor.setAt,
      };
    },
  };
}

export type Policies = ReturnType<typeof createPolicies>;
