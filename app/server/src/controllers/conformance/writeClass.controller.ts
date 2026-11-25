// conformance's write class endpoints (spec 17.1): the write-verify-undo cycle, and the switch it gates.

import type { getWriteClassStatus, runWriteClass, setConnectionWrites } from '../../contracts/conformance/writeClass.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { WriteClass } from '../../services/conformance/writeClass.service.ts';

export function writeClassController(writeClass: WriteClass) {
  return {
    status: { handle: ({ params }, ctx) => writeClass.status(ctx, params.connectionId) } satisfies RouteHandlers<typeof getWriteClassStatus>,
    run: { handle: ({ params, body }, ctx) => writeClass.run(ctx, params.connectionId, body) } satisfies RouteHandlers<typeof runWriteClass>,
    set: { handle: ({ params, body }, ctx) => writeClass.setWrites(ctx, params.connectionId, body.enabled) } satisfies RouteHandlers<typeof setConnectionWrites>,
  };
}
