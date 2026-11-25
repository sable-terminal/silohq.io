// actions' endpoints: parsed input to the actions service and back.

import type {
  getActionType, listActionTypes, proposeActionType, publishActionTypeVersion, rejectActionType, retireActionType,
} from '../../contracts/actions/actionType.contract.ts';
import type {
  checkMutation, confirmCanary, executeMutation, getMutation, getReceipt, listMutations, listObjectCommits, listRecentWrites, proposeCronMutation,
  proposeMutation,
} from '../../contracts/actions/mutation.contract.ts';
import type { getActionSettings, setCanarySample, setGenericEdit, setPhysicalDryRun } from '../../contracts/actions/settings.contract.ts';
import type { createCronMutations } from '../../services/actions/cronMutations.service.ts';
import type { ActionSettings } from '../../services/actions/settings.service.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { ActionTypes } from '../../services/actions/actionTypes.service.ts';
import type { WriteBackDeps } from '../../services/actions/deps.service.ts';
import type { Execution } from '../../services/actions/execute.service.ts';
import type { createProposals } from '../../services/actions/propose.service.ts';
import type { Receipts } from '../../services/actions/receipts.service.ts';
import type {
  createActionEventSubscription, listActionEventSubscriptions, setActionEventSubscriptionStatus,
} from '../../contracts/actions/actionEvent.contract.ts';
import { subscriptionViewOf, type EventSubscriptions } from '../../services/actions/eventSubscriptions.service.ts';
import { actionEventSubscriptionRepo } from '../../repos/action/index.repo.ts';
import { mutationView } from '../../services/actions/store.service.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { mutationRepo, mutationTargetRepo } from '../../repos/action/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';

export function actionsController(deps: WriteBackDeps, parts: {
  actionTypes: ActionTypes; proposals: ReturnType<typeof createProposals>; execution: Execution; receipts: Receipts; subscriptions: EventSubscriptions;
  cronMutations: ReturnType<typeof createCronMutations>; settings: ActionSettings;
}) {
  const { actionTypes, proposals, execution, receipts, subscriptions, cronMutations, settings } = parts;
  return {
    proposeType: {
      handle: ({ body }, ctx) => actionTypes.propose(ctx, body),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => actionTypes.get(ctx, ref!),
    } satisfies RouteHandlers<typeof proposeActionType>,
    publishVersion: {
      handle: ({ params, body }, ctx) => actionTypes.publish(ctx, params.actionTypeId, body),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => actionTypes.get(ctx, ref!),
    } satisfies RouteHandlers<typeof publishActionTypeVersion>,
    getType: {
      handle: ({ params }, ctx) => actionTypes.get(ctx, params.actionTypeId),
    } satisfies RouteHandlers<typeof getActionType>,
    listTypes: {
      handle: async ({ query }, ctx) => ({ actionTypes: await actionTypes.list(ctx, query.status, query.limit, query.objectTypeId) }),
    } satisfies RouteHandlers<typeof listActionTypes>,
    retireType: {
      handle: ({ params, body }, ctx) => actionTypes.retire(ctx, params.actionTypeId, body.version),
    } satisfies RouteHandlers<typeof retireActionType>,
    rejectType: {
      handle: ({ params, body }, ctx) => actionTypes.reject(ctx, params.actionTypeId, body.version, body.reason),
    } satisfies RouteHandlers<typeof rejectActionType>,
    propose: {
      handle: ({ body }, ctx) => {
        // Only simulation promotes a staged Action, and simulation only promotes (39.8).
        if ((body.promotion !== undefined) !== (ctx.caller === 'simulation')) {
          throw new AppError('forbidden', 'a promotion comes from a scenario branch, through simulation', { code: 'mutation.promotion_caller' });
        }
        return proposals.propose(ctx, body);
      },
      resultRef: (out) => out.id,
      replay: (ref, ctx) => mutationView(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof proposeMutation>,
    get: {
      handle: ({ params }, ctx) => mutationView(deps, ctx, params.mutationId),
    } satisfies RouteHandlers<typeof getMutation>,
    check: {
      handle: ({ body }, ctx) => proposals.check(ctx, body),
    } satisfies RouteHandlers<typeof checkMutation>,
    recentWrites: {
      async handle({ body }, ctx) {
        return { writes: await inTransaction(deps.databases.pool('control'), ctx.request, (db) => mutationTargetRepo.writesSince(db, body.objectIds, body.since), { readOnly: true }) };
      },
    } satisfies RouteHandlers<typeof listRecentWrites>,
    list: {
      async handle({ query }, ctx) {
        const ids = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => mutationRepo.list(db, query.status, query.limit), { readOnly: true });
        return { mutations: await Promise.all(ids.map((id) => mutationView(deps, ctx, id, { withPreview: false }))) };
      },
    } satisfies RouteHandlers<typeof listMutations>,
    execute: {
      handle: ({ params }, ctx) => execution.execute(ctx, ctx.caller, params.mutationId),
    } satisfies RouteHandlers<typeof executeMutation>,
    confirmCanary: {
      handle: ({ params, body }, ctx) => execution.confirmCanary(ctx, params.mutationId, body.seen),
    } satisfies RouteHandlers<typeof confirmCanary>,
    receipt: {
      handle: ({ params }, ctx) => receipts.get(ctx, params.receiptId),
    } satisfies RouteHandlers<typeof getReceipt>,
    commits: {
      handle: async ({ params, query }, ctx) => ({ commits: await receipts.commits(ctx, params.objectId, query.limit) }),
    } satisfies RouteHandlers<typeof listObjectCommits>,
    proposeCron: {
      handle: ({ body }, ctx) => cronMutations.propose(ctx, body),
    } satisfies RouteHandlers<typeof proposeCronMutation>,
    createSubscription: {
      handle: ({ body }, ctx) => subscriptions.create(ctx, body),
      resultRef: (out) => out.subscription.id,
      // The secret was shown once: a repeat returns the subscription without it.
      async replay(ref, ctx) {
        const row = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => actionEventSubscriptionRepo.findById(db, ref!), { readOnly: true });
        return { subscription: subscriptionViewOf(row!), secret: null };
      },
    } satisfies RouteHandlers<typeof createActionEventSubscription>,
    listSubscriptions: {
      handle: async ({ query }, ctx) => ({ subscriptions: await subscriptions.list(ctx, query.limit) }),
    } satisfies RouteHandlers<typeof listActionEventSubscriptions>,
    setSubscriptionStatus: {
      handle: ({ params, body }, ctx) => subscriptions.setStatus(ctx, params.subscriptionId, body),
    } satisfies RouteHandlers<typeof setActionEventSubscriptionStatus>,
    getSettings: {
      handle: (_input, ctx) => settings.get(ctx),
    } satisfies RouteHandlers<typeof getActionSettings>,
    setCanarySample: {
      handle: ({ body }, ctx) => settings.setCanarySample(ctx, body.sampleRows),
    } satisfies RouteHandlers<typeof setCanarySample>,
    setGenericEdit: {
      handle: ({ body }, ctx) => settings.setGenericEdit(ctx, body.enabled),
    } satisfies RouteHandlers<typeof setGenericEdit>,
    setPhysicalDryRun: {
      handle: ({ body }, ctx) => settings.setPhysicalDryRun(ctx, body.required),
    } satisfies RouteHandlers<typeof setPhysicalDryRun>,
  };
}
