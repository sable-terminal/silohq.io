// The customer's side of break-glass (spec 13.3, 13.5, 63.6), through the gateway: every
// session Silo staff asked for on the tenant, the approval or denial, revoking a running
// one, and the policy that every session needs approval first. The gateway decides the
// permission: org.operator_access.view to read, .approve to decide or revoke, .policy for
// the policy. admin-portal owns the rows (spec 7.2) and writes the decision.

import { z } from 'zod';
import { operatorAccessSessionSchema } from '../../schemas/platform/operatorAccessSession.schema.ts';
import { defineContract } from '../endpoint.contract.ts';
import { ACCESS_STATUSES } from './capability.contract.ts';

const CALLERS = ['gateway'] as const;
const cursor = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);

/** What the customer sees of a session: the named person, purpose, level, approvers and what was touched (13.3). */
export const operatorAccessSessionView = operatorAccessSessionSchema.omit({
  organisationId: true, updatedAt: true, version: true,
});
export type OperatorAccessSessionView = z.infer<typeof operatorAccessSessionView>;

export const listOperatorAccessSessions = defineContract({
  service: 'admin-portal', name: 'listOperatorAccessSessions', method: 'GET', path: '/v1/operator-access/sessions', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  query: z.strictObject({
    status: z.enum(ACCESS_STATUSES).optional(),
    cursor: cursor.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: z.object({ sessions: z.array(operatorAccessSessionView), nextCursor: z.string().nullable() }),
});

export const getOperatorAccessSession = defineContract({
  service: 'admin-portal', name: 'getOperatorAccessSession', method: 'GET', path: '/v1/operator-access/sessions/:sessionId', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ sessionId: z.uuid() }),
  response: operatorAccessSessionView,
});

/** The customer's approval or denial of a requested session. Deciding twice is refused. */
export const decideOperatorAccessSession = defineContract({
  service: 'admin-portal', name: 'decideOperatorAccessSession', method: 'POST', path: '/v1/operator-access/sessions/:sessionId/decision',
  callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ sessionId: z.uuid() }),
  body: z.strictObject({
    decision: z.enum(['approve', 'deny']),
    /** Required to deny. */
    reason: z.string().trim().min(3).max(500).optional(),
  }).refine((b) => b.decision === 'approve' || b.reason !== undefined, { path: ['reason'], message: 'a denial gives its reason' }),
  response: operatorAccessSessionView,
  maxBodyBytes: 2048,
});

/** Ends a running session at once, or withdraws an approval before it starts. */
export const revokeOperatorAccessSession = defineContract({
  service: 'admin-portal', name: 'revokeOperatorAccessSession', method: 'POST', path: '/v1/operator-access/sessions/:sessionId/revocation',
  callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  params: z.strictObject({ sessionId: z.uuid() }),
  response: operatorAccessSessionView,
});

const policyView = z.object({
  /** The organisation requires approval of every session (org.operator_access.policy). */
  approvalRequired: z.boolean(),
  /** Whether approval is required here whatever the policy says: the sovereign cell (13.3). */
  requiredByCell: z.boolean(),
});

export const getOperatorAccessPolicy = defineContract({
  service: 'admin-portal', name: 'getOperatorAccessPolicy', method: 'GET', path: '/v1/operator-access/policy', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  response: policyView,
});

export const setOperatorAccessPolicy = defineContract({
  service: 'admin-portal', name: 'setOperatorAccessPolicy', method: 'PUT', path: '/v1/operator-access/policy', callers: CALLERS,
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ approvalRequired: z.boolean() }),
  response: policyView,
  maxBodyBytes: 256,
});
