// connect-runtime's field profile endpoint (spec 22.3): counts only leave.

import type { profileObject } from '../../contracts/connect-runtime/profile.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { profileObject as profile } from '../../services/connect-runtime/profile.service.ts';
import type { RuntimeDeps } from '../../services/connect-runtime/read.service.ts';

export function profileController(deps: RuntimeDeps): RouteHandlers<typeof profileObject> {
  return {
    handle: ({ body }, ctx) => profile(deps, { request: ctx.request, correlationId: ctx.correlationId, signal: ctx.signal }, body),
  };
}
