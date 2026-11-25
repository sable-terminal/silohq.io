// Binding a contract to its handler (spec 7.1): what a controller gives the service
// listener for each endpoint (contracts/endpoint.contract.ts), and what the handler is
// told about the request. The listener itself, and the steps every request passes before
// the handler runs, are src/process.ts and src/middleware.

import type { ServiceName } from '../config/service.config.ts';
import type { AnyContract, HandlerOutput, ParsedInput } from '../contracts/endpoint.contract.ts';
import type { Logger } from './logger.infra.ts';
import type { RequestContext } from './postgres.infra.ts';

export interface HandlerContext {
  readonly contract: AnyContract;
  readonly caller: ServiceName;
  /**
   * The caller's cell, from its certificate. Always this cell, except on a global-tier
   * route, which every registered cell calls: there the handler decides what that cell may
   * touch.
   */
  readonly callerCell: string;
  /** For inTransaction: the organisation, user and actor the caller sent. */
  readonly request: RequestContext;
  readonly correlationId: string;
  readonly idempotencyKey: string | undefined;
  /** Aborts when the caller goes away or the request times out. */
  readonly signal: AbortSignal;
  /** Bound with the correlation id, organisation and route. */
  readonly logger: Logger;
}

export interface RouteHandlers<C extends AnyContract> {
  handle(input: ParsedInput<C>, ctx: HandlerContext): Promise<HandlerOutput<C>>;
  /** Keyed operations: the identifier of a result, kept with the idempotency key. */
  resultRef?(output: HandlerOutput<C>): string;
  /** Keyed operations: the same result again, read by its identifier, for a retried request. */
  replay?(resultRef: string | undefined, ctx: HandlerContext): Promise<HandlerOutput<C>>;
}

export interface RouteBinding<C extends AnyContract = AnyContract> extends RouteHandlers<C> {
  readonly contract: C;
}

/** Binds a contract to its handler. A keyed operation must be able to replay its result. */
export function route<C extends AnyContract>(contract: C, handlers: RouteHandlers<C>): RouteBinding<C> {
  if (contract.idempotency === 'keyed' && contract.status !== 204) {
    if (handlers.replay === undefined || handlers.resultRef === undefined) {
      throw new TypeError(`${contract.id}: a keyed operation needs resultRef and replay, so a retry returns the first result`);
    }
  }
  return { contract, ...handlers };
}
