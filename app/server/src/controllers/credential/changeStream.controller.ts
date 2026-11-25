// The credential service's change-stream endpoints: wire to the mediator and back.

import type { sealWebhookSecret, verifyWebhookDelivery } from '../../contracts/credential/changeStream.contract.ts';
import type { HandlerContext, RouteHandlers } from '../../infra/http.infra.ts';
import type { ChangeStreamCredentials } from '../../services/credential/changeStream.service.ts';
import type { Caller } from '../../services/credential/connectionCredential.service.ts';

const callerOf = (ctx: HandlerContext): Caller => ({ request: ctx.request, caller: ctx.caller, correlationId: ctx.correlationId });

export function changeStreamCredentialController(credentials: ChangeStreamCredentials) {
  return {
    storeSecret: {
      handle: ({ body }, ctx) => credentials.seal(callerOf(ctx), body.connectionId, body.secret),
    } satisfies RouteHandlers<typeof sealWebhookSecret>,
    verify: {
      handle: ({ body }, ctx) => credentials.verify(callerOf(ctx), body),
    } satisfies RouteHandlers<typeof verifyWebhookDelivery>,
  };
}
