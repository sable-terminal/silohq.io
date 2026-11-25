// Write-back in the product (spec 42 to 46): Action types, mutations and their previews,
// approvals and policies, receipts and the object log, reverts, and earning writes.
//
// Each route's permission is the one the forwarded service starts from; the service then
// applies its finer rules: action.define at the type's owning scope, mutation.approve at each
// connection's owning scope with the slot's qualification, mutation.revert per connection,
// who may read a mutation's values (its proposer, or those who may approve it). The write
// class's rule is "the connection's owner, or connector.verify"; until the gateway can ask an
// owner-aware decision it asks connector.verify, and the service applies the rest.

import { getReceiptPurge as receiptPurge, requestReceiptPurge as purgeReceipts } from '../actions/receiptPurge.contract.ts';
import { listWebhookDeliveries as deliveries } from '../actions/webhookDelivery.contract.ts';
import { getActionType as type, listActionTypes as types, proposeActionType as proposeType, publishActionTypeVersion as publish, rejectActionType as rejectType, retireActionType as retire } from '../actions/actionType.contract.ts';
import {
  confirmCanary as canary, executeMutation as execute, getMutation as mutation, getReceipt as receipt, listMutations as mutations, listObjectCommits as commits, proposeMutation as propose,
} from '../actions/mutation.contract.ts';
import {
  createApprovalPolicy as createPolicy, decideApproval as decide, getChain as chain, listApprovalInbox as inbox, listApprovalPolicies as policies,
  setPolicyFloor as floor, supersedeApprovalPolicy as supersede,
} from '../approvals/approval.contract.ts';
import {
  createActionEventSubscription as subscribe, listActionEventSubscriptions as subscriptions, setActionEventSubscriptionStatus as subscriptionStatus,
} from '../actions/actionEvent.contract.ts';
import { getWriteClassStatus as writeClassStatus, runWriteClass as writeClass, setConnectionWrites as writes } from '../conformance/writeClass.contract.ts';
import { decideRevertConflicts as decideConflicts, getRevert as revert, requestRevert as requestRevertInternal } from '../revert/revert.contract.ts';
import {
  getActionSettings as settings, setCanarySample as canarySample, setGenericEdit as genericEditSetting, setPhysicalDryRun as physicalDryRunSetting,
} from '../actions/settings.contract.ts';
import {
  decideAllowlistRequest as decideAllowlist, listAllowlist as allowlist, removeAllowlistEntry as removeAllowlist, requestAllowlistEntry as requestAllowlist,
} from '../actions/allowlist.contract.ts';
import { definePublicRoute, type PublicRoute } from './publicRoute.contract.ts';

const forward = <T>(input: T) => input;

// ----------------------------------------------------------------------------- Action types

export const listActionTypes = definePublicRoute({
  name: 'listActionTypes', method: 'GET', path: '/actions/types', session: 'complete', permission: { permission: 'ontology.view' },
  query: types.query, response: types.response, forwards: types, call: (input) => ({ query: input.query }), reply: forward,
});

export const getActionType = definePublicRoute({
  name: 'getActionType', method: 'GET', path: '/actions/types/:actionTypeId', session: 'complete', permission: { permission: 'ontology.view' },
  params: type.params, response: type.response, forwards: type, call: (input) => ({ params: input.params }), reply: forward,
});

export const proposeActionType = definePublicRoute({
  name: 'proposeActionType', method: 'POST', path: '/actions/types', session: 'complete',
  permission: { permission: 'action.define', scopeId: (input) => input.body.owningScopeId },
  body: proposeType.body, response: proposeType.response, status: 201, forwards: proposeType, call: (input) => ({ body: input.body }), reply: forward,
});

export const publishActionTypeVersion = definePublicRoute({
  name: 'publishActionTypeVersion', method: 'POST', path: '/actions/types/:actionTypeId/versions', session: 'complete', permission: { permission: 'action.define' },
  params: publish.params, body: publish.body, response: publish.response, status: 201, forwards: publish,
  call: (input) => ({ params: input.params, body: input.body }), reply: forward,
});

export const retireActionType = definePublicRoute({
  name: 'retireActionType', method: 'POST', path: '/actions/types/:actionTypeId/retire', session: 'complete', permission: { permission: 'action.define' },
  params: retire.params, body: retire.body, response: retire.response, forwards: retire, call: (input) => ({ params: input.params, body: input.body }), reply: forward,
});

export const rejectActionType = definePublicRoute({
  name: 'rejectActionType', method: 'POST', path: '/actions/types/:actionTypeId/rejection', session: 'complete', permission: { permission: 'action.define' },
  params: rejectType.params, body: rejectType.body, response: rejectType.response, forwards: rejectType,
  call: (input) => ({ params: input.params, body: input.body }), reply: forward,
});

