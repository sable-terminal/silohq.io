// actions' grants for conformance's write class and for webhook deliveries through the agent (contracts/actions/grant.contract.ts).

import type { signSandboxWriteGrant, signWebhookGrant } from '../../contracts/actions/grant.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { WriteBackDeps } from '../../services/actions/deps.service.ts';
import { signSandboxGrant, signWebhookGrant as signWebhookGrantFor } from '../../services/actions/grants.service.ts';

export function grantController(deps: WriteBackDeps): RouteHandlers<typeof signSandboxWriteGrant> {
  return { handle: ({ body }, ctx) => signSandboxGrant(deps, ctx, body) };
}

export function webhookGrantController(deps: WriteBackDeps): RouteHandlers<typeof signWebhookGrant> {
  return { handle: ({ params, body }, ctx) => signWebhookGrantFor(deps, ctx, params.deliveryId, body.payloadSha256) };
}
