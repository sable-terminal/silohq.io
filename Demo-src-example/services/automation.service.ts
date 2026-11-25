import { withTransaction } from '../infra/db.infra';
import { runWithTenant } from '../utils/tenantContext.util';
import { generateId } from '../utils/tokens.util';
import { childLogger } from '../config/logger.config';
import { bounds, denial, notFound } from '../utils/error.util';
import { isValid, nextRun } from '../utils/cronParser.util';
import { log as writeAudit } from './audit.service';
import { assertCan, authorityOf } from './authorisation.service';
import { send } from '../infra/mailer.infra';
import * as automationRepo from '../repos/automation.repo';
import * as savedViewRepo from '../repos/savedView.repo';
import * as findingRepo from '../repos/finding.repo';
import * as membershipRepo from '../repos/membership.repo';
import * as userRepo from '../repos/user.repo';
import * as organisationRepo from '../repos/organisation.repo';
import * as conceptQuery from './conceptQuery.service';
import * as mutationService from './mutation.service';
import * as mutationExecution from './mutationExecution.service';
import * as fileService from './file.service';
import { entitlementsFor } from './billing.service';
import { APPROVAL_SECOND_APPROVER_ROWS } from '../config/constants.config';
import {
  digestOf,
  evaluate,
  FINDING_OPERATORS,
  RESULT_OPERATORS,
  VALUE_OPERATORS,
  type Condition,
  type RaisedFinding,
} from '../models/automationCondition.model';
import { DETECTORS } from '../models/finding.model';
import type { Actor } from './scope.service';
import type { PoolClient } from 'pg';

const log = childLogger('automation');

/**
 * §1 — a saved question, a condition over its result, and something done when
 * it holds. It runs on a schedule without anyone present.
 *
 * ── What an automation may do, in increasing order of consequence ─────────
 *
 * §14 builds notify-only first, and says why: "Notify-only automations are a
 * complete and useful product on their own. Everything after step one is an
 * increase in what an automation may do without a person."
 *
 * All of it is here now: notify, report, escalate, and both mutate modes.
 * Propose puts a change in the approvals queue and a named person decides;
 * execute-within-bounds writes with nobody present, under an authorisation
 * that names four limits and a person. This header said "the code that could
 * write does not exist" long after it did, which is the kind of comment that
 * makes a reader stop looking for the thing they are looking at.
 *
 * ── The run history is the product, not the debugging ──────────────────────
 *
 * §11 — "Every run is visible, including the ones where the condition did not
 * hold. An automation that has not fired in three months is either working or
 * broken, and the run history is the only way to tell." So every run writes a
 * row, including the ones that did nothing and the ones that skipped.
 */

const tenantOf = (actor: Actor) => ({ organisationId: actor.organisationId, membershipId: actor.membershipId });

/**
 * §7 — the floor when an organisation has no entitlements at all.
 *
 * THE STRICTEST OF THE THREE PLANS, deliberately. "A question running every
 * minute is a cost the customer did not intend" — and an organisation nobody
 * has decided anything about is exactly the one that should not be able to
 * schedule the most expensive thing. A plan then loosens it.
 */
const UNENTITLED_INTERVAL_MINUTES = 60;

/*
 * A claim older than this is a crashed runner, not a long run. Generous
 * relative to the job's own 30 minute task timeout, so a slow run is never
 * mistaken for a dead one — the failure this prevents is an automation paused
 * forever by a process that died holding it.
 */
const STALE_CLAIM_MINUTES = 90;

/*
 * §5 — "Over one hundred rows, an automation in execute mode does not proceed;
 * it falls back to propose."
 *
 * THE SAME NUMBER THE MUTATION PATH USES for its additional-approval tier, and
 * now genuinely the same one. This was a local `const APPROVAL_SECOND_APPROVER_ROWS = 100`
 * under a comment claiming it was imported — which is worse than a plain copy,
 * because it tells the next reader not to check.
 */

export type Detail = automationRepo.Automation & {
  conditions: automationRepo.Condition[];
  actions: automationRepo.Action[];
};

/* ── Creating one ────────────────────────────────────────────────────────── */

