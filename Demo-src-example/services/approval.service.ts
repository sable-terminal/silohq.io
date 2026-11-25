import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { denial, invalid, isAppError, notFound, refusal } from '../utils/error.util';
import { log as writeAudit } from './audit.service';
import { assertCan, assertCleared, authorityOf, can } from './authorisation.service';
import { childLogger } from '../config/logger.config';
import { env } from '../config/env.config';
import * as approvalRepo from '../repos/approval.repo';
import * as silo from './silo.service';
import * as mutationRetention from './mutationRetention.service';
import type { Actor } from './scope.service';

const log = childLogger('approval');

/**
 * The approval chain.
 *
 * ── What it is for ─────────────────────────────────────────────────────────
 *
 * Capture §4: a purge "routes through the approval chain where the organisation
 * has configured one. It is destructive and irreversible." An organisation says
 * which actions need a second person and how many; the person who asks cannot
 * be one of them; and the action runs when the last approval arrives — as the
 * person who asked, whose permission is checked again at that moment.
 *
 * ── Built for one action, shaped for more ───────────────────────────────────
 *
 * `silo.purge` is the only action today. Adding another is a value in two
 * CHECKs, an approver permission below, and a branch in `run` — discovery's
 * `approval_id` has been waiting for exactly this since 019.
 */

/** Who may decide a request for each action. Holding the action itself is the bar. */
const APPROVER_PERMISSION: Record<approvalRepo.ApprovalAction, string> = {
  'silo.purge': 'silo.purge',
  /* A change's receipt: the same kind of act, the same chain. */
  'mutation.purge': 'mutation.purge',
};

export async function setPolicy(
  actor: Actor,
  input: { action: approvalRepo.ApprovalAction; approvalsRequired: number },
): Promise<approvalRepo.ApprovalPolicy> {
  refuseUnavailable(input.action);

  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'approval.configure');

        const policy = await approvalRepo.setPolicy(db, {
          organisationId: actor.organisationId,
          action: input.action,
          approvalsRequired: input.approvalsRequired,
          configuredBy: actor.membershipId,
        });

        await writeAudit(db, {
          event: 'approval_policy_set',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { action: input.action, approvalsRequired: input.approvalsRequired },
        });

        return policy;
      }),
  );
}

/**
 * Stop requiring approval for an action.
 *
 * REQUESTS ALREADY WAITING STILL NEED THEIRS. Removing the policy changes what
 * happens to the next request; a request made under it was made on the
 * understanding that a second person would look, and still gets one.
 */
export async function removePolicy(actor: Actor, action: approvalRepo.ApprovalAction): Promise<void> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'approval.configure');

        if (!(await approvalRepo.removePolicy(db, action))) {
          throw notFound({ message: 'That action does not need approval.', code: 'missing.approval_policy' });
        }

        await writeAudit(db, {
          event: 'approval_policy_removed',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { action },
        });
      }),
  );
}

export async function policies(actor: Actor): Promise<approvalRepo.ApprovalPolicy[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        assertCan(authority, 'approval.configure');
        return approvalRepo.policies(db);
      }),
  );
}

export type RequestView = approvalRepo.ApprovalRequest & {
  /** Whether this person could decide it now. */
  canDecide: boolean;
};

/**
 * The requests this person could decide, and the ones they made.
 *
 * ONLY ACTIONS THEY COULD APPROVE, plus their own. A request to wipe a Silo
 * names the Silo and the concept, and somebody who could never decide it has no
 * reason to see it.
 */
export async function requests(
  actor: Actor,
  filter: { status?: approvalRepo.ApprovalStatus },
): Promise<RequestView[]> {
  return runWithTenant(
    { organisationId: actor.organisationId, membershipId: actor.membershipId },
    () =>
      withTransaction(async (db) => {
        const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
        const all = await approvalRepo.listRequests(db, { status: filter.status });
        const now = Date.now();

        return all
          .filter(
            (request) =>
              request.requestedBy === actor.membershipId ||
              can(authority, APPROVER_PERMISSION[request.action]),
          )
          .map((request) => ({
            ...request,
            status:
              request.status === 'pending' && request.expiresAt.getTime() <= now
                ? ('expired' as const)
                : request.status,
            canDecide:
              request.status === 'pending' &&
              request.expiresAt.getTime() > now &&
              request.requestedBy !== actor.membershipId &&
              !request.approvedBy.includes(actor.membershipId) &&
              can(authority, APPROVER_PERMISSION[request.action]),
          }));
      }),
  );
}

/**
 * Approve or reject a request, and run it when the last approval arrives.
 *
 * ── Three rules, each for a reason ─────────────────────────────────────────
 *
 * NOT THE PERSON WHO ASKED. Checked here and by a trigger on the table.
 *
 * NOT AFTER IT EXPIRES. A purge approved four days after it was asked for is an
 * approval of what the Silo held four days ago; `APPROVAL_TTL_HOURS` bounds it.
 *
 * RUN AS THE PERSON WHO ASKED. The approver said yes to somebody else's request;
 * they did not take it over. So the action runs with the requester's authority,
 * checked again now — a requester whose permission was revoked while the request
 * waited does not get the purge by having asked earlier.
 */
