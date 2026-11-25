// Where an Action from the canvas lands (spec 29.6): a selection of objects of one type, and for
// each the record the Action type writes, by the object view's own rule (34.5): the object's
// record in the first system the type may write through. Read now, under the caller's access;
// an object not read, or with no such record, is excluded with why, so the proposal targets
// exactly the visible selection and its preview can name every target.

import { z } from 'zod';
import { defineContract } from '../endpoint.contract.ts';
import { RUN_TIMEOUT_MS } from './result.contract.ts';

export const ACTION_TARGETS_LIMIT = 10_000;

export const resolveActionTargets = defineContract({
  service: 'executor', name: 'resolveActionTargets', method: 'POST', path: '/v1/objects/action-targets', callers: ['gateway'],
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({
    objectTypeId: z.uuid(),
    actionTypeId: z.uuid(),
    objectIds: z.array(z.uuid()).min(1).max(ACTION_TARGETS_LIMIT),
  }),
  response: z.object({
    targets: z.array(z.object({ objectId: z.uuid(), connectionId: z.uuid(), reference: z.string() })),
    excluded: z.array(z.object({ objectId: z.uuid(), reason: z.string() })),
  }),
  timeoutMs: RUN_TIMEOUT_MS,
  maxBodyBytes: 512 * 1024,
});