export async function create(
  actor: Actor,
  input: {
    name: string;
    /** §3 — omitted where the automation watches the checks instead. */
    savedViewId?: string | null;
    schedule: string;
    conditions: Array<{
      kind?: 'result' | 'finding' | 'value';
      operator: string;
      /** A detector name, for a finding condition. */
      target?: string | null;
      value?: unknown;
      combinator?: 'and' | 'or';
    }>;
    /** §3 — narrow the checks to one concept. Findings automations only. */
    conceptId?: string | null;
    notify?: { email?: string | null } | null;
    /*
     * §5 — the change to prepare when the condition holds, in either of its two
     * modes. `execute` carries the four bounds; without it this is propose
     * mode, which §5 calls the default and which writes nothing.
     */
    mutate?: {
      intent: string;
      operation: 'update' | 'delete';
      set?: Record<string, string | number | boolean | null>;
      resolution?: 'strict' | 'partial';
      execute?: {
        maxRows: number;
        permittedFields: string[];
        permittedConnections: string[];
        expiresAt: Date;
      } | null;
    } | null;
    /*
     * §4 — "Raise it to a named membership or scope for a decision. A notify
     * that requires acknowledgement rather than one that can be ignored."
     */
    escalate?: { membershipId?: string | null; scopeId?: string | null } | null;
    /*
     * §4 — "Produce an export and put it in Files, with the permissions of
     * whoever owns the automation."
     */
    report?: { format?: 'json' | 'csv' } | null;
    failurePolicy?: automationRepo.FailurePolicy;
    pauseAfter?: number | null;
  },
): Promise<Detail> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      assertCan(authority, 'automation.create');

      /*
       * §3 — an automation watches a question or it watches the checks, and
       * which one is decided by whether a view was named. A findings automation
       * has "no question to author at all"; a view automation without a view is
       * a broken one, and the schema refuses both halves being present.
       */
      const source: automationRepo.Source = input.savedViewId ? 'view' : 'findings';

      if (source === 'view') {
        const view = await savedViewRepo.read(db, input.savedViewId!);
        if (!view) throw notFound({ message: 'That saved view does not exist.', code: 'missing.view' });

        /*
         * THE VIEW MUST BE THE CALLER'S. §6 — "An automation cannot exceed its
         * owner." Scheduling somebody else's question would be the first way
         * around that, before any mutate action existed to make it dangerous.
         */
        if (view.ownerMembershipId !== actor.membershipId) {
          throw denial({
            message: 'That saved view belongs to somebody else.',
            code: 'denial.view_not_owned',
          });
        }
      }

      /* §7 — "Minimum interval per plan." */
      const entitlements = await entitlementsFor(db, actor.organisationId);
      assertSchedule(input.schedule, entitlements?.minimumIntervalMinutes ?? UNENTITLED_INTERVAL_MINUTES);
      for (const condition of input.conditions) assertCondition(source, condition);

      /* §7 — their 9am, not the server's. */
      const organisation = await organisationRepo.findById(db, actor.organisationId);
      const timeZone = organisation?.calendar.timeZone ?? 'UTC';

      const automation = await automationRepo.create(db, {
        id: generateId(),
        organisationId: actor.organisationId,
        ownerMembershipId: actor.membershipId,
        name: input.name,
        source,
        savedViewId: input.savedViewId ?? null,
        schedule: input.schedule,
        timeZone,
        failurePolicy: input.failurePolicy ?? 'notify_and_continue',
        pauseAfter: input.failurePolicy === 'pause_after_failures' ? (input.pauseAfter ?? 3) : null,
        nextRunAt: nextRun(input.schedule, new Date(), timeZone),
      });

      let sequence = 0;
      for (const condition of input.conditions) {
        await automationRepo.addCondition(db, {
          id: generateId(),
          organisationId: actor.organisationId,
          automationId: automation.id,
          kind: condition.kind ?? (source === 'findings' ? 'finding' : 'result'),
          /* A finding condition's target is the detector; null means any. */
          target: condition.target ?? null,
          operator: condition.operator,
          /* §3 — a concept narrows the checks, and rides with the condition so
             two conditions on one automation can watch different concepts. */
          value:
            condition.value !== undefined
              ? condition.value
              : input.conceptId
                ? { conceptId: input.conceptId }
                : undefined,
          combinator: condition.combinator ?? 'and',
          sequence: sequence++,
        });
      }

      let actionSequence = 0;

      if (input.notify) {
        await automationRepo.addAction(db, {
          id: generateId(),
          organisationId: actor.organisationId,
          automationId: automation.id,
          kind: 'notify',
          configuration: { email: input.notify.email ?? null },
          sequence: actionSequence++,
        });
      }

      if (input.mutate) {
        /*
         * §10 — TWO PERMISSIONS, AND THE SECOND IS NOT CHECKED HERE.
         * `automation.mutate` is permission to put a change on a schedule;
         * `mutation.propose` over the connections involved is checked when the
         * proposal is actually made, against the owner as they are at that
         * moment. Checking it now as well would let an automation keep
         * proposing after the grant that allowed it was withdrawn.
         */
        assertCan(authority, 'automation.mutate');

        /* §5 — a change needs an entity set, and a findings automation has no
           question to take one from. */
        if (source !== 'view') {
          throw bounds({
            message: 'A change can only be attached to an automation that asks a question.',
            code: 'bounds.mutate_needs_view',
          });
        }

        if (input.mutate.operation === 'update' && Object.keys(input.mutate.set ?? {}).length === 0) {
          throw bounds({
            message: 'An update that sets nothing would change nothing.',
            code: 'bounds.mutate_sets_nothing',
          });
        }

        await automationRepo.addAction(db, {
          id: generateId(),
          organisationId: actor.organisationId,
          automationId: automation.id,
          kind: 'mutate',
          configuration: {
            intent: input.mutate.intent,
            operation: input.mutate.operation,
            set: input.mutate.set ?? {},
            resolution: input.mutate.resolution ?? 'strict',
          },
          sequence: actionSequence++,
        });
      }

      if (input.escalate) {
        const { membershipId, scopeId } = input.escalate;

        /* Exactly one target, as the table insists: an escalation addressed to
           two things is one whose meaning depends on which was read first. */
        if ((membershipId ? 1 : 0) + (scopeId ? 1 : 0) !== 1) {
          throw bounds({
            message: 'An escalation goes to one person or one scope, not both and not neither.',
            code: 'bounds.escalate_target',
          });
        }

        await automationRepo.addAction(db, {
          id: generateId(),
          organisationId: actor.organisationId,
          automationId: automation.id,
          kind: 'escalate',
          configuration: { membershipId: membershipId ?? null, scopeId: scopeId ?? null },
          sequence: actionSequence++,
        });
      }

      if (input.report) {
        /* §4 — a report is an export of the question, so there must be one. */
        if (source !== 'view') {
          throw bounds({
            message: 'A report is an export of a question, and this automation asks none.',
            code: 'bounds.report_needs_view',
          });
        }

        await automationRepo.addAction(db, {
          id: generateId(),
          organisationId: actor.organisationId,
          automationId: automation.id,
          kind: 'report',
          configuration: { format: input.report.format ?? 'csv' },
          sequence: actionSequence++,
        });
      }

      if (actionSequence === 0) {
        throw bounds({
          message: 'An automation that does nothing when it fires is not worth scheduling.',
          code: 'bounds.no_action',
        });
      }

      await writeAudit(db, {
        organisationId: actor.organisationId,
        membershipId: actor.membershipId,
        userId: null,
        event: 'automation_created',
        detail: {
          automationId: automation.id,
          viewId: input.savedViewId ?? null,
          schedule: input.schedule,
          timeZone,
        },
      });

      /*
       * §5 — "only inside limits set when the automation was created".
       *
       * IN THE SAME TRANSACTION, AND AFTER THE CREATION IS RECORDED. Either the
       * check and the authorisation both exist or neither does: an automation
       * created live while its bounds failed to write would run in propose mode
       * under a name that believes it was authorised, and the audit reads in the
       * order the two things happened.
       */
      if (input.mutate?.execute) {
        await grantExecution(db, actor, authority, automation.id, input.mutate.execute);
      }

      return detailOf(db, automation);
    }),
  );
}

export async function mine(actor: Actor): Promise<Detail[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const automations = await automationRepo.listOwnedBy(db, actor.membershipId);
      return Promise.all(automations.map((automation) => detailOf(db, automation)));
    }),
  );
}

export async function read(actor: Actor, id: string): Promise<Detail> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => detailOf(db, await mustReach(db, actor, id))),
  );
}

/** §11 — every run, including the ones that did nothing. */
export async function history(actor: Actor, id: string): Promise<automationRepo.Run[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await mustReach(db, actor, id);
      return automationRepo.runsFor(db, id);
    }),
  );
}

export async function pause(actor: Actor, id: string): Promise<{ paused: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await mustReach(db, actor, id);
      const paused = await automationRepo.pause(db, { id, reason: 'owner' });

      if (paused) {
        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'automation_paused',
          detail: { automationId: id, reason: 'owner' },
        });
      }
      return { paused: paused !== null };
    }),
  );
}

/**
 * §9 — "Resuming is its own action, because resuming a scheduled change under
 * new ownership is a governance decision."
 *
 * THE NEXT RUN IS COMPUTED FROM NOW, NOT FROM WHERE IT STOPPED. §7 forbids
 * backfilling, and a resume that restored the old `next_run_at` would fire
 * immediately for a window that has passed.
 */