export async function decide(
  actor: Actor,
  requestId: string,
  input: { decision: 'approve' | 'reject'; reason?: string | null },
): Promise<RequestView> {
  const tenant = { organisationId: actor.organisationId, membershipId: actor.membershipId };

  const decided = await runWithTenant(tenant, () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      const request = await approvalRepo.lockRequest(db, requestId);

      if (!request || !(request.requestedBy === actor.membershipId || can(authority, APPROVER_PERMISSION[request.action]))) {
        throw notFound({ message: 'No such approval request.', code: 'missing.approval_request' });
      }

      if (request.status !== 'pending') {
        throw invalid({
          message: `That request has already been ${request.status}.`,
          code: 'invalid.approval_decided',
        });
      }

      /* Marked here, thrown outside: throwing inside would roll the mark back. */
      if (request.expiresAt.getTime() <= Date.now()) {
        await approvalRepo.setStatus(db, request.id, 'expired');
        return { expired: true as const };
      }

      assertCan(authority, APPROVER_PERMISSION[request.action]);

      if (request.requestedBy === actor.membershipId) {
        throw denial({
          message: 'The person who asked for this cannot approve or reject it.',
          code: 'denial.approval_own_request',
        });
      }

      if (request.approvedBy.includes(actor.membershipId)) {
        throw invalid({ message: 'You have already approved this.', code: 'invalid.approval_repeated' });
      }

      /* A marked concept's purge is decided by somebody cleared to see it. */
      const conceptId = request.subject.conceptId;
      if (typeof conceptId === 'string') {
        await assertCleared(db, authority, { type: 'concept', id: conceptId });
      }

      if (input.decision === 'reject' && !input.reason?.trim()) {
        throw invalid({ message: 'Say why it is rejected.', code: 'invalid.approval_reason' });
      }

      await approvalRepo.recordDecision(db, {
        requestId: request.id,
        organisationId: actor.organisationId,
        decidedBy: actor.membershipId,
        decision: input.decision,
        reason: input.reason?.trim() || null,
      });

      const siloId = typeof request.subject.siloId === 'string' ? request.subject.siloId : null;

      if (input.decision === 'reject') {
        await approvalRepo.setStatus(db, request.id, 'rejected');
        await writeAudit(db, {
          event: 'purge_rejected',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { siloId, approvalRequestId: request.id },
        });
        return { expired: false as const, run: false, request };
      }

      const approvals = request.approvedBy.length + 1;

      await writeAudit(db, {
        event: 'purge_approved',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: {
          siloId,
          approvalRequestId: request.id,
          approvalsRequired: request.approvalsRequired,
        },
      });

      if (approvals < request.approvalsRequired) {
        return { expired: false as const, run: false, request };
      }

      await approvalRepo.setStatus(db, request.id, 'approved');
      return { expired: false as const, run: true, request };
    }),
  );

  if (decided.expired) {
    throw invalid({
      message: 'That request expired before it was decided. Ask again.',
      code: 'invalid.approval_expired',
    });
  }

  if (decided.run) {
    await run(decided.request, actor);
  }

  const [view] = (await requests(actor, {})).filter((one) => one.id === requestId);
  if (!view) throw notFound({ message: 'No such approval request.', code: 'missing.approval_request' });
  return view;
}

/**
 * Run an approved request, and record what happened either way.
 *
 * FAILURE IS RECORDED, THEN RAISED. An approved purge that could not run — the
 * requester lost the permission, the Silo was already gone — must not sit at
 * `approved` looking like it is about to happen.
 *
 * THE ORGANISATION IS THE APPROVER'S, which is the request's: the request was
 * read under the approver's tenant, and row level security would not have
 * returned it otherwise.
 */
async function run(request: approvalRepo.ApprovalRequest, approver: Actor): Promise<void> {
  const requester: Actor = { organisationId: approver.organisationId, membershipId: request.requestedBy };
  const tenant = { organisationId: approver.organisationId, membershipId: request.requestedBy };

  try {
    const outcome =
      request.action === 'mutation.purge'
        ? await mutationRetention.executePurge(requester, {
            mutationId: String(request.subject.mutationId),
            approvedBy: approver.membershipId,
          })
        : await silo.executePurge(requester, {
            siloId: String(request.subject.siloId),
            target: targetOf(request.subject),
            approvedBy: approver.membershipId,
          });

    await runWithTenant(tenant, () =>
      withTransaction((db) =>
        approvalRepo.setStatus(
          db,
          request.id,
          'executed',
          'receiptId' in outcome ? { receiptId: outcome.receiptId } : { mutationId: outcome.mutationId },
        ),
      ),
    );
  } catch (error: unknown) {
    const code = isAppError(error) ? error.code : 'upstream.unexpected';
    log.warn({ requestId: request.id, code }, 'Approved request could not run');

    await runWithTenant(tenant, () =>
      withTransaction((db) => approvalRepo.setStatus(db, request.id, 'failed', { code })),
    );
    throw error;
  }
}

function targetOf(subject: Record<string, unknown>): silo.PurgeRequest {
  switch (subject.scope) {
    case 'silo':
      return { scope: 'silo' };
    case 'concept':
      return { scope: 'concept', conceptId: String(subject.conceptId) };
    case 'entity':
      return {
        scope: 'entity',
        conceptId: String(subject.conceptId),
        entityRef: String(subject.entityRef),
      };
    case 'file':
      return { scope: 'file', fileId: String(subject.fileId) };
    case 'object':
      return { scope: 'object', sourceId: String(subject.sourceId), objectName: String(subject.objectName) };
    default:
      throw invalid({ message: 'That request names no purge.', code: 'invalid.approval_subject' });
  }
}

function refuseUnavailable(action: approvalRepo.ApprovalAction): void {
  if (action === 'silo.purge' && !env.SILOES_AVAILABLE) {
    throw refusal({
      message: 'This deployment is built without storage, so there is nothing to purge.',
      code: 'refusal.siloes_compiled_out',
    });
  }
}
