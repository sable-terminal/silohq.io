// actions (catalogue): Action types and the mutation path (spec 42, 43, 45, 46.1, 46.2).
// Approval is the approvals service's; revert is the revert service's. Every source call goes
// through connect-runtime; record values at rest are sealed through the credential service.

import { signSandboxWriteGrant, signWebhookGrant } from '../../contracts/actions/grant.contract.ts';
import { grantController, webhookGrantController } from '../../controllers/actions/grant.controller.ts';
import { listWebhookDeliveries } from '../../contracts/actions/webhookDelivery.contract.ts';
import { listDeliveries } from '../../services/actions/webhookDeliveries.service.ts';
import { createGrantSigner } from '../../services/actions/grants.service.ts';
import { getActionSettings, setCanarySample, setGenericEdit, setPhysicalDryRun } from '../../contracts/actions/settings.contract.ts';
import { createActionSettings } from '../../services/actions/settings.service.ts';
import {
  getActionType, listActionTypes, proposeActionType, publishActionTypeVersion, rejectActionType, retireActionType,
} from '../../contracts/actions/actionType.contract.ts';
import {
  checkMutation, confirmCanary, executeMutation, getMutation, getReceipt, listMutations, listObjectCommits, listRecentWrites, proposeCronMutation, proposeMutation,
} from '../../contracts/actions/mutation.contract.ts';
import { createCronMutations } from '../../services/actions/cronMutations.service.ts';
import {
  createActionEventSubscription, listActionEventSubscriptions, setActionEventSubscriptionStatus,
} from '../../contracts/actions/actionEvent.contract.ts';
import { actionsController } from '../../controllers/actions/actions.controller.ts';
import { createEventSubscriptions } from '../../services/actions/eventSubscriptions.service.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { createActionTypes } from '../../services/actions/actionTypes.service.ts';
import { createExecution, type Execution } from '../../services/actions/execute.service.ts';
import { createProposals } from '../../services/actions/propose.service.ts';
import { createReceipts } from '../../services/actions/receipts.service.ts';
import { ledgerCopiesWorker } from '../../workers/actions/ledgerCopies.worker.ts';
import { executionSweepsWorker } from '../../workers/actions/sweeps.worker.ts';
import { getReceiptPurge, requestReceiptPurge, runReceiptRetentionSweep } from '../../contracts/actions/receiptPurge.contract.ts';
import { receiptPurgeController } from '../../controllers/actions/receiptPurge.controller.ts';
import { createReceiptPurges, replayReceiptValues } from '../../services/actions/receiptPurges.service.ts';
import { replayReceiptPurges } from '../../contracts/platform/purgeLedger.contract.ts';
import { receiptPurgesWorker } from '../../workers/actions/receiptPurges.worker.ts';
import { decideAllowlistRequest, listAllowlist, removeAllowlistEntry, requestAllowlistEntry } from '../../contracts/actions/allowlist.contract.ts';
import { allowlistController } from '../../controllers/actions/allowlist.controller.ts';
import { createAllowlist } from '../../services/actions/allowlist.service.ts';

export interface ActionsOptions {
  /**
   * Whether a different person must run an approved change (spec 45.1). The organisation
   * setting has no column yet; this deployment setting stands for every organisation.
   */
  executionSeparated?: boolean;
  /** The canary's threshold and sample (45.4); tests lower them. Default 10,000 rows and 100. */
  canary?: { rows: number; sample: number };
  /** Run the execution sweeps (recovery, canary expiry) on their timer (default true); tests call them. */
  sweep?: boolean;
  onExecution?: (execution: Execution) => void;
  /** The clock receipt retention is judged by (tests move it ahead). */
  now?: () => number;
}

/** How often interrupted executions are recovered and expired canaries finished. */
const SWEEP_MS = 60_000;
/** With the sweeps off (tests), an approved receipt purge still runs: its watcher looks this often. */
const PURGE_WATCH_MS_TESTS = 1_000;