export async function resume(actor: Actor, id: string): Promise<{ resumed: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const automation = await mustReach(db, actor, id);
      const resumed = await automationRepo.resume(db, {
        id,
        nextRunAt: nextRun(automation.schedule, new Date(), automation.timeZone),
      });

      if (resumed) {
        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'automation_resumed',
          detail: { automationId: id },
        });
      }
      return { resumed: resumed !== null };
    }),
  );
}

export async function remove(actor: Actor, id: string): Promise<{ removed: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      await mustReach(db, actor, id);
      const removed = await automationRepo.remove(db, id);

      if (removed) {
        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'automation_deleted',
          detail: { automationId: id },
        });
      }
      return { removed };
    }),
  );
}

/* ── Paused by something other than a person ─────────────────────────────── */

/**
 * §8 — "A halted connection pauses every automation depending on it, and says
 * so."
 *
 * SAYS SO, WHICH IS HALF THE REQUIREMENT. Silently pausing produces the same
 * silence as the false negative §8 guards against: a check that stops telling
 * you things, for a reason nobody was told. Each pause is audited and the owner
 * is emailed.
 *
 * CALLED IN THE HALTING TRANSACTION, so a connection cannot be halted while a
 * scheduled check is left pointing at it.
 */
export async function pauseOnHalt(
  db: PoolClient,
  input: { organisationId: string; connectionId: string },
): Promise<number> {
  const paused = await automationRepo.pauseDependingOn(db, {
    connectionId: input.connectionId,
    reason: 'halted',
  });

  for (const automation of paused) {
    await writeAudit(db, {
      organisationId: input.organisationId,
      membershipId: null,
      userId: null,
      event: 'automation_paused_on_halt',
      detail: { automationId: automation.id, connectionId: input.connectionId, reason: 'halted' },
    });
  }

  /*
   * TOLD AFTER THE TRANSACTION, NOT INSIDE IT. A slow mail provider must not
   * hold a lock on the connection being halted, and one that is down must not
   * roll the halt back.
   */
  if (paused.length > 0) {
    void tellOwners(input.organisationId, paused, 'a system it reads stopped answering');
  }

  return paused.length;
}

/**
 * §9 — "On owner removal, automations pause and surface to the admin above them
 * for review. They do not continue running under a removed identity."
 *
 * SUSPENSION PAUSES TOO, by §6's rule that an automation's permissions are the
 * intersection of its grant and what its owner holds AT RUN TIME. A suspended
 * owner holds nothing, so the automation would fail every run until somebody
 * noticed — pausing says what happened instead.
 *
 * AND NEITHER RESUMES BY ITSELF. §9 — "Resuming is its own action, because
 * resuming a scheduled change under new ownership is a governance decision."
 */
export async function pauseOnOwnerChange(
  db: PoolClient,
  input: { organisationId: string; membershipId: string; reason: 'owner_removed' },
): Promise<number> {
  const paused = await automationRepo.pauseOwnedBy(db, {
    membershipId: input.membershipId,
    reason: input.reason,
  });

  for (const automation of paused) {
    await writeAudit(db, {
      organisationId: input.organisationId,
      membershipId: null,
      userId: null,
      event: 'automation_paused_on_owner_removal',
      detail: { automationId: automation.id, targetMembershipId: input.membershipId, reason: input.reason },
    });
  }

  return paused.length;
}

/** Best effort, and outside any transaction. See `pauseOnHalt`. */
async function tellOwners(
  organisationId: string,
  paused: ReadonlyArray<{ id: string; ownerMembershipId: string; name: string }>,
  because: string,
): Promise<void> {
  for (const automation of paused) {
    await notify(
      {
        id: automation.id,
        organisationId,
        ownerMembershipId: automation.ownerMembershipId,
        name: automation.name,
      } as automationRepo.Automation,
      { id: '', kind: 'notify', configuration: {}, sequence: 0 },
      { rowCount: 0, because: [`This check has been paused because ${because}.`] },
    ).catch(() => undefined);
  }
}

/* ── Running them ────────────────────────────────────────────────────────── */

/** Everything due. Cross-tenant: the scheduler's, and only the scheduler's. */
export async function due(db: PoolClient, at = new Date()): Promise<Array<{ id: string; organisationId: string }>> {
  await automationRepo.releaseStale(db, new Date(at.getTime() - STALE_CLAIM_MINUTES * 60_000));
  return automationRepo.due(db, at);
}

export type RunOutcome = 'met' | 'not_met' | 'skipped' | 'failed';

/**
 * Run one automation, as the system, under its organisation's tenancy.
 *
 * ── Claimed before anything else happens ──────────────────────────────────
 *
 * §7 — "A run still in progress when the next is due skips rather than queues.
 * Two concurrent runs of the same automation proposing the same change is a
 * duplicate nobody asked for." The claim is a conditional update, so two
 * runners cannot both win it.
 *
 * ── It asks as the OWNER, not as an administrator ─────────────────────────
 *
 * §6 — "Its permissions are the intersection of what the automation was granted
 * and what its owner holds at run time... If the owner could not make this
 * change by hand today, the automation cannot make it tonight." So the question
 * is asked with the owner's membership, and their permissions are re-checked
 * inside `ask` at the moment it runs. An owner who lost a grant yesterday gets
 * a failed run today, which is the honest outcome.
 */
export async function runOne(input: { id: string; organisationId: string }, at = new Date()): Promise<RunOutcome> {
  const tenant = { organisationId: input.organisationId, membershipId: null };

  const claimed = await runWithTenant(tenant, () =>
    withTransaction(async (db) => {
      const automation = await automationRepo.read(db, input.id);
      if (!automation || automation.status !== 'active') return null;
      return (await automationRepo.claim(db, input.id, at)) ? automation : null;
    }),
  );

  if (!claimed) {
    /*
     * §11 — a skip is a run. Recorded so somebody reading the history can see
     * that the schedule fired and found the previous run still going, rather
     * than seeing an unexplained gap.
     */
    await runWithTenant(tenant, () =>
      withTransaction(async (db) => {
        const runId = generateId();
        await automationRepo.startRun(db, {
          id: runId,
          organisationId: input.organisationId,
          automationId: input.id,
        });
        await automationRepo.finishRun(db, {
          id: runId,
          conditionOutcome: null,
          actionsTaken: [],
          error: null,
          skippedReason: 'already_running',
        });
        await writeAudit(db, {
          organisationId: input.organisationId,
          membershipId: null,
          userId: null,
          event: 'automation_run_skipped',
          detail: { automationId: input.id, reason: 'already_running' },
        });
      }),
    );
    return 'skipped';
  }

  const runId = generateId();
  await runWithTenant(tenant, () =>
    withTransaction(async (db) => {
      await automationRepo.startRun(db, {
        id: runId,
        organisationId: input.organisationId,
        automationId: input.id,
      });
      await writeAudit(db, {
        organisationId: input.organisationId,
        membershipId: null,
        userId: null,
        event: 'automation_run_started',
        detail: { automationId: input.id },
      });
    }),
  );

  try {
    const outcome = await execute(claimed, runId, at);
    return outcome;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await fail(claimed, runId, message, at);
    return 'failed';
  } finally {
    await runWithTenant(tenant, () =>
      withTransaction((db) =>
        automationRepo.release(db, {
          id: claimed.id,
          lastRunAt: at,
          nextRunAt: nextRun(claimed.schedule, at, claimed.timeZone),
        }),
      ),
    );
  }
}

