// The credential service's connection endpoints: wire to the mediator and back.

import type {
  revokeConnectionCredentials, sealAgentCredentials, sendAuthorisedRequest, sendSftpRequest, storeConnectionCredentials,
} from '../../contracts/credential/connectionCredential.contract.ts';
import type { HandlerContext, RouteHandlers } from '../../infra/http.infra.ts';
import type { Caller, ConnectionCredentials } from '../../services/credential/connectionCredential.service.ts';
import type { SftpMediator } from '../../services/credential/sftp.service.ts';

const callerOf = (ctx: HandlerContext): Caller => ({ request: ctx.request, caller: ctx.caller, correlationId: ctx.correlationId });

export function connectionCredentialController(credentials: ConnectionCredentials) {
  return {
    store: {
      handle: ({ body }, ctx) => credentials.store(callerOf(ctx), body.connectionId, body.values),
    } satisfies RouteHandlers<typeof storeConnectionCredentials>,
    revoke: {
      handle: async ({ body }, ctx) => ({ revoked: await credentials.revoke(callerOf(ctx), body.connectionId) }),
    } satisfies RouteHandlers<typeof revokeConnectionCredentials>,
    send: {
      handle: ({ body }, ctx) => credentials.send(callerOf(ctx), body.connectionId, body.reason, body.request,
        { invalidCredentials: body.invalidCredentials === true }),
    } satisfies RouteHandlers<typeof sendAuthorisedRequest>,
    sealForAgent: {
      handle: ({ body }, ctx) => credentials.sealForAgent(callerOf(ctx), body),
    } satisfies RouteHandlers<typeof sealAgentCredentials>,
  };
}

/** SFTP through the mediator (spec 14.4): the session runs here, beside the login. */
export function sftpController(sftp: SftpMediator) {
  return {
    request: {
      handle: ({ body }, ctx) => sftp.request(callerOf(ctx), body.connectionId, body.reason, body.operation),
    } satisfies RouteHandlers<typeof sendSftpRequest>,
  };
}
