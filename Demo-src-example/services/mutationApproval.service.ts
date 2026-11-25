import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { denial, invalid, refusal } from '../utils/error.util';
import { generateId } from '../utils/tokens.util';
import { log as writeAudit } from './audit.service';
import { assertCan } from './authorisation.service';
import {
  assertMayChange,
  assertOverConnections,
  viewOf,
  visibleMutation,
  type MutationView,
} from './mutation.service';
import * as mutationRepo from '../repos/mutation.repo';
import * as mutationApprovalRepo from '../repos/mutationApproval.repo';
import * as executionRepo from '../repos/mutationExecution.repo';
import * as execution from './mutationExecution.service';
import * as mutationPolicyRepo from '../repos/mutationPolicy.repo';
import * as authzRepo from '../repos/authz.repo';
import * as scopeRepo from '../repos/scope.repo';
import { progressOf, resolvePolicy, unionOf } from '../engine/mutation/policy.mutation';
import type { Actor } from './scope.service';

/**
 * Mutations §9 — asking for approval, and deciding.
 *
 * ── Reuses the purge chain's rules, not its tables ─────────────────────────
 *
 * The chain built for Silo purges settled the questions that matter — the
 * person who asked is not the person who decides, a decision is append-only, an
 * approval that arrives after expiry is refused — and every one of them holds
 * here. What a change needs that a purge does not is a policy per connection,
 * a snapshot of it, a union across connections and a role requirement, so the
 * rows are its own.
 *
 * ── The last approval runs it ──────────────────────────────────────────────
 *
 * Unless the organisation separates running from approving, the approval that
 * satisfies the chain claims the change and queues it to run. Where it is
 * separated, somebody holding `mutation.execute` runs it before it lapses.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

const audit = (actor: Actor) => ({
  organisationId: actor.organisationId,
  membershipId: actor.membershipId,
  userId: null,
});

/* ── Asking ───────────────────────────────────────────────────────────────── */

/**
 * Ask for approval of a previewed change.
 *
 * ── The policy is resolved now and never again ─────────────────────────────
 *
 * Every connection the change writes resolves its own policy, most specific
 * first, with its floor applied; the union of them, with the bulk tier's extra
 * approver, is snapshotted onto the chain. A policy weakened a minute later
 * does not reach it, and the trigger on the table refuses any attempt to.
 *
 * ── The clock started at the preview ───────────────────────────────────────
 *
 * The window is counted from when the records were read, not from when
 * somebody asked. A preview left for twenty hours and then submitted under a
 * four-hour policy has already run out, and is refused rather than given four
 * more hours against data that is twenty hours old.
 */