// ----------------------------------------------------------------------------- mutations

export const proposeMutation = definePublicRoute({
  name: 'proposeMutation', method: 'POST', path: '/actions/mutations', session: 'complete', permission: { permission: 'mutation.propose' },
  body: propose.body, response: propose.response, status: 201, forwards: propose, call: (input) => ({ body: input.body }), reply: forward,
});

export const listMutations = definePublicRoute({
  name: 'listMutations', method: 'GET', path: '/actions/mutations', session: 'complete', permission: { permission: 'mutation.propose' },
  query: mutations.query, response: mutations.response, forwards: mutations, call: (input) => ({ query: input.query }), reply: forward,
});

export const getMutation = definePublicRoute({
  name: 'getMutation', method: 'GET', path: '/actions/mutations/:mutationId', session: 'complete', permission: { permission: 'mutation.propose' },
  params: mutation.params, response: mutation.response, forwards: mutation, call: (input) => ({ params: input.params }), reply: forward,
});

/** Separated execution only (45.1); where not separated, the final approval executes. */
export const executeMutation = definePublicRoute({
  name: 'executeMutation', method: 'POST', path: '/actions/mutations/:mutationId/execute', session: 'complete', permission: { permission: 'mutation.execute' },
  params: execute.params, response: execute.response, status: 202, forwards: execute, call: (input) => ({ params: input.params }), reply: forward,
});

/** The remainder of a canaried mutation (45.4): actions checks it is the executor or, where not separated, the final approver. */
export const confirmMutationCanary = definePublicRoute({
  name: 'confirmMutationCanary', method: 'POST', path: '/actions/mutations/:mutationId/canary-confirmation', session: 'complete',
  decidedByService: 'actions allows the executor (mutation.execute, not the proposer) or, where execution is not separated, the final approver',
  params: canary.params, body: canary.body, response: canary.response, status: 202, forwards: canary,
  call: (input) => ({ params: input.params, body: input.body }), reply: forward,
});

export const getReceipt = definePublicRoute({
  name: 'getReceipt', method: 'GET', path: '/actions/receipts/:receiptId', session: 'complete', permission: { permission: 'mutation.propose' },
  params: receipt.params, response: receipt.response, forwards: receipt, call: (input) => ({ params: input.params }), reply: forward,
});

export const listObjectCommits = definePublicRoute({
  name: 'listObjectCommits', method: 'GET', path: '/actions/objects/:objectId/commits', session: 'complete', permission: { permission: 'ontology.view' },
  params: commits.params, query: commits.query, response: commits.response, forwards: commits,
  call: (input) => ({ params: input.params, query: input.query }), reply: forward,
});

// ----------------------------------------------------------------------------- approvals

export const listApprovalInbox = definePublicRoute({
  name: 'listApprovalInbox', method: 'GET', path: '/actions/approvals', session: 'complete', permission: { permission: 'mutation.approve' },
  query: inbox.query, response: inbox.response, forwards: inbox, call: (input) => ({ query: input.query }), reply: forward,
});

export const getApprovalChain = definePublicRoute({
  name: 'getApprovalChain', method: 'GET', path: '/actions/approvals/:chainId', session: 'complete', permission: { permission: 'mutation.approve' },
  params: chain.params, response: chain.response, forwards: chain, call: (input) => ({ params: input.params }), reply: forward,
});

export const decideApproval = definePublicRoute({
  name: 'decideApproval', method: 'POST', path: '/actions/approvals/:chainId/decisions', session: 'complete', permission: { permission: 'mutation.approve' },
  params: decide.params, body: decide.body, response: decide.response, forwards: decide, call: (input) => ({ params: input.params, body: input.body }), reply: forward,
});

export const createApprovalPolicy = definePublicRoute({
  name: 'createApprovalPolicy', method: 'POST', path: '/actions/approval-policies', session: 'complete', permission: { permission: 'mutation.policy' },
  body: createPolicy.body, response: createPolicy.response, status: 201, forwards: createPolicy, call: (input) => ({ body: input.body }), reply: forward,
});

export const supersedeApprovalPolicy = definePublicRoute({
  name: 'supersedeApprovalPolicy', method: 'POST', path: '/actions/approval-policies/:policyId/supersede', session: 'complete', permission: { permission: 'mutation.policy' },
  params: supersede.params, body: supersede.body, response: supersede.response, status: 201, forwards: supersede,
  call: (input) => ({ params: input.params, body: input.body }), reply: forward,
});

export const listApprovalPolicies = definePublicRoute({
  name: 'listApprovalPolicies', method: 'GET', path: '/actions/approval-policies', session: 'complete', permission: { permission: 'mutation.policy' },
  query: policies.query, response: policies.response, forwards: policies, call: (input) => ({ query: input.query }), reply: forward,
});

