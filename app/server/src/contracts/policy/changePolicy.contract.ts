// When a dedicated, sovereign or on-premises cell may change (spec 11.5): "Sovereign,
// on-premises and dedicated customers set change windows and freezes. During a freeze Fleet
// applies only a security fix the customer's named change authority approves in writing."
//
// - getChangePolicy: any member reads it. applies is false on a shared commercial cell, which
//   takes releases in Silo's waves; the setters refuse there.
// - setChangePolicy (org.change_window.manage): the weekly windows in the organisation's time
//   zone, and the change authority (an active member).
// - setChangeFreeze, endChangeFreeze (org.change_window.manage): a freeze from one moment to
//   another, ended early by hand; each raises change_freeze_set.
// - approveFreezeException: the named change authority alone, for one release in one freeze;
//   the statement is the writing. Fleet applies it only to a security fix.
// - listChangePoliciesForFleet: what the cell's Fleet agent carries to fleet-control
//   (putCellChangePolicy), in its shape, for every organisation of the cell.

import { z } from 'zod';
import { cellChangePolicy } from '../fleet-control/rollout.contract.ts';
import { releaseIdSchema } from '../fleet-control/release.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

const timestamp = z.iso.datetime({ offset: true });
const window = cellChangePolicy.shape.windows.element;

export const changePolicyView = z.object({
  /** A dedicated, sovereign or on-premises cell: its customer decides when it changes. */
  applies: z.boolean(),
  timeZone: z.string(),
  windows: z.array(window),
  changeAuthorityMembershipId: z.uuid().nullable(),
  updatedAt: timestamp.nullable(),
  /** Freezes not yet over. */
  freezes: z.array(z.object({
    id: z.uuid(), startsAt: timestamp, endsAt: timestamp, reason: z.string(), setBy: z.uuid(), setAt: timestamp,
    endedAt: timestamp.nullable(), endedBy: z.uuid().nullable(),
  })),
  /** The change authority's approvals in those freezes. */
  exceptions: z.array(z.object({
    id: z.uuid(), freezeId: z.uuid(), releaseId: z.string(), statement: z.string(), approvedBy: z.uuid(), approvedAt: timestamp,
  })),
});
export type ChangePolicyView = z.infer<typeof changePolicyView>;

export const getChangePolicy = defineContract({
  service: 'policy', name: 'getChangePolicy', method: 'GET', path: '/v1/change-policy', callers: ['gateway', 'admin-portal'],
  context: 'organisation', idempotency: 'none',
  response: changePolicyView,
});

export const setChangePolicy = defineContract({
  service: 'policy', name: 'setChangePolicy', method: 'PUT', path: '/v1/change-policy', callers: ['gateway'],
  // The whole policy each time.
  context: 'organisation', idempotency: 'none',
  body: cellChangePolicy.pick({ timeZone: true, windows: true, changeAuthorityMembershipId: true }),
  response: changePolicyView,
  maxBodyBytes: 16 * 1024,
});

export const setChangeFreeze = defineContract({
  service: 'policy', name: 'setChangeFreeze', method: 'PUT', path: '/v1/change-policy/freezes/:freezeId', callers: ['gateway'],
  // The caller names the freeze: the same freeze again returns it; other content under its id is a conflict.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ freezeId: z.uuid() }),
  body: z.strictObject({ startsAt: timestamp, endsAt: timestamp, reason: z.string().trim().min(1).max(500) })
    .refine((b) => Date.parse(b.startsAt) < Date.parse(b.endsAt), 'a freeze ends after it starts'),
  response: changePolicyView,
  maxBodyBytes: 2048,
});

export const endChangeFreeze = defineContract({
  service: 'policy', name: 'endChangeFreeze', method: 'POST', path: '/v1/change-policy/freezes/:freezeId/end', callers: ['gateway'],
  // Ending an ended freeze changes nothing.
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ freezeId: z.uuid() }),
  response: changePolicyView,
  maxBodyBytes: 256,
});

export const approveFreezeException = defineContract({
  service: 'policy', name: 'approveFreezeException', method: 'POST', path: '/v1/change-policy/exceptions', callers: ['gateway'],
  // One approval per release and freeze: the same again returns it.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ freezeId: z.uuid(), releaseId: releaseIdSchema, statement: z.string().trim().min(1).max(4000) }),
  response: changePolicyView,
  status: 201,
  maxBodyBytes: 8192,
});

export const listChangePoliciesForFleet = defineContract({
  service: 'policy', name: 'listChangePoliciesForFleet', method: 'GET', path: '/v1/change-policies/fleet', callers: ['fleet-control'],
  context: 'none', idempotency: 'none',
  response: z.object({ policies: z.array(cellChangePolicy) }),
});