export async function submit(actor: Actor, mutationId: string): Promise<MutationView> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const { mutation, authority } = await visibleMutation(db, actor, mutationId, { lock: true });
      assertCan(authority, 'mutation.propose');
      await assertMayChange(db, actor, { revert: Boolean(mutation.manifest.reverts) });

      if (mutation.proposedBy !== actor.membershipId) {
        throw denial({
          message: 'Only the person who proposed a change asks for it to be approved.',
          code: 'denial.not_proposer',
        });
      }

      if (mutation.status !== 'previewed') {
        throw invalid({
          message: 'Approval has already been asked for on that change.',
          code: 'invalid.mutation_state',
        });
      }

      const connectionIds = mutation.preview.connections.map((connection) => connection.connectionId);
      const policies = await mutationPolicyRepo.livePolicies(db);
      const floors = await mutationPolicyRepo.floors(db);
      const proposerPaths = await scopeRepo.pathsForMembership(db, mutation.proposedBy);

      const resolved = connectionIds.map((connectionId) =>
        resolvePolicy({
          connectionId,
          policies,
          proposerPaths,
          floor: floors.find((floor) => floor.connectionId === connectionId) ?? null,
        }),
      );

      const policy = unionOf(resolved, mutation.preview.bulk);

      const expiresAt = new Date(
        Math.min(
          mutation.createdAt.getTime() + policy.expiresAfterHours * 60 * 60 * 1000,
          mutation.expiresAt.getTime(),
        ),
      );

      if (expiresAt.getTime() <= Date.now()) {
        throw refusal({
          message:
            'That preview is older than approval may wait on it, so the records may have changed since. ' +
            'Propose the change again.',
          code: 'refusal.mutation_lapsed',
        });
      }

      await mutationApprovalRepo.createChain(db, {
        id: generateId(),
        mutationId: mutation.id,
        organisationId: actor.organisationId,
        policy,
        expiresAt,
      });

      await mutationRepo.setStatus(db, { id: mutation.id, status: 'awaiting_approval', expiresAt });

      for (const one of resolved.filter((each) => each.floorApplied)) {
        await writeAudit(db, {
          ...audit(actor),
          event: 'policy_floor_overrode_configured_policy',
          detail: {
            mutationId: mutation.id,
            connectionId: one.connectionId,
            configuredPolicy: one.configured,
            appliedFloor: one.applied,
          },
        });
      }

      await writeAudit(db, {
        ...audit(actor),
        event: 'approval_requested',
        detail: {
          mutationId: mutation.id,
          approvalsRequired: policy.approvalsRequired,
          requiredRoleIds: policy.requiredRoleIds,
          allowSelfApproval: policy.allowSelfApproval,
          separateExecution: policy.separateExecution,
          bulk: policy.bulk,
          expiresAt: expiresAt.toISOString(),
        },
      });

      const updated = await mutationRepo.find(db, mutation.id);
      return viewOf(db, updated!);
    }),
  );
}

/* ── Deciding ─────────────────────────────────────────────────────────────── */

/**
 * Approve or reject a change awaiting approval.
 *
 * ── Who ────────────────────────────────────────────────────────────────────
 *
 * An approval is from somebody holding `mutation.approve` over every connection
 * the change writes. The proposer approving their own change is refused unless
 * every connection's policy allows it — and then it counts, and is recorded as
 * a self-approval, by the database, where no caller can mislabel it.
 *
 * A REJECTION NEEDS NO SECOND PERSON. Any eligible approver may stop a change,
 * and so may the person who proposed it, which is how a proposal is withdrawn.
 * One rejection ends the chain: a change somebody entitled to object objected to
 * does not go ahead because enough others did not.
 *
 * ── When ───────────────────────────────────────────────────────────────────
 *
 * NOT AFTER EXPIRY. An approval that arrives late marks the chain expired and is
 * refused; the retention sweep then discards the mutation, rows and all.
 */