async function execute(
  automation: automationRepo.Automation,
  runId: string,
  at: Date,
): Promise<RunOutcome> {
  const tenant = { organisationId: automation.organisationId, membershipId: null };

  const setup = await runWithTenant(tenant, () =>
    withTransaction(async (db) => ({
      view: automation.savedViewId ? await savedViewRepo.read(db, automation.savedViewId) : null,
      conditions: await automationRepo.conditionsFor(db, automation.id),
      actions: await automationRepo.actionsFor(db, automation.id),
      previous: await automationRepo.stateFor(db, automation.id),
    })),
  );

  /* §6 — as the owner, with their permissions as they are now. */
  const owner: Actor = {
    organisationId: automation.organisationId,
    membershipId: automation.ownerMembershipId,
  } as Actor;

  let rowCount = 0;
  let resultHash = digestOf([]);
  let findings: RaisedFinding[] = [];
  let figure: number | null = null;

  if (automation.source === 'view') {
    if (!setup.view) throw new Error('The saved view this runs on no longer exists.');

    const answer = await conceptQuery.ask(owner, {
      conceptId: setup.view.conceptId,
      query: setup.view.query,
    });

    rowCount = answer.entities.length;
    resultHash = digestOf(answer.entities);
    figure = figureFrom(answer, setup.conditions);
  } else {
    /*
     * §3 — "the checks already run and the automation becomes 'tell me when
     * this kind of problem appears', with no question to author at all."
     *
     * SINCE THE LAST RUN, NOT EVERYTHING OUTSTANDING. Matching whatever
     * currently exists would mean the same email every fifteen minutes for as
     * long as the problem lasts, which teaches somebody to filter it. A
     * detector re-raising an existing finding moves its `detected_at`, so a
     * recurrence still arrives here.
     */
    findings = await runWithTenant(tenant, () =>
      withTransaction((db) => raisedFor(db, automation, setup.conditions)),
    );
    rowCount = findings.length;
    resultHash = digestOf(findings.map((one) => ({ members: [{ connectionId: one.detector, ref: one.id }] })));
  }

  const outcome = evaluate(setup.conditions as Condition[], {
    rowCount,
    resultHash,
    findings,
    figure,
    previousFigure: setup.previous?.previousFigure ?? null,
    unchangedSince: setup.previous?.figureUnchangedSince ?? null,
    now: at,
    previous: setup.previous
      ? { resultHash: setup.previous.previousResultHash, rowCount: setup.previous.previousRowCount }
      : null,
  });

  const taken: Array<{ kind: string; outcome: string; detail?: string }> = [];

  if (outcome.met) {
    for (const action of setup.actions) {
      taken.push(
        action.kind === 'mutate'
          ? await propose(automation, owner, setup.view!, action, at)
          : action.kind === 'escalate'
            ? await escalate(automation, runId, action, outcome.because)
            : action.kind === 'report'
              ? await report(automation, owner, setup.view!, action)
              : await notify(automation, action, { rowCount, because: outcome.because }),
      );
    }
  }

  await runWithTenant(tenant, () =>
    withTransaction(async (db) => {
      await automationRepo.rememberState(db, {
        organisationId: automation.organisationId,
        automationId: automation.id,
        resultHash,
        rowCount,
        figure,
        at,
      });

      await automationRepo.finishRun(db, {
        id: runId,
        conditionOutcome: outcome.met ? 'met' : 'not_met',
        actionsTaken: taken,
        error: null,
        skippedReason: null,
      });

      await automationRepo.clearFailures(db, automation.id);

      await writeAudit(db, {
        organisationId: automation.organisationId,
        membershipId: null,
        userId: null,
        event: outcome.met ? 'automation_condition_met' : 'automation_condition_not_met',
        detail: { automationId: automation.id, records: rowCount },
      });

      for (const action of taken) {
        await writeAudit(db, {
          organisationId: automation.organisationId,
          membershipId: null,
          userId: null,
          event: 'automation_action_taken',
          detail: { automationId: automation.id, kind: action.kind, outcome: action.outcome },
        });
      }
    }),
  );

  log.info({ automationId: automation.id, met: outcome.met, rowCount, at }, 'Automation ran');
  return outcome.met ? 'met' : 'not_met';
}

/**
 * §4 — "Tell someone. No approval, no write, no risk."
 *
 * THE RUN ROW IS THE IN-PRODUCT ITEM. §11 says Home shows crons that ran and
 * found something; a run with its condition met IS that item, so there is no
 * second notifications table for the same fact to drift from.
 *
 * EMAIL IS BEST-EFFORT AND SAYS SO. A provider being down must not make the run
 * look like it failed to check — the check happened, and the row records that
 * the telling did not.
 */
async function notify(
  automation: automationRepo.Automation,
  action: automationRepo.Action,
  result: { rowCount: number; because: string[] },
): Promise<{ kind: string; outcome: string; detail?: string }> {
  const configured = typeof action.configuration.email === 'string' ? action.configuration.email : null;

  const address =
    configured ??
    (await runWithTenant({ organisationId: automation.organisationId, membershipId: null }, () =>
      withTransaction(async (db) => {
        /* The membership names the person; the address is theirs, not the
           membership's, because one user can hold several. */
        const member = await membershipRepo.findById(db, automation.ownerMembershipId);
        if (!member) return null;
        return (await userRepo.findById(db, member.userId))?.email ?? null;
      }),
    ));

  if (!address) return { kind: 'notify', outcome: 'no_address' };

  const sent = await send({
    to: address,
    subject: `Silo: ${automation.name}`,
    text: [
      `Your scheduled check "${automation.name}" found something.`,
      '',
      ...result.because,
      '',
      `${result.rowCount} record(s) matched.`,
    ].join('\n'),
  });

  return sent.sent
    ? { kind: 'notify', outcome: 'sent' }
    : { kind: 'notify', outcome: 'not_sent', detail: sent.error };
}

