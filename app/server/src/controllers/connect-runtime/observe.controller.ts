// connect-runtime's structural observation endpoint.

import type { observeObject } from '../../contracts/connect-runtime/observe.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { observeObject as observe } from '../../services/connect-runtime/observe.service.ts';
import type { RuntimeDeps } from '../../services/connect-runtime/read.service.ts';

export function observeController(deps: RuntimeDeps): RouteHandlers<typeof observeObject> {
  return {
    handle: ({ body }, ctx) => observe(deps, { request: ctx.request, correlationId: ctx.correlationId, signal: ctx.signal }, body),
  };
}
