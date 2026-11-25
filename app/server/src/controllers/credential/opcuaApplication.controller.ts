// The credential service's OPC UA application certificates and keys: wire to the service and back.

import type { issueOpcUaApplicationCertificate, sealOpcUaApplicationKey } from '../../contracts/credential/opcuaApplication.contract.ts';
import type { HandlerContext, RouteHandlers } from '../../infra/http.infra.ts';
import type { Caller } from '../../services/credential/connectionCredential.service.ts';
import type { OpcUaApplications } from '../../services/credential/opcuaApplication.service.ts';

const callerOf = (ctx: HandlerContext): Caller => ({ request: ctx.request, caller: ctx.caller, correlationId: ctx.correlationId });

export function opcUaApplicationController(applications: OpcUaApplications) {
  return {
    issue: { handle: ({ body }, ctx) => applications.issue(callerOf(ctx), body) } satisfies RouteHandlers<typeof issueOpcUaApplicationCertificate>,
    sealKey: { handle: ({ body }, ctx) => applications.sealForAgent(callerOf(ctx), body) } satisfies RouteHandlers<typeof sealOpcUaApplicationKey>,
  };
}
