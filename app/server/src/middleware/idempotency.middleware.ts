// Idempotency for a keyed operation on the service listener (spec 7.1). The caller sends
// an Idempotency-Key, claimed in redis-data under the organisation and the route: a retry
// of a finished request replays its result by reference (no value is kept in Redis), a
// retry of a running one is told to wait, and a key reused for a different request is
// refused. A request that fails releases its key, so it can be retried.

import type { RequestHandler } from 'express';
import { IDEMPOTENCY_HEADER, type AnyContract, type ParsedInput } from '../contracts/endpoint.contract.ts';
import type { HandlerContext, RouteBinding } from '../infra/http.infra.ts';
import { claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '../infra/keyspaces.infra.ts';
import type { RedisStore } from '../infra/redis.infra.ts';
import { canonicalJson } from '../utils/canonicalJson.util.ts';
import { sha256 } from '../utils/crypto.util.ts';
import { AppError } from '../utils/errors.util.ts';
import { localsOf } from './request.middleware.ts';

/** The caller's key, which a keyed operation requires. */
export function idempotencyKey(contract: AnyContract): RequestHandler {
  return (req, res, next) => {
    const header = req.headers[IDEMPOTENCY_HEADER];
    if (typeof header === 'string') localsOf(res).idempotencyKey = header;
    else if (contract.idempotency === 'keyed') {
      throw new AppError('validation', `${contract.id} is keyed: send an ${IDEMPOTENCY_HEADER} header (spec 7.1)`, {
        code: 'idempotency.key_missing',
      });
    }
    next();
  };
}

/** Claims the key, runs the handler once, and replays the first result for a retry. */
export async function runKeyed(binding: RouteBinding, input: ParsedInput<AnyContract>, ctx: HandlerContext, store: RedisStore): Promise<unknown> {
  const organisationId = ctx.request.organisationId!;
  const scope = ctx.contract.id;
  const key = ctx.idempotencyKey!;
  const requestHash = sha256(canonicalJson({ params: input.params, query: input.query, body: input.body ?? null })).toString('hex');
  const claim = await claimIdempotencyKey(store, organisationId, scope, key, requestHash);
  if (claim.state === 'mismatch') {
    throw new AppError('validation', 'this idempotency key was used for a different request', { code: 'idempotency.key_reused' });
  }
  if (claim.state === 'in_progress') {
    throw new AppError('conflict', 'the first request with this idempotency key is still running', {
      code: 'idempotency.in_progress', retryable: true, retryAfterSeconds: 1,
    });
  }
  if (claim.state === 'done') {
    ctx.logger.info('replayed a finished request', { event: 'idempotency.replayed' });
    return binding.replay ? binding.replay(claim.resultRef, ctx) : undefined;
  }
  let output: unknown;
  try {
    output = await binding.handle(input, ctx);
  } catch (error) {
    await releaseIdempotencyKey(store, organisationId, scope, key).catch(() => undefined);
    throw error;
  }
  // An empty reference (a refusal, which made nothing) is kept as none: the retry is answered by replay.
  const ref = binding.resultRef?.(output);
  await completeIdempotencyKey(store, organisationId, scope, key, ref === '' ? undefined : ref);
  return output;
}