/**
 * §8 — the owner is told, and a policy decides whether it keeps going.
 *
 * "A failing automation that silently keeps failing is worse than one that
 * stops." A source going halted, a credential expiring or a concept being
 * retired all arrive here.
 */
async function fail(
  automation: automationRepo.Automation,
  runId: string,
  message: string,
  at: Date,
): Promise<void> {
  const tenant = { organisationId: automation.organisationId, membershipId: null };

  const failures = await runWithTenant(tenant, () =>
    withTransaction(async (db) => {
      await automationRepo.finishRun(db, {
        id: runId,
        conditionOutcome: null,
        actionsTaken: [],
        error: message,
        skippedReason: null,
      });

      const count = await automationRepo.recordFailure(db, automation.id);

      await writeAudit(db, {
        organisationId: automation.organisationId,
        membershipId: null,
        userId: null,
        event: 'automation_run_failed',
        detail: { automationId: automation.id, attempts: count, reason: message.slice(0, 200) },
      });

      return count;
    }),
  );

  if (
    automation.failurePolicy === 'pause_after_failures' &&
    automation.pauseAfter !== null &&
    failures >= automation.pauseAfter
  ) {
    await runWithTenant(tenant, () =>
      withTransaction(async (db) => {
        const paused = await automationRepo.pause(db, { id: automation.id, reason: 'failures' });
        if (paused) {
          await writeAudit(db, {
            organisationId: automation.organisationId,
            membershipId: null,
            userId: null,
            event: 'automation_paused',
            detail: { automationId: automation.id, reason: 'failures', attempts: failures },
          });
        }
      }),
    );
  }

  await notify(automation, { id: '', kind: 'notify', configuration: {}, sequence: 0 }, {
    rowCount: 0,
    because: [`The check could not run: ${message}`],
  }).catch(() => undefined);

  log.warn({ automationId: automation.id, failures, at }, 'Automation failed');
}

/**
 * §5 — write it, without a person, inside the limits somebody set.
 *
 * ── Every bound is checked here, against this run ─────────────────────────
 *
 * The authorisation says at most N rows, only these fields, only these
 * connections, and only until a date. The date and the revocation are applied
 * when it is read; the other three are applied to the preview that was just
 * computed, because they are claims about THIS change and not about the
 * automation in general.
 *
 * ── Anything outside them falls back to propose, and says why ─────────────
 *
 * §5 — "Over one hundred rows, an automation in execute mode does not proceed;
 * it falls back to propose. Over ten thousand is refused outright rather than
 * running a canary unattended." The proposal already exists by the time this
 * runs, so falling back costs nothing and loses nothing: the change is in the
 * queue either way, and the only question is whether a person has to look.
 *
 * ── §5's second mode, which used to be unreachable ────────────────────────
 *
 * This proposed the change and then called the human execution path, which
 * requires an approved chain and refuses whoever proposed it. An automation
 * proposes its own mutation and has no second person, so the call threw every
 * time, was caught, and was logged as `refused` — the route, the permission,
 * the bounds table and `automation_executed_mutation` all described a
 * capability the code could not perform. It failed closed, which is the right
 * direction and not a reason to leave it.
 *
 * ── The authorising person is on the run, not just on the authorisation ───
 *
 * §5 — "The authorising person is recorded on every run, not just at creation.
 * The receipt names who authorised the automation, not the automation itself,
 * because a change with no human name attached is the thing an auditor
 * rejects."
 */
async function executeWithin(
  automation: automationRepo.Automation,
  owner: Actor,
  proposed: { id: string; preview: { records: number; connections: Array<{ connectionId: string }> } },
  authorisation: automationRepo.Authorisation,
  configuration: { operation: 'update' | 'delete'; set: Record<string, unknown> },
): Promise<{ kind: string; outcome: string; detail?: string }> {
  const records = proposed.preview.records;

  /*
   * §5 — "A named set of connections it may reach."
   *
   * THIS WAS THE ONE OF THE FOUR THAT NOTHING CHECKED. It was validated at the
   * door, stored, made unchangeable by a trigger and read back on every run —
   * and then dropped, while the paragraph above this function asserted that
   * "the other three are applied to the preview that was just computed". Three
   * of the four bounds §5 calls REQUIRED were two.
   *
   * It is the bound that matters most of the three, too: a row count and a
   * field list limit how much of one system an automation may change, and this
   * one limits WHICH SYSTEMS it may touch at all. An automation authorised
   * against a sandbox could reach production.
   */
  const unreachable = proposed.preview.connections
    .map((connection) => connection.connectionId)
    .find((connectionId) => !authorisation.permittedConnections.includes(connectionId));

  const outside =
    records > authorisation.maxRows
      ? `it would change ${records} records and the limit is ${authorisation.maxRows}`
      : records >= APPROVAL_SECOND_APPROVER_ROWS
        ? `it would change ${records} records, and unattended writes stop at ${APPROVAL_SECOND_APPROVER_ROWS}`
        : Object.keys(configuration.set).find((field) => !authorisation.permittedFields.includes(field))
          ? `it writes a field the authorisation does not name`
          : unreachable
            ? `it reaches a system the authorisation does not name`
            : null;

  if (outside) {
    log.info({ automationId: automation.id, mutationId: proposed.id }, 'Falling back to propose');
    return { kind: 'mutate', outcome: 'proposed_over_bounds', detail: outside };
  }

  try {
    /*
     * EXECUTED AS THE OWNER, and the mutation path re-checks everything it
     * would for a person: the policy gate, the field policies, the read-back
     * verification. §1 — "Nothing an automation does is exempt from the
     * governance that applies when a person does it."
     */
    const ran = await mutationExecution.executeAuthorised(owner, proposed.id, {
      id: authorisation.id,
      authorisedBy: authorisation.authorisedBy,
    });

    /*
     * A REFUSAL IS NOT AN ERROR. The change stays a proposal, which is what §5
     * says happens when an unattended write cannot be made: it falls back to
     * the approvals queue and a named person decides. It used to arrive here
     * as a thrown exception from the human execution path, get caught below,
     * and be recorded as `refused` with a message about approval state.
     */
    if (!ran.started) {
      return { kind: 'mutate', outcome: 'proposed_over_bounds', detail: ran.because };
    }

    await runWithTenant({ organisationId: automation.organisationId, membershipId: null }, () =>
      withTransaction((db) =>
        writeAudit(db, {
          organisationId: automation.organisationId,
          /* The AUTHORISING person, not the owner and not the automation. */
          membershipId: authorisation.authorisedBy,
          userId: null,
          event: 'automation_executed_mutation',
          detail: {
            automationId: automation.id,
            mutationId: proposed.id,
            authorisationId: authorisation.id,
            records,
            /* §5 — all four bounds are visible in the trail, so a reviewer can
               see what the write was held to rather than what it did. */
            connections: proposed.preview.connections.length,
          },
        }),
      ),
    );

    return { kind: 'mutate', outcome: 'executed', detail: proposed.id };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ automationId: automation.id, reason: message }, 'Unattended write refused');
    return { kind: 'mutate', outcome: 'refused', detail: message.slice(0, 200) };
  }
}

