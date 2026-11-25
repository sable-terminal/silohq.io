import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import { denial, invalid, notFound } from '../utils/error.util';
import { nextRun } from '../utils/cronParser.util';
import { log as writeAudit } from './audit.service';
import * as savedViewRepo from '../repos/savedView.repo';
import * as viewTransferRepo from '../repos/viewTransfer.repo';
import * as automationRepo from '../repos/automation.repo';
import type { Actor } from './scope.service';
import type { PoolClient } from 'pg';

/**
 * AUTH rev 7 — what happens to a saved view when the person who owned it goes.
 *
 * ── AN INHERITANCE IS A DECISION SOMEBODY HAS NOT TAKEN YET ───────────────
 *
 * "On removal, every view owned by that membership transfers to the admin above
 * them… Transferred views arrive FLAGGED, not shared." So this is not a change
 * of ownership that finishes when the row is updated: it opens a question, the
 * flag is the record that it is open, and the queue is where an admin answers
 * it. Until they do, the view is theirs alone.
 *
 * ── SUSPENSION, BECAUSE A DEPARTURE IS NOT A DECISION ─────────────────────
 *
 * rev 7's own reasoning: "A view the removed person had shared with three
 * colleagues keeps working only if the admin decides it should. Otherwise a
 * departure silently leaves shared access in place with an owner who no longer
 * exists, and nobody is accountable for it." Revoking those three shares would
 * be just as much of an unreviewed decision in the other direction — it would
 * quietly break three people's work — so they are held still and the admin
 * chooses. That is the whole reason `suspended_at` is not `revoked_at`.
 *
 * ── AND THE CRON IS A SECOND ACT ──────────────────────────────────────────
 *
 * "Crons attached to a transferred view remain paused until the receiving admin
 * both reviews the view AND EXPLICITLY RESUMES THEM… because resuming a
 * scheduled mutation under new ownership is a governance decision rather than a
 * housekeeping one." Deciding what a view is for and agreeing to let it act on
 * a schedule under your name are different agreements, and one button for both
 * would collect the second by accident.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

/**
 * Hand over everything one membership owned, in the transaction that removed
 * or suspended them.
 *
 * IN THAT TRANSACTION AND NOT AFTER IT, for the reason `pauseOnHalt` gives: a
 * membership cannot be left removed while its views still belong to it, not
 * even for the moment a second transaction would take. Either the person is
 * gone and their work has an owner, or neither happened.
 *
 * NOBODY ABOVE THEM IS NOT AN ERROR. An organisation with no admin over this
 * person and no super admin left is a broken organisation, and failing the
 * removal would make it a broken organisation that also cannot offboard
 * anybody. The views stay where they are — inert, since the owner cannot sign
 * in — and the removal goes through.
 */
export async function onMembershipChange(
  db: PoolClient,
  input: {
    organisationId: string;
    membershipId: string;
    reason: Extract<viewTransferRepo.TransferReason, 'member_removed' | 'member_suspended'>;
  },
): Promise<number> {
  const views = await savedViewRepo.listOwnedBy(db, input.membershipId);
  if (views.length === 0) return 0;

  const admin = await viewTransferRepo.receivingAdminFor(db, input.membershipId);
  if (!admin) return 0;

  const taken = new Set(await savedViewRepo.namesOwnedBy(db, admin.membershipId));

  for (const view of views) {
    /*
     * SHARES FIRST, SO THERE IS NO INSTANT WHERE THE VIEW IS BOTH TRANSFERRED
     * AND STILL OPEN. Inside one transaction nobody can observe the order, but
     * the order is the invariant being stated, and stating it in the code is
     * how it survives somebody splitting this loop later.
     */
    const sharesSuspended = await savedViewRepo.suspendSharesOf(db, view.id);
    const cronsPaused = await automationRepo.pauseAttachedToView(db, {
      viewId: view.id,
      reason: 'owner_removed',
    });

    const name = freeName(taken, view.name);
    taken.add(name);
    await savedViewRepo.transferTo(db, { viewId: view.id, membershipId: admin.membershipId, name });

    await viewTransferRepo.flag(db, {
      id: generateId(),
      organisationId: input.organisationId,
      viewId: view.id,
      transferredTo: admin.membershipId,
      transferredFrom: input.membershipId,
      reason: input.reason,
    });

    /*
     * WRITTEN AS THE SYSTEM, LIKE THE AUTOMATION PAUSE BESIDE IT. The admin who
     * removed the member did not choose who inherits; the rule did. The detail
     * names both people and the route the rule took, which is what somebody
     * asking "why did I get this" needs.
     */
    await writeAudit(db, {
      event: 'view_transferred',
      organisationId: input.organisationId,
      membershipId: null,
      userId: null,
      detail: {
        viewId: view.id,
        transferredTo: admin.membershipId,
        transferredFrom: input.membershipId,
        reason: input.reason,
        route: admin.route,
        sharesSuspended,
        cronsPaused: cronsPaused.length,
      },
    });
  }

  return views.length;
}

export type Inherited = viewTransferRepo.FlaggedView & {
  crons: Array<{
    id: string;
    name: string;
    schedule: string;
    status: automationRepo.Status;
    pausedReason: automationRepo.PausedReason | null;
    ownerMembershipId: string;
  }>;
};

/**
 * The queue.
 *
 * NO PERMISSION IS ASKED FOR, AND THAT IS NOT AN OVERSIGHT. This lists what was
 * given to this membership and nothing else; the permission that decided it was
 * the one that made them an admin over the person who left. A second gate here
 * would mean an admin could be handed a view and then be unable to look at it.
 */
