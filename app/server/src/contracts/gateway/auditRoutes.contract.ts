// The audit log in the product (spec 63.5): events, sign-in events and the daily chain
// heads for audit.read holders, and a verified run of the chain and the partition seals
// for audit.export holders. A reader whose grant sits on a scope names it, and the audit
// service shows only that subtree; the gateway asks the policy service at that scope.

import {
  listAuditEvents as listEvents, listAuthEvents as listSignIns, listChainHeads as listHeads, listCredentialUnwraps as listUnwraps, listPartitionSeals as listSeals,
  readAuditChain as readChain,
} from '../audit/read.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

export const listAuditEvents = definePublicRoute({
  name: 'listAuditEvents', method: 'GET', path: '/audit/events', session: 'complete',
  permission: { permission: 'audit.read', scopeId: (input) => input.query.scopeId },
  query: listEvents.query,
  response: listEvents.response,
  forwards: listEvents,
  call: (input) => ({ query: input.query }),
  reply: (output) => output,
});

export const listAuthEvents = definePublicRoute({
  name: 'listAuthEvents', method: 'GET', path: '/audit/auth-events', session: 'complete',
  permission: { permission: 'audit.read' },
  query: listSignIns.query,
  response: listSignIns.response,
  forwards: listSignIns,
  call: (input) => ({ query: input.query }),
  reply: (output) => output,
});

// credential_unwrapped (spec 61.9): the unwrap trail, beside the audit events the Governance page unions it with.
export const listCredentialUnwraps = definePublicRoute({
  name: 'listCredentialUnwraps', method: 'GET', path: '/audit/credential-unwraps', session: 'complete',
  permission: { permission: 'audit.read' },
  query: listUnwraps.query,
  response: listUnwraps.response,
  forwards: listUnwraps,
  call: (input) => ({ query: input.query }),
  reply: (output) => output,
});

export const listChainHeads = definePublicRoute({
  name: 'listChainHeads', method: 'GET', path: '/audit/chain-heads', session: 'complete',
  permission: { permission: 'audit.read' },
  query: listHeads.query,
  response: listHeads.response,
  forwards: listHeads,
  call: (input) => ({ query: input.query }),
  reply: (output) => output,
});

export const readAuditChain = definePublicRoute({
  name: 'readAuditChain', method: 'GET', path: '/audit/chain', session: 'complete',
  permission: { permission: 'audit.export' },
  query: readChain.query,
  response: readChain.response,
  forwards: readChain,
  call: (input) => ({ query: input.query }),
  reply: (output) => output,
});

export const listPartitionSeals = definePublicRoute({
  name: 'listPartitionSeals', method: 'GET', path: '/audit/seals', session: 'complete',
  permission: { permission: 'audit.export' },
  query: listSeals.query,
  response: listSeals.response,
  forwards: listSeals,
  call: (input) => ({ query: input.query }),
  reply: (output) => output,
});
