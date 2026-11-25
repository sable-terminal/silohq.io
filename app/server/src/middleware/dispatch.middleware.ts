// The last step of a service request: the contract's handler, under the deadline and once
// per idempotency key, with its reply checked against the contract before it is sent.

import type { RequestHandler } from 'express';
import type { AnyContract, ParsedInput } from '../contracts/endpoint.contract.ts';
import type { HandlerContext, RouteBinding } from '../infra/http.infra.ts';
import type { RedisStore } from '../infra/redis.infra.ts';
import { untilAborted } from './deadline.middleware.ts';
import { runKeyed } from './idempotency.middleware.ts';
import { localsOf } from './request.middleware.ts';
import { checkedReply } from './validate.middleware.ts';

export function dispatch(binding: RouteBinding, idempotency: RedisStore | undefined): RequestHandler {
  const { contract } = binding;
  return async (_req, res) => {
    const locals = localsOf(res);
    const ctx: HandlerContext = {
      contract, caller: locals.caller!, callerCell: locals.callerCell!, request: locals.request!, correlationId: locals.correlationId,
      idempotencyKey: locals.idempotencyKey, signal: locals.signal!, logger: locals.log,
    };
    const input = locals.input as ParsedInput<AnyContract>;
    const work = contract.idempotency === 'keyed' ? runKeyed(binding, input, ctx, idempotency!) : binding.handle(input, ctx);
    const output = await untilAborted(work, ctx.signal);
    const data = checkedReply(contract.response, output, locals.log);
    if (contract.status === 204) res.status(204).end();
    else res.status(contract.status).json(data);
  };
}