export async function inherited(actor: Actor): Promise<Inherited[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const flags = await viewTransferRepo.listFor(db, actor.membershipId);

      return Promise.all(
        flags.map(async (flag) => ({
          ...flag,
          crons: (await automationRepo.attachedToView(db, flag.viewId)).map((cron) => ({
            id: cron.id,
            name: cron.name,
            schedule: cron.schedule,
            status: cron.status,
            pausedReason: cron.pausedReason,
            ownerMembershipId: cron.ownerMembershipId,
          })),
        })),
      );
    }),
  );
}

/**
 * Answer one: share it onward, keep it, or put it away.
 *
 * ── THE THREE ANSWERS, AND WHAT EACH DOES TO THE SUSPENDED SHARES ─────────
 *
 * `shared` restores them exactly as they were, which is the case suspension
 * exists for — the colleagues who were using it carry on, now under an owner
 * who exists and has agreed to it.
 *
 * `retained` and `archived` end them. After a review, "suspended" has nothing
 * left to mean: it is the state of waiting for this decision, and a share held
 * still for ever is a row whose intent nobody can read. Revoked says a person
 * ended it, which is true — the admin just did.
 */
export async function review(
  actor: Actor,
  flagId: string,
  decision: viewTransferRepo.TransferDecision,
): Promise<{ decision: viewTransferRepo.TransferDecision; sharesRestored: number; sharesRevoked: number }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const flag = await mustBeTheirs(db, actor, flagId);
      if (flag.reviewedAt) {
        throw invalid({
          message: 'This view has already been reviewed.',
          code: 'invalid.transfer_reviewed',
        });
      }

      const reviewed = await viewTransferRepo.review(db, { id: flagId, decision });
      if (!reviewed) {
        /* Somebody answered it between the read and the write. Theirs stands. */
        throw invalid({ message: 'This view has already been reviewed.', code: 'invalid.transfer_reviewed' });
      }

      const sharesRestored = decision === 'shared' ? await savedViewRepo.restoreSharesOf(db, flag.viewId) : 0;
      const sharesRevoked = decision === 'shared' ? 0 : await savedViewRepo.revokeSuspendedSharesOf(db, flag.viewId);

      if (decision === 'archived') await savedViewRepo.archive(db, flag.viewId);

      await writeAudit(db, {
        event: 'view_transfer_reviewed',
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        detail: { flagId, viewId: flag.viewId, decision, sharesRestored, sharesRevoked },
      });

      return { decision, sharesRestored, sharesRevoked };
    }),
  );
}

/**
 * Let a cron on an inherited view run again.
 *
 * REVIEWED FIRST, ALWAYS. rev 7 makes this two acts, and the order is not
 * arbitrary: agreeing to let a schedule act under your name before you have
 * decided what the view is for is the agreement nobody means to give. The
 * refusal says which act is missing.
 */
export async function resumeCron(
  actor: Actor,
  flagId: string,
  automationId: string,
): Promise<{ resumed: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const flag = await mustBeTheirs(db, actor, flagId);

      if (!flag.reviewedAt) {
        throw denial({
          message: 'Decide what happens to this view before you resume anything scheduled on it.',
          code: 'denial.transfer_unreviewed',
        });
      }
      if (flag.decision === 'archived') {
        throw invalid({
          message: 'This view was archived, so nothing scheduled on it can run.',
          code: 'invalid.transfer_archived',
        });
      }

      const automation = await automationRepo.read(db, automationId);
      if (!automation || automation.savedViewId !== flag.viewId) {
        throw notFound({ message: 'That cron is not on this view.', code: 'missing.automation' });
      }

      /*
       * COMPUTED FROM NOW, as every resume in the product is. §7 forbids
       * backfilling, and restoring the schedule it stopped on would fire
       * immediately for a window that passed while nobody owned it.
       */
      const resumed = await automationRepo.resume(db, {
        id: automationId,
        nextRunAt: nextRun(automation.schedule, new Date(), automation.timeZone),
      });

      if (resumed) {
        await writeAudit(db, {
          event: 'automation_resumed',
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          detail: { automationId, viewId: flag.viewId },
        });
      }

      return { resumed: resumed !== null };
    }),
  );
}

/**
 * The flag, if it was given to this person.
 *
 * A DENIAL RATHER THAN "NOT FOUND", for the reason `savedView.service` gives:
 * tenancy already hides another organisation's, so inside one organisation the
 * honest answer to somebody else's queue item is that it is not theirs.
 */
async function mustBeTheirs(
  db: PoolClient,
  actor: Actor,
  flagId: string,
): Promise<viewTransferRepo.TransferFlag> {
  const flag = await viewTransferRepo.findById(db, flagId);
  if (!flag) throw notFound({ message: 'That inherited view does not exist.', code: 'missing.transfer_flag' });

  if (flag.transferredTo !== actor.membershipId) {
    throw denial({ message: 'That view was inherited by somebody else.', code: 'denial.transfer_not_yours' });
  }
  return flag;
}

/**
 * A name the receiving admin does not already use.
 *
 * `saved_views` IS UNIQUE ON (OWNER, NAME). Two people calling a view "Overdue
 * invoices" is ordinary, and without this the second one leaving would abort
 * the removal transaction on a unique index — an offboarding that fails for a
 * reason with nothing to do with offboarding.
 *
 * THE ORIGINAL NAME IS KEPT WHERE IT CAN BE, because a view is known by what it
 * is called and the admin inheriting it has no other description of it.
 */
function freeName(taken: ReadonlySet<string>, name: string): string {
  if (!taken.has(name)) return name;

  /* 128 is the column's ceiling; the suffix has to fit inside it. */
  const base = name.slice(0, 110).trim();

  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? `${base} (inherited)` : `${base} (inherited ${attempt})`;
    if (!taken.has(candidate)) return candidate;
  }
}