export async function decide(
  actor: Actor,
  mutationId: string,
  input: { decision: 'approve' | 'reject'; comment: string | null },
): Promise<MutationView> {
  const outcome = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const { mutation, authority } = await visibleMutation(db, actor, mutationId, { lock: true });
      const chain = await mutationApprovalRepo.lockChainOf(db, mutation.id);

      if (!chain || mutation.status === 'previewed') {
        throw invalid({ message: 'Approval has not been asked for on that change.', code: 'invalid.mutation_state' });
      }
      if (chain.status !== 'pending') {
        throw invalid({ message: `That change has already been ${chain.status}.`, code: 'invalid.approval_decided' });
      }

      /* Marked here and refused outside: throwing inside would roll the mark back. */
      if (chain.expiresAt.getTime() <= Date.now()) {
        /* `approval_expired` is the sweep's to write, when it discards the mutation. */
        await mutationApprovalRepo.settle(db, {
          chainId: chain.id,
          status: 'expired',
          approvalsReceived: chain.approvalsReceived,
        });
        return { expired: true as const, run: false };
      }

      const proposer = mutation.proposedBy === actor.membershipId;

      if (input.decision === 'approve') {
        await assertMayChange(db, actor, { revert: Boolean(mutation.manifest.reverts) });
        await assertOverConnections(db, authority, mutation, 'mutation.approve');

        if (proposer && !chain.policy.allowSelfApproval) {
          throw denial({
            message: 'The person who proposed this change cannot approve it.',
            code: 'denial.self_approval',
          });
        }
      } else if (!proposer) {
        await assertOverConnections(db, authority, mutation, 'mutation.approve');
      }

      if (input.decision === 'reject' && !input.comment?.trim()) {
        throw invalid({ message: 'Say why it is rejected.', code: 'invalid.approval_reason' });
      }

      if (chain.decisions.some((one) => one.approver === actor.membershipId)) {
        throw invalid({ message: 'You have already decided on this change.', code: 'invalid.approval_repeated' });
      }

      /* The roles held now are the roles this decision was made with. */
      const roleIds = [
        ...new Set((await authzRepo.effectiveAssignments(db, actor.membershipId)).map((one) => one.roleId)),
      ];

      const { selfApproval } = await mutationApprovalRepo.recordDecision(db, {
        chainId: chain.id,
        organisationId: actor.organisationId,
        sequence: chain.decisions.length + 1,
        approver: actor.membershipId,
        decision: input.decision,
        roleIds,
        comment: input.comment?.trim() || null,
      });

      if (input.decision === 'reject') {
        await mutationApprovalRepo.settle(db, {
          chainId: chain.id,
          status: 'rejected',
          approvalsReceived: chain.approvalsReceived,
        });
        /* Discarded at the next sweep: nothing will run, so nothing it read is kept for it. */
        await mutationRepo.setStatus(db, { id: mutation.id, status: 'rejected', expiresAt: new Date() });
        await writeAudit(db, {
          ...audit(actor),
          event: 'approval_rejected',
          detail: { mutationId: mutation.id, approverMembershipId: actor.membershipId },
        });
        return { expired: false as const, run: false };
      }

      const approvals = [
        ...chain.decisions.filter((one) => one.decision === 'approve'),
        { approver: actor.membershipId, roleIds },
      ];
      const progress = progressOf(chain.policy, approvals);

      /*
       * §9 — "recorded distinctly in audit rather than as an ordinary approval,
       * because a reviewer will ask how many changes were self-approved and the
       * answer must be countable."
       */
      await writeAudit(db, {
        ...audit(actor),
        event: selfApproval ? 'self_approval_used' : 'approval_granted',
        detail: {
          mutationId: mutation.id,
          approverMembershipId: actor.membershipId,
          sequence: chain.decisions.length + 1,
          approvalsReceived: approvals.length,
          approvalsRequired: chain.approvalsRequired,
        },
      });

      await mutationApprovalRepo.settle(db, {
        chainId: chain.id,
        status: progress.satisfied ? 'approved' : 'pending',
        approvalsReceived: approvals.length,
      });

      if (!progress.satisfied) return { expired: false as const, run: false };

      await mutationRepo.setStatus(db, { id: mutation.id, status: 'approved' });

      /*
       * §14 — "Where not separated, approval executes." Claimed in the same
       * transaction as the approval that completed the chain, so there is no
       * moment at which the change is approved and nothing has taken it.
       */
      if (chain.policy.separateExecution) return { expired: false as const, run: false };

      await executionRepo.claim(db, { id: mutation.id, from: ['approved'], executedBy: actor.membershipId });
      return { expired: false as const, run: true };
    }),
  );

  if (!outcome.expired && outcome.run) {
    execution.enqueue(actor.organisationId, mutationId);
  }

  if (outcome.expired) {
    throw refusal({
      message: 'Approval for that change ran out before it was given. Propose it again.',
      code: 'refusal.approval_expired',
    });
  }

  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const { mutation } = await visibleMutation(db, actor, mutationId);
      return viewOf(db, mutation);
    }),
  );
}