/**
 * §4 — "Produce an export and put it in Files, with the permissions of whoever
 * owns the automation."
 *
 * ── The permissions requirement is satisfied by WHO asks, not by anything here ─
 *
 * Files §3 redacts an export to what the exporting person may see and freezes
 * their markings, policies and grants onto the file. So producing it as the
 * owner is the whole of "with the permissions of whoever owns the automation",
 * and a report cannot contain a field its owner could not read on screen.
 *
 * ── A REFUSAL IS THE ACTION'S OUTCOME, NOT THE RUN'S FAILURE ─────────────
 *
 * The same rule the mutate action follows. An owner who has lost `file.export`
 * produces no report, and that is recorded against the action — the check still
 * ran, and pausing the automation for it under §8 would be punishing it for
 * noticing.
 */
async function report(
  automation: automationRepo.Automation,
  owner: Actor,
  view: savedViewRepo.SavedView,
  action: automationRepo.Action,
): Promise<{ kind: string; outcome: string; detail?: string }> {
  const format = (action.configuration as { format?: 'json' | 'csv' }).format ?? 'csv';

  try {
    const produced = await fileService.exportView(owner, {
      viewId: view.id,
      format,
      /* Named for the check that produced it, so a folder of them reads as a
         history rather than as the same filename repeated. */
      name: `${view.name} — ${automation.name}`,
    });

    return { kind: 'report', outcome: 'produced', detail: produced.id };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ automationId: automation.id, reason: message }, 'Automation could not produce a report');
    return { kind: 'report', outcome: 'refused', detail: message.slice(0, 200) };
  }
}

/**
 * §4 — raise it to somebody, and require an answer.
 *
 * A ROW, NOT A LOUDER EMAIL. The difference between notify and escalate is that
 * this one has a state: it stays outstanding until a named person answers it,
 * and "which of these has nobody picked up" is the question the action exists
 * to make askable. An email cannot answer that.
 *
 * THE MAIL IS STILL SENT, because an escalation nobody is told about is one
 * that waits until somebody happens to look at a list.
 */
async function escalate(
  automation: automationRepo.Automation,
  runId: string,
  action: automationRepo.Action,
  because: readonly string[],
): Promise<{ kind: string; outcome: string; detail?: string }> {
  const target = action.configuration as { membershipId: string | null; scopeId: string | null };
  const id = generateId();

  await runWithTenant({ organisationId: automation.organisationId, membershipId: null }, () =>
    withTransaction(async (db) => {
      await automationRepo.raiseEscalation(db, {
        id,
        organisationId: automation.organisationId,
        automationId: automation.id,
        runId,
        membershipId: target.membershipId,
        scopeId: target.scopeId,
        because: because.join(' '),
      });

      await writeAudit(db, {
        organisationId: automation.organisationId,
        membershipId: null,
        userId: null,
        event: 'automation_escalated',
        /* Both named, one null. The table already insists exactly one is set,
           so the trail says which without a conditional spread the audit
           scanner cannot see the keys of. */
        detail: {
          automationId: automation.id,
          escalationId: id,
          targetMembershipId: target.membershipId,
          scopeId: target.scopeId,
        },
      });
    }),
  );

  return { kind: 'escalate', outcome: 'raised', detail: id };
}

/**
 * §11 — "Home shows crons that ran and found something."
 *
 * NO PERMISSION, BECAUSE IT IS THE CALLER'S OWN. A feed of what your own
 * scheduled checks found is yours by construction; `automation.manage` reaches
 * somebody else's automations, and reaching their findings through a feed would
 * be a different thing from being able to pause their schedule.
 */
export async function fired(actor: Actor): Promise<Array<automationRepo.Run & { automationName: string }>> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction((db) => automationRepo.firedFor(db, { membershipId: actor.membershipId })),
  );
}

/**
 * §4 — what is waiting on the caller, and answering one.
 */
export async function outstanding(actor: Actor, includeAnswered = false): Promise<automationRepo.Escalation[]> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction((db) =>
      automationRepo.escalationsFor(db, { membershipId: actor.membershipId, includeAnswered }),
    ),
  );
}

/**
 * Answer an escalation.
 *
 * ONLY SOMEBODY IT WAS RAISED TO. An escalation answered by whoever saw it
 * first is a notification again — the requirement is that a NAMED person, or
 * somebody in a named scope, has picked it up.
 */
export async function acknowledge(
  actor: Actor,
  id: string,
  note: string | null,
): Promise<{ acknowledged: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const mine = await automationRepo.escalationsFor(db, {
        membershipId: actor.membershipId,
        includeAnswered: true,
      });

      if (!mine.some((one) => one.id === id)) {
        throw denial({
          message: 'That was not raised to you.',
          code: 'denial.escalation_not_yours',
        });
      }

      const acknowledged = await automationRepo.acknowledge(db, {
        id,
        membershipId: actor.membershipId,
        note,
      });

      if (acknowledged) {
        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'automation_escalation_acknowledged',
          detail: { escalationId: id },
        });
      }

      return { acknowledged };
    }),
  );
}

/**
 * §5 — authorise an automation to write without a person present.
 *
 * ── The four bounds are required together, because three of them is none ───
 *
 * A row limit with no field list bounds how much damage, not what kind. A field
 * list with no expiry bounds it forever. §5 lists four things execute mode
 * "requires" and the schema makes all four NOT NULL, so this cannot be
 * half-configured by an argument somebody forgot to pass.
 *
 * ── Its own route as well as its own block on creation ────────────────────
 *
 * §5 says the bounds are "set at creation", and `create` takes them for exactly
 * that reason. This route is for the check that was created in propose mode and
 * is being trusted with more later, and for authorising again after a
 * withdrawal. Both doors go through `grantExecution`, so the permission, the
 * row ceiling and the trail cannot differ between them.
 *
 * ── The bounds are unchangeable, by anything ──────────────────────────────
 *
 * §5 — "set at creation and unchangeable by the automation itself". They are
 * unchangeable by ANYTHING here: widening them means withdrawing and
 * authorising again, which puts a new name and a new date on the decision
 * rather than editing the old one quietly.
 */
export async function authoriseExecution(
  actor: Actor,
  id: string,
  input: {
    maxRows: number;
    permittedFields: string[];
    permittedConnections: string[];
    expiresAt: Date;
  },
): Promise<{ authorisationId: string; expiresAt: Date }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
      const automation = await mustReach(db, actor, id);

      const actions = await automationRepo.actionsFor(db, automation.id);
      if (!actions.some((one) => one.kind === 'mutate')) {
        throw bounds({
          message: 'This check proposes nothing, so there is nothing to authorise.',
          code: 'bounds.nothing_to_authorise',
        });
      }

      const authorisation = await grantExecution(db, actor, authority, automation.id, input);
      return { authorisationId: authorisation.id, expiresAt: authorisation.expiresAt };
    }),
  );
}

