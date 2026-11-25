// The credential service's outbound Action event secrets: wire to the service and back.

import type { createActionEventSecret, signActionEvent } from '../../contracts/credential/actionEventSecret.contract.ts';
import type { createOutboundWebhookSecret, signOutboundWebhook } from '../../contracts/credential/outboundWebhookSecret.contract.ts';
import type { HandlerContext, RouteHandlers } from '../../infra/http.infra.ts';
import type { ActionEventSecrets } from '../../services/credential/actionEventSecret.service.ts';
import type { Caller } from '../../services/credential/connectionCredential.service.ts';

const callerOf = (ctx: HandlerContext): Caller => ({ request: ctx.request, caller: ctx.caller, correlationId: ctx.correlationId });

export function actionEventSecretController(secrets: ActionEventSecrets) {
  return {
    create: { handle: (_input, ctx) => secrets.create(callerOf(ctx)) } satisfies RouteHandlers<typeof createActionEventSecret>,
    sign: { handle: ({ body }, ctx) => secrets.sign(callerOf(ctx), body) } satisfies RouteHandlers<typeof signActionEvent>,
    createWebhook: {
      handle: ({ body }, ctx) => secrets.create(callerOf(ctx), 'outbound_webhook_secret', body.connectionId),
    } satisfies RouteHandlers<typeof createOutboundWebhookSecret>,
    signWebhook: {
      handle: ({ body }, ctx) => secrets.sign(callerOf(ctx), body, 'outbound_webhook_secret'),
    } satisfies RouteHandlers<typeof signOutboundWebhook>,
  };
}