export const setPolicyFloor = definePublicRoute({
  name: 'setPolicyFloor', method: 'POST', path: '/actions/policy-floors', session: 'complete', permission: { permission: 'mutation.policy' },
  body: floor.body, response: floor.response, status: 201, forwards: floor, call: (input) => ({ body: input.body }), reply: forward,
});

// ----------------------------------------------------------------------------- reverts

export const requestRevert = definePublicRoute({
  name: 'requestRevert', method: 'POST', path: '/actions/reverts', session: 'complete', permission: { permission: 'mutation.revert' },
  body: requestRevertInternal.body, response: requestRevertInternal.response, status: 201, forwards: requestRevertInternal, call: (input) => ({ body: input.body }), reply: forward,
});

export const getRevert = definePublicRoute({
  name: 'getRevert', method: 'GET', path: '/actions/reverts/:revertId', session: 'complete', permission: { permission: 'mutation.revert' },
  params: revert.params, response: revert.response, forwards: revert, call: (input) => ({ params: input.params }), reply: forward,
});

export const decideRevertConflicts = definePublicRoute({
  name: 'decideRevertConflicts', method: 'POST', path: '/actions/reverts/:revertId/decisions', session: 'complete', permission: { permission: 'mutation.revert' },
  params: decideConflicts.params, body: decideConflicts.body, response: decideConflicts.response, forwards: decideConflicts,
  call: (input) => ({ params: input.params, body: input.body }), reply: forward,
});

// ----------------------------------------------------------------------------- earning writes

export const runWriteClass = definePublicRoute({
  name: 'runWriteClass', method: 'POST', path: '/connect/connections/:connectionId/write-class', session: 'complete',
  permission: { permission: 'connector.verify', resource: (input) => ({ type: 'connection', id: input.params.connectionId }) },
  params: writeClass.params, body: writeClass.body, response: writeClass.response, forwards: writeClass,
  call: (input) => ({ params: input.params, body: input.body }), reply: forward,
});

export const getWriteClassStatus = definePublicRoute({
  name: 'getWriteClassStatus', method: 'GET', path: '/connect/connections/:connectionId/write-class', session: 'complete',
  permission: { permission: 'connector.verify', resource: (input) => ({ type: 'connection', id: input.params.connectionId }) },
  params: writeClassStatus.params, response: writeClassStatus.response, forwards: writeClassStatus,
  call: (input) => ({ params: input.params }), reply: forward,
});

export const setConnectionWrites = definePublicRoute({
  name: 'setConnectionWrites', method: 'PUT', path: '/connect/connections/:connectionId/writes', session: 'complete',
  permission: { permission: 'connector.enable_writes', resource: (input) => ({ type: 'connection', id: input.params.connectionId }) },
  params: writes.params, body: writes.body, response: writes.response, forwards: writes,
  call: (input) => ({ params: input.params, body: input.body }), reply: forward,
});

// ----------------------------------------------------------------------------- outbound Action events (48.3)

export const createActionEventSubscription = definePublicRoute({
  name: 'createActionEventSubscription', method: 'POST', path: '/actions/event-subscriptions', session: 'complete',
  permission: { permission: 'action.define' },
  body: subscribe.body, response: subscribe.response, status: 201, forwards: subscribe, call: (input) => ({ body: input.body }), reply: forward,
});

export const listActionEventSubscriptions = definePublicRoute({
  name: 'listActionEventSubscriptions', method: 'GET', path: '/actions/event-subscriptions', session: 'complete',
  permission: { permission: 'action.define' },
  query: subscriptions.query, response: subscriptions.response, forwards: subscriptions, call: (input) => ({ query: input.query }), reply: forward,
});

export const setActionEventSubscriptionStatus = definePublicRoute({
  name: 'setActionEventSubscriptionStatus', method: 'POST', path: '/actions/event-subscriptions/:subscriptionId/status', session: 'complete',
  permission: { permission: 'action.define' },
  params: subscriptionStatus.params, body: subscriptionStatus.body, response: subscriptionStatus.response, forwards: subscriptionStatus,
  call: (input) => ({ params: input.params, body: input.body }), reply: forward,
});

// ----------------------------------------------------------------------------- Settings (45.4)

export const getActionSettings = definePublicRoute({
  name: 'getActionSettings', method: 'GET', path: '/actions/settings', session: 'complete', permission: { permission: 'mutation.propose' },
  response: settings.response, forwards: settings, call: () => ({}), reply: forward,
});

export const setCanarySample = definePublicRoute({
  name: 'setCanarySample', method: 'PUT', path: '/actions/settings/canary', session: 'complete', permission: { permission: 'mutation.policy' },
  body: canarySample.body, response: canarySample.response, forwards: canarySample, call: (input) => ({ body: input.body }), reply: forward,
});