/**
 * §5 — write down the limits an unattended write is held to.
 *
 * ONE PATH FOR BOTH DOORS. Authorising as the automation is created and
 * authorising it afterwards are the same act: the same permission, the same row
 * ceiling, the same row in the same table, and the same audit event. A second
 * copy of any of those is a bound that holds at one door and not the other,
 * which is how the bound that "nothing checked" got lost once already.
 */
async function grantExecution(
  db: PoolClient,
  actor: Actor,
  authority: Awaited<ReturnType<typeof authorityOf>>,
  automationId: string,
  input: {
    maxRows: number;
    permittedFields: string[];
    permittedConnections: string[];
    expiresAt: Date;
  },
): Promise<automationRepo.Authorisation> {
  /*
   * §10 — "automation.execute is deliberately separate and should be rare. It is
   * the only permission in the product that allows a write with nobody present."
   * Separate from `automation.create`, so somebody who may schedule a proposal
   * cannot schedule a write by adding four numbers to the same request.
   */
  assertCan(authority, 'automation.execute');

  /*
   * §5 — "Over one hundred rows, an automation in execute mode does not
   * proceed; it falls back to propose." So authorising more than that is
   * refused at the door rather than silently ignored at run time: a number
   * accepted here and disregarded later is a bound nobody can trust.
   */
  if (input.maxRows > APPROVAL_SECOND_APPROVER_ROWS) {
    throw bounds({
      message: `Unattended writes stop at ${APPROVAL_SECOND_APPROVER_ROWS} rows; above that a person approves.`,
      code: 'bounds.execute_row_limit',
    });
  }

  /*
   * §5 — "An expiry date on the authorisation", and one already past is not a
   * date on it. The table's own constraint refuses this as an error; said here
   * it is an answer, naming the field somebody has to change.
   */
  if (input.expiresAt.getTime() <= Date.now()) {
    throw bounds({
      message: 'An authorisation to write unattended has to expire in the future.',
      code: 'bounds.execute_expiry',
    });
  }

  /*
   * ONE LIVE AUTHORISATION, which the unique index also insists on. Reaching it
   * through the index would be a constraint violation rather than a sentence,
   * and the sentence matters: the bounds in force are not widened by sending
   * wider ones, they are replaced by withdrawing and deciding again.
   */
  if (await automationRepo.liveAuthorisation(db, { automationId, at: new Date() })) {
    throw bounds({
      message: 'This check is already authorised to write unattended. Withdraw that first.',
      code: 'bounds.already_authorised',
    });
  }

  const authorisation = await automationRepo.authorise(db, {
    id: generateId(),
    organisationId: actor.organisationId,
    automationId,
    maxRows: input.maxRows,
    permittedFields: input.permittedFields,
    permittedConnections: input.permittedConnections,
    authorisedBy: actor.membershipId,
    expiresAt: input.expiresAt,
  });

  await writeAudit(db, {
    organisationId: actor.organisationId,
    membershipId: actor.membershipId,
    userId: null,
    event: 'automation_authorised',
    detail: {
      automationId,
      authorisationId: authorisation.id,
      records: input.maxRows,
      fields: input.permittedFields,
      connections: input.permittedConnections.length,
      expiresAt: input.expiresAt.toISOString(),
    },
  });

  return authorisation;
}

export async function revokeExecution(actor: Actor, id: string): Promise<{ revoked: boolean }> {
  return runWithTenant(tenantOf(actor), () =>
    withTransaction(async (db) => {
      const automation = await mustReach(db, actor, id);
      const revoked = await automationRepo.revokeAuthorisation(db, automation.id);

      if (revoked) {
        await writeAudit(db, {
          organisationId: actor.organisationId,
          membershipId: actor.membershipId,
          userId: null,
          event: 'automation_authorisation_revoked',
          detail: { automationId: automation.id },
        });
      }
      return { revoked };
    }),
  );
}

/**
 * §5 — prepare the change and put it in the approvals queue.
 *
 * ── THE ENTITY SET IS THE QUESTION'S, NOT A SECOND FILTER ─────────────────
 *
 * The manifest's `where` is the saved view's own, so the change addresses
 * exactly the records the condition was evaluated against. Letting the action
 * carry its own filter would mean an automation whose condition watched one set
 * and whose change touched another, and the two would drift the first time
 * somebody edited either.
 *
 * ── PROPOSED AS THE OWNER, WHICH IS WHERE THE REAL CHECK HAPPENS ──────────
 *
 * §10 — "The automation permission governs the schedule; the mutation
 * permission governs the change." `mutation.propose` and the policy gate are
 * enforced inside `mutation.propose` against the owner as they are now, so an
 * owner who lost the grant yesterday gets a failed run rather than a proposal.
 * §6 — "If the owner could not make this change by hand today, the automation
 * cannot make it tonight."
 *
 * ── A REFUSAL IS THE RUN'S OUTCOME, NOT THE RUN'S FAILURE ─────────────────
 *
 * A bulk guardrail or a policy gate refusing is the product working. It is
 * recorded against the action, and the run still completes — otherwise §8's
 * failure policy would pause an automation for behaving correctly.
 */
async function propose(
  automation: automationRepo.Automation,
  owner: Actor,
  view: savedViewRepo.SavedView,
  action: automationRepo.Action,
  at: Date,
): Promise<{ kind: string; outcome: string; detail?: string }> {
  const configuration = action.configuration as {
    intent: string;
    operation: 'update' | 'delete';
    set: Record<string, string | number | boolean | null>;
    resolution: 'strict' | 'partial';
  };

  /*
   * §5 — the bounds, read fresh on every run rather than remembered from
   * creation. An authorisation revoked this morning stops this evening's write,
   * and an expired one stops it without anybody doing anything.
   */
  const authorisation = await runWithTenant(
    { organisationId: automation.organisationId, membershipId: null },
    () =>
      withTransaction((db) =>
        automationRepo.liveAuthorisation(db, { automationId: automation.id, at }),
      ),
  );

  try {
    const proposed = await mutationService.propose(owner, {
      intent: configuration.intent,
      manifest: {
        conceptId: view.conceptId,
        operation: configuration.operation,
        where: view.query.where,
        set: configuration.set,
        resolution: configuration.resolution,
      },
    });

    await runWithTenant({ organisationId: automation.organisationId, membershipId: null }, () =>
      withTransaction((db) =>
        writeAudit(db, {
          organisationId: automation.organisationId,
          membershipId: automation.ownerMembershipId,
          userId: null,
          event: 'automation_proposed_mutation',
          detail: {
            automationId: automation.id,
            mutationId: proposed.id,
            operation: configuration.operation,
          },
        }),
      ),
    );

    /*
     * §5 — WITHOUT AN AUTHORISATION THIS IS WHERE IT STOPS, which is propose
     * mode and the default. The proposal is in the queue and a person decides.
     */
    if (!authorisation) return { kind: 'mutate', outcome: 'proposed', detail: proposed.id };

    return executeWithin(automation, owner, proposed, authorisation, configuration);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ automationId: automation.id, reason: message }, 'Automation could not propose a change');
    return { kind: 'mutate', outcome: 'refused', detail: message.slice(0, 200) };
  }
}

