// The state plane's subscription endpoints: the holder from the request context the gateway
// set from the resolved session, never from the body.

import type {
  closeLiveSubscription, openLiveSubscription, renewLiveSubscriptions, reportLiveBufferMode,
} from '../../contracts/state-plane/subscription.contract.ts';
import type { HandlerContext, RouteHandlers } from '../../infra/http.infra.ts';
import type { Holder, Subscriptions } from '../../services/state-plane/subscriptions.service.ts';
import { AppError } from '../../utils/errors.util.ts';

function holderOf(ctx: HandlerContext): Holder {
  const { organisationId, membershipId, sessionId, userId } = ctx.request;
  if (organisationId === undefined || membershipId === undefined || sessionId === undefined) {
    throw new AppError('forbidden', 'a live subscription is held by a member\'s session', { code: 'live.session_required' });
  }
  return { organisationId, membershipId, sessionId, userId };
}

export function subscriptionController(subscriptions: Subscriptions) {
  return {
    open: {
      handle: ({ body }, ctx) => subscriptions.open(holderOf(ctx), body, ctx.correlationId),
    } satisfies RouteHandlers<typeof openLiveSubscription>,
    close: {
      handle: async ({ params }, ctx) => ({ closed: await subscriptions.close(holderOf(ctx), params.subscriptionId) }),
    } satisfies RouteHandlers<typeof closeLiveSubscription>,
    renew: {
      handle: ({ body }, ctx) => subscriptions.renew(holderOf(ctx), body.subscriptions),
    } satisfies RouteHandlers<typeof renewLiveSubscriptions>,
    bufferMode: {
      handle: ({ params, body }, ctx) => subscriptions.bufferMode(holderOf(ctx), params.subscriptionId, body.mode),
    } satisfies RouteHandlers<typeof reportLiveBufferMode>,
  };
}
