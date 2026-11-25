import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { notFound, refusal } from '../utils/error.util';
import { generateId } from '../utils/tokens.util';
import { APPROVAL_TTL_HOURS } from '../config/constants.config';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf } from './authorisation.service';
import { visibleMutation } from './mutation.service';
import * as executionRepo from '../repos/mutationExecution.repo';
import * as mutationRepo from '../repos/mutation.repo';
import * as approvalRepo from '../repos/approval.repo';
import type { Actor } from './scope.service';

/**
 * Mutations — how long a change's receipt is kept, and deleting one sooner.
 *
 * ── The same rules as any stored data ──────────────────────────────────────
 *
 * §15: "Values live in the receipt, which is subject to the same retention and
 * purge rules as any stored data." So, as for a Silo: a window the organisation
 * chooses and the schema bounds, shortening it reaching what is already kept, a
 * purge available at any time, and that purge routed through the approval chain
 * where the organisation has configured one.
 *
 * ── Independent of the storage switch ──────────────────────────────────────
 *
 * None of this asks whether storage is on. A receipt exists because a write
 * happened, and it is kept, bounded and purgeable whatever the storage setting
 * or the build.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

const FINISHED: readonly mutationRepo.MutationStatus[] = ['executed', 'partially_executed', 'failed'];

export async function retention(actor: Actor): Promise<{ receiptDays: number }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      if (!['mutation.purge', 'mutation.approve', 'mutation.propose'].some((one) => authority.permissions.has(one))) {
        assertCan(authority, 'mutation.purge');
      }
      return { receiptDays: await executionRepo.receiptDays(db, actor.organisationId) };
    }),
  );
}

/**
 * Choose how long receipts are kept.
 *
 * SHORTENING DESTROYS DATA, AT ONCE. Every receipt older than the new window
 * can no longer be read or reverted from the moment this commits, and the next
 * sweep deletes it. That is `mutation.purge`'s to decide, as shortening a Silo's
 * window is `silo.purge`'s.
 */
export async function setRetention(actor: Actor, receiptDays: number): Promise<{ receiptDays: number }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'mutation.purge');

      const previous = await executionRepo.receiptDays(db, actor.organisationId);
      await executionRepo.setReceiptDays(db, { organisationId: actor.organisationId, days: receiptDays });

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'receipt_retention_changed',
        detail: { retentionDays: receiptDays, previousRetentionDays: previous },
      });

      return { receiptDays };
    }),
  );
}

export type PurgeOutcome =
  | { status: 'completed'; mutationId: string; records: number }
  | { status: 'pending'; approvalRequestId: string; approvalsRequired: number; expiresAt: Date };

/**
 * Delete a change's receipt, and everything kept for the change, now.
 *
 * ONLY A FINISHED CHANGE. One still waiting or running is withdrawn by
 * rejecting it, and lapses with everything it read; purging it mid-run would
 * leave records written with nothing to say so.
 *
 * THE AUDIT ROWS STAY. They carry identifiers, field names and counts, never a
 * value, and they are what says a change happened and was later deleted.
 */
export async function purge(actor: Actor, mutationId: string): Promise<PurgeOutcome> {
  const pending = await runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'mutation.purge');

      const { mutation } = await visibleMutation(db, actor, mutationId);
      if (!FINISHED.includes(mutation.status)) {
        throw refusal({
          message: 'That change has not finished, so it has no receipt to delete. Reject it to withdraw it.',
          code: 'refusal.nothing_to_purge',
        });
      }

      const policy = await approvalRepo.policyFor(db, 'mutation.purge');
      const approvalRequestId = policy ? generateId() : null;
      const expiresAt = policy ? new Date(Date.now() + APPROVAL_TTL_HOURS * 60 * 60 * 1000) : null;

      if (policy && approvalRequestId && expiresAt) {
        /* References only: the request names the change, never what it held. */
        await approvalRepo.createRequest(db, {
          id: approvalRequestId,
          organisationId: actor.organisationId,
          action: 'mutation.purge',
          subject: { mutationId },
          approvalsRequired: policy.approvalsRequired,
          requestedBy: actor.membershipId,
          expiresAt,
        });
      }

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'mutation_purge_requested',
        detail: { mutationId, approvalRequestId },
      });

      return policy && approvalRequestId && expiresAt
        ? { approvalRequestId, approvalsRequired: policy.approvalsRequired, expiresAt }
        : null;
    }),
  );

  if (pending) return { status: 'pending', ...pending };
  return { status: 'completed', ...(await executePurge(actor, { mutationId, approvedBy: null })) };
}

/**
 * Run a purge: straight away, or when the approval chain's last approval arrives.
 *
 * AS THE PERSON WHO ASKED, checked again now, as a Silo purge is.
 */
export async function executePurge(
  requester: Actor,
  input: { mutationId: string; approvedBy: string | null },
): Promise<{ mutationId: string; records: number }> {
  return runWithTenant(tenantOf(requester), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, requester.membershipId, requester.organisationId);
      assertCan(authority, 'mutation.purge');

      const { mutation } = await visibleMutation(db, requester, input.mutationId, { lock: true });
      if (!FINISHED.includes(mutation.status)) {
        throw refusal({ message: 'That change has not finished.', code: 'refusal.nothing_to_purge' });
      }

      if (!(await executionRepo.purge(db, mutation.id))) {
        throw notFound({ message: 'That change does not exist.', code: 'missing.mutation' });
      }

      await writeAudit(db, {
        organisationId: requester.organisationId,
        membershipId: requester.membershipId,
        userId: null,
        event: 'mutation_purged',
        detail: { mutationId: mutation.id, records: mutation.records, approverMembershipId: input.approvedBy },
      });

      return { mutationId: mutation.id, records: mutation.records };
    }),
  );
}