/**
 * §3 — "a single figure the question returns".
 *
 * WHICH FIGURE IS NAMED, OR THERE IS ONLY ONE. A question can carry several
 * totals, and picking the first of them silently would mean a condition that
 * watched whichever aggregate happened to be listed first — and moved to a
 * different one the day somebody edited the view. An ambiguous target is a
 * failure the owner is told about, under §8, rather than a guess.
 */
function figureFrom(
  answer: conceptQuery.ConceptAnswer,
  conditions: readonly automationRepo.Condition[],
): number | null {
  const wanted = conditions.filter((one) => one.kind === 'value');
  if (wanted.length === 0) return null;

  const named = wanted.find((one) => one.target)?.target ?? null;

  if (!named) {
    if (answer.aggregates.length === 0) {
      throw new Error('This watches a figure, and the question returns none.');
    }
    if (answer.aggregates.length > 1) {
      throw new Error('This watches a figure, and the question returns several without saying which.');
    }
    return answer.aggregates[0]!.value;
  }

  const match = answer.aggregates.find((one) => one.fieldPath === named);
  if (!match) throw new Error(`The question no longer returns a total for "${named}".`);

  return match.value;
}

/**
 * §3 — what the checks raised since this automation last looked.
 *
 * THE UNION OF WHAT THE CONDITIONS ASK FOR, FETCHED ONCE. Each condition names
 * at most a detector and a concept; a query per condition would read the same
 * rows repeatedly and, worse, could hand each condition a different set if a
 * detector ran in between — so two conditions on one automation would be
 * answering about different worlds.
 */
async function raisedFor(
  db: PoolClient,
  automation: automationRepo.Automation,
  conditions: readonly automationRepo.Condition[],
): Promise<RaisedFinding[]> {
  const seen = new Map<string, RaisedFinding>();

  for (const condition of conditions) {
    if (condition.kind !== 'finding') continue;

    const value = (condition.value ?? {}) as { conceptId?: string };

    const raised = await findingRepo.raisedSince(db, {
      membershipId: automation.ownerMembershipId,
      since: automation.lastRunAt,
      detector: condition.target,
      conceptId: value.conceptId ?? null,
    });

    for (const finding of raised) seen.set(finding.id, finding);
  }

  return [...seen.values()];
}

/* ── Shared ──────────────────────────────────────────────────────────────── */

function assertSchedule(schedule: string, minimumMinutes: number): void {
  if (!isValid(schedule)) {
    throw bounds({
      message: 'That is not a five-field schedule.',
      code: 'bounds.schedule_invalid',
    });
  }

  /*
   * §7 — "Minimum interval per plan, because a question running every minute is
   * a cost the customer did not intend." Checked by asking the parser for two
   * consecutive runs rather than by pattern-matching the expression, because a
   * step of five minutes and an explicit list of 0,5,10,... are the same
   * schedule written two ways and only one of them looks fast.
   */
  const first = nextRun(schedule, new Date(), 'UTC');
  const second = first ? nextRun(schedule, first, 'UTC') : null;

  if (!first || !second) {
    throw bounds({ message: 'That schedule never fires.', code: 'bounds.schedule_never' });
  }

  const minutes = (second.getTime() - first.getTime()) / 60_000;
  if (minutes < minimumMinutes) {
    throw bounds({
      message: `On this plan a scheduled check can run at most every ${minimumMinutes} minutes.`,
      code: 'bounds.schedule_too_often',
      detail: { requested: minutes },
    });
  }
}

/**
 * A condition the engine can actually answer, against the thing it watches.
 *
 * A RESULT CONDITION ON A FINDINGS AUTOMATION IS REFUSED, and the other way
 * round. "Returned any rows" has no meaning where no question was asked, and
 * storing it would make an automation that never fires for a reason nobody can
 * see from the row.
 */
function assertCondition(
  source: automationRepo.Source,
  condition: { kind?: string; operator: string; target?: string | null },
): void {
  const kind = condition.kind ?? (source === 'findings' ? 'finding' : 'result');

  if (source === 'findings' && kind !== 'finding') {
    throw bounds({
      message: 'An automation with no saved view can only carry finding conditions.',
      code: 'bounds.condition_kind',
    });
  }
  /* §3 — a value condition reads a figure the question returned, so it belongs
     on a view automation beside the result conditions. */
  if (source === 'view' && kind !== 'result' && kind !== 'value') {
    throw bounds({
      message: 'An automation on a saved view can only carry result or value conditions.',
      code: 'bounds.condition_kind',
    });
  }

  const allowed =
    kind === 'finding' ? FINDING_OPERATORS : kind === 'value' ? VALUE_OPERATORS : RESULT_OPERATORS;
  if (!(allowed as readonly string[]).includes(condition.operator)) {
    throw bounds({
      message: `"${condition.operator}" is not a condition this can evaluate.`,
      code: 'bounds.condition_operator',
    });
  }

  if (kind === 'finding' && condition.target && !(DETECTORS as readonly string[]).includes(condition.target)) {
    throw bounds({
      message: `"${condition.target}" is not one of the checks.`,
      code: 'bounds.unknown_detector',
    });
  }
}

/**
 * The automation, if the caller may reach it.
 *
 * §10 — the owner always may; `automation.manage` reaches somebody else's.
 */
async function mustReach(db: PoolClient, actor: Actor, id: string): Promise<automationRepo.Automation> {
  const automation = await automationRepo.read(db, id);
  if (!automation) throw notFound({ message: 'That automation does not exist.', code: 'missing.automation' });

  if (automation.ownerMembershipId === actor.membershipId) return automation;

  const authority = await authorityOf(db, actor.membershipId, actor.organisationId);
  assertCan(authority, 'automation.manage');
  return automation;
}

async function detailOf(db: PoolClient, automation: automationRepo.Automation): Promise<Detail> {
  return {
    ...automation,
    conditions: await automationRepo.conditionsFor(db, automation.id),
    actions: await automationRepo.actionsFor(db, automation.id),
  };
}
