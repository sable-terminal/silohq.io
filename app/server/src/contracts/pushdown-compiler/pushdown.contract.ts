// The pushdown compiler (catalogue: pushdown-compiler): which part of a plan step a
// connection's source computes, and in what native form. connect-runtime compiles in
// process; the planner asks here when choosing a plan.

import { z } from 'zod';
import { requestPatch } from '../connect/manifest.contract.ts';
import { planStep, pushdownSplit } from '../connect/step.contract.ts';
import { defineContract } from '../endpoint.contract.ts';

export const explainPushdown = defineContract({
  service: 'pushdown-compiler', name: 'explainPushdown', method: 'POST', path: '/v1/pushdown/explanations',
  callers: ['planner', 'executor', 'compile', 'conformance', 'connector-builder', 'visual-builder', 'search'],
  // Compiles; changes nothing.
  context: 'organisation', idempotency: 'none',
  body: z.strictObject({ connectionId: z.uuid(), step: planStep }),
  response: z.object({
    split: pushdownSplit,
    native: z.discriminatedUnion('protocol', [
      z.object({ protocol: z.literal('rest'), patches: z.array(requestPatch) }),
      /** The generated statement, with its values as placeholders only. */
      z.object({ protocol: z.literal('sql'), dialect: z.string(), statement: z.string(), parameters: z.number().int() }),
      /** The query built from the plan (no values in its text) and the names of the variables the native part sets. */
      z.object({ protocol: z.literal('graphql'), query: z.string(), variables: z.array(z.string()) }),
      /** The operation called and the names of the parameters the native part and the constants set (their values travel as element text). */
      z.object({ protocol: z.literal('soap'), operation: z.string(), parameters: z.array(z.string()) }),
      /** The entity set and the query the engine writes ($filter, $orderby, $top), values as typed OData literals. */
      z.object({ protocol: z.literal('odata'), entitySet: z.string(), query: z.record(z.string(), z.string()) }),
    ]),
  }),
  maxBodyBytes: 64 * 1024,
});