/** Allow or disable the generic governed edit (42.9). */
export const setGenericEdit = definePublicRoute({
  name: 'setGenericEdit', method: 'PUT', path: '/actions/settings/generic-edit', session: 'complete', permission: { permission: 'mutation.policy' },
  body: genericEditSetting.body, response: genericEditSetting.response, forwards: genericEditSetting, call: (input) => ({ body: input.body }), reply: forward,
});

export const listWebhookDeliveries = definePublicRoute({
  name: 'listWebhookDeliveries', method: 'GET', path: '/actions/mutations/:mutationId/webhook-deliveries', session: 'complete',
  permission: { permission: 'mutation.propose' }, params: deliveries.params, response: deliveries.response, forwards: deliveries,
  call: (input) => ({ params: input.params }), reply: forward,
});

// ----------------------------------------------------------------------------- receipt purge (46.1, 70)

export const requestReceiptPurge = definePublicRoute({
  name: 'requestReceiptPurge', method: 'POST', path: '/actions/receipt-purges', session: 'complete', permission: { permission: 'silo.purge' },
  body: purgeReceipts.body, response: purgeReceipts.response, status: 201, forwards: purgeReceipts, call: (input) => ({ body: input.body }), reply: forward,
});

export const getReceiptPurge = definePublicRoute({
  name: 'getReceiptPurge', method: 'GET', path: '/actions/receipt-purges/:purgeId', session: 'complete', permission: { permission: 'silo.purge' },
  params: receiptPurge.params, response: receiptPurge.response, forwards: receiptPurge, call: (input) => ({ params: input.params }), reply: forward,
});

// ----------------------------------------------------------------------------- the actuation allow-list (47.4)

const ALLOWLIST = 'actions checks industrial.declare_writable at the connection\'s owning scope, or actuation.approve, and the two-person rule (spec 47.4)';

export const requestAllowlistEntry = definePublicRoute({
  name: 'requestAllowlistEntry', method: 'POST', path: '/actions/connections/:connectionId/actuation-allowlist/requests', session: 'complete',
  decidedByService: ALLOWLIST, params: requestAllowlist.params, body: requestAllowlist.body, response: requestAllowlist.response, status: 201,
  forwards: requestAllowlist, call: (input) => ({ params: input.params, body: input.body }), reply: forward,
});

export const decideAllowlistRequest = definePublicRoute({
  name: 'decideAllowlistRequest', method: 'POST', path: '/actions/actuation-allowlist/requests/:requestId/decision', session: 'complete',
  decidedByService: ALLOWLIST, params: decideAllowlist.params, body: decideAllowlist.body, response: decideAllowlist.response,
  forwards: decideAllowlist, call: (input) => ({ params: input.params, body: input.body }), reply: forward,
});

export const listAllowlist = definePublicRoute({
  name: 'listAllowlist', method: 'GET', path: '/actions/connections/:connectionId/actuation-allowlist', session: 'complete',
  decidedByService: ALLOWLIST, params: allowlist.params, response: allowlist.response, forwards: allowlist, call: (input) => ({ params: input.params }), reply: forward,
});

export const removeAllowlistEntry = definePublicRoute({
  name: 'removeAllowlistEntry', method: 'POST', path: '/actions/actuation-allowlist/:entryId/removal', session: 'complete',
  decidedByService: ALLOWLIST, params: removeAllowlist.params, response: removeAllowlist.response, forwards: removeAllowlist,
  call: (input) => ({ params: input.params }), reply: forward,
});

export const setPhysicalDryRun = definePublicRoute({
  name: 'setPhysicalDryRun', method: 'PUT', path: '/actions/settings/physical-dry-run', session: 'complete', permission: { permission: 'mutation.policy' },
  body: physicalDryRunSetting.body, response: physicalDryRunSetting.response, forwards: physicalDryRunSetting, call: (input) => ({ body: input.body }), reply: forward,
});

export const ACTION_ROUTES: readonly PublicRoute[] = [
  rejectActionType,
  listActionTypes, getActionType, proposeActionType, publishActionTypeVersion, retireActionType,
  proposeMutation, listMutations, getMutation, executeMutation, confirmMutationCanary, getReceipt, listObjectCommits,
  listApprovalInbox, getApprovalChain, decideApproval, createApprovalPolicy, supersedeApprovalPolicy, listApprovalPolicies, setPolicyFloor,
  requestRevert, getRevert, decideRevertConflicts,
  getWriteClassStatus, runWriteClass, setConnectionWrites,
  createActionEventSubscription, listActionEventSubscriptions, setActionEventSubscriptionStatus,
  getActionSettings, setCanarySample, setGenericEdit, requestReceiptPurge, getReceiptPurge, listWebhookDeliveries,
  requestAllowlistEntry, decideAllowlistRequest, listAllowlist, removeAllowlistEntry, setPhysicalDryRun,
];
