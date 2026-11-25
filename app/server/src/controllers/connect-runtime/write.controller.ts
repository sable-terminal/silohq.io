// connect-runtime's write path endpoints: the writes of an approved mutation, and the record
// reads around them.

import type { prepareWrites, readRecords, writeRecords } from '../../contracts/connect-runtime/write.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { RuntimeDeps } from '../../services/connect-runtime/read.service.ts';
import { prepareWrites as prepare, readRecords as read, writeRecords as write } from '../../services/connect-runtime/write.service.ts';

export function writeController(deps: RuntimeDeps): {
  write: RouteHandlers<typeof writeRecords>;
  prepare: RouteHandlers<typeof prepareWrites>;
  read: RouteHandlers<typeof readRecords>;
} {
  const caller = (ctx: Parameters<RouteHandlers<typeof writeRecords>['handle']>[1]) =>
    ({ caller: ctx.caller, request: ctx.request, correlationId: ctx.correlationId, signal: ctx.signal });
  return {
    write: {
      async handle({ body }, ctx) {
        return write(deps, caller(ctx), body) as never;
      },
    },
    prepare: {
      async handle({ body }, ctx) {
        return prepare(deps, caller(ctx), body) as never;
      },
    },
    read: {
      async handle({ body }, ctx) {
        return read(deps, caller(ctx), body) as never;
      },
    },
  };
}