const receiptPurgeRoutes = (c: ReturnType<typeof receiptPurgeController>) => [
  route(requestReceiptPurge, c.requestReceiptPurge), route(getReceiptPurge, c.getReceiptPurge), route(runReceiptRetentionSweep, c.runReceiptRetentionSweep),
];

export function createActionsService(options: ActionsOptions = {}): ServiceDefinition {
  return defineService({
    name: 'actions',
    // redis-data holds the keys of keyed proposals.
    needs: { postgres: ['control'], redis: ['data'] },
    create(deps) {
      // The execution grants writes through the Silo Agent run on (spec 10.4).
      const base = {
        databases: deps.databases, services: deps.services, logger: deps.logger, canary: options.canary,
        grants: createGrantSigner(deps.config.connect.executionGrantKey),
      };
      const actionTypes = createActionTypes(base);
      const proposals = createProposals({ ...base, actionTypes, executionSeparated: options.executionSeparated ?? false });
      const execution = createExecution(base);
      options.onExecution?.(execution);
      const receipts = createReceipts(base);
      const subscriptions = createEventSubscriptions(base);
      const receiptPurges = createReceiptPurges(base, options.now);
      const c = actionsController(base, {
        actionTypes, proposals, execution, receipts, subscriptions, cronMutations: createCronMutations(base, proposals), settings: createActionSettings(base),
      });
      return {
        routes: [
          route(proposeActionType, c.proposeType), route(publishActionTypeVersion, c.publishVersion), route(getActionType, c.getType),
          route(listActionTypes, c.listTypes), route(retireActionType, c.retireType), route(rejectActionType, c.rejectType),
          route(proposeMutation, c.propose), route(getMutation, c.get), route(listMutations, c.list), route(executeMutation, c.execute),
          route(confirmCanary, c.confirmCanary), route(proposeCronMutation, c.proposeCron), route(checkMutation, c.check), route(listRecentWrites, c.recentWrites),
          route(getReceipt, c.receipt), route(listObjectCommits, c.commits),
          route(createActionEventSubscription, c.createSubscription), route(listActionEventSubscriptions, c.listSubscriptions),
          route(setActionEventSubscriptionStatus, c.setSubscriptionStatus),
          route(getActionSettings, c.getSettings), route(setCanarySample, c.setCanarySample), route(setGenericEdit, c.setGenericEdit), route(setPhysicalDryRun, c.setPhysicalDryRun),
          route(signSandboxWriteGrant, grantController(base)), route(signWebhookGrant, webhookGrantController(base)),
          route(listWebhookDeliveries, { handle: (input, ctx) => listDeliveries(base, ctx, input.params.mutationId) }),
          ...receiptPurgeRoutes(receiptPurgeController(receiptPurges)),
          // After a restore, before traffic (8.2, 12.5; D251).
          route(replayReceiptPurges, { handle: (input) => replayReceiptValues(base, input.body.entries) }),
          // The actuation allow-list (47.4), signed with the control plane's key, the one grants are.
          ...((a) => [route(requestAllowlistEntry, a.request), route(decideAllowlistRequest, a.decide), route(listAllowlist, a.list), route(removeAllowlistEntry, a.remove)])(
            allowlistController(createAllowlist({ ...base, signingKey: deps.config.connect.executionGrantKey })),
          ),
        ],
        // Receipt purges always advance: an approved purge must run (70.3); the retention sweep with them.
        workers: [
          ...(options.sweep === false ? [] : [executionSweepsWorker(execution, SWEEP_MS, deps.logger)]),
          receiptPurgesWorker(receiptPurges, options.sweep === false ? PURGE_WATCH_MS_TESTS : SWEEP_MS, options.sweep !== false, deps.logger),
          // Ledger copies owed (48.2) always advance, as purges do.
          ledgerCopiesWorker(execution, options.sweep === false ? PURGE_WATCH_MS_TESTS : SWEEP_MS, deps.logger),
        ],
        close: () => execution.close(),
      };
    },
  });
}

export const service = createActionsService();
