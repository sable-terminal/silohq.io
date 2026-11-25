// Tenant migrations: the customer's routes take the organisation and membership from the
// request context; the operator's routes name the organisation in the body, as
// admin-portal authenticated the operator.

import type * as c from '../../contracts/tenant-migrations/migration.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { Requests } from '../../services/tenant-migrations/requests.service.ts';

export function migrationController(requests: Requests): {
  residency: RouteHandlers<typeof c.getResidency>;
  list: RouteHandlers<typeof c.listTenantMigrations>;
  get: RouteHandlers<typeof c.getTenantMigration>;
  request: RouteHandlers<typeof c.requestTenantMigration>;
  respond: RouteHandlers<typeof c.respondToRebalancing>;
  withdraw: RouteHandlers<typeof c.withdrawTenantMigration>;
  propose: RouteHandlers<typeof c.proposeRebalancing>;
  sign: RouteHandlers<typeof c.signTenantMigration>;
  schedule: RouteHandlers<typeof c.scheduleTenantMigration>;
  abort: RouteHandlers<typeof c.abortTenantMigration>;
  importKey: RouteHandlers<typeof c.getTenantImportKey>;
} {
  return {
    residency: { handle: (_input, ctx) => requests.residency(ctx) },
    list: { handle: (_input, ctx) => requests.list(ctx) },
    get: { handle: (input, ctx) => requests.get(ctx, input.params.migrationId) },
    request: { handle: (input, ctx) => requests.request(ctx, input.body) },
    respond: { handle: (input, ctx) => requests.respond(ctx, input.params.migrationId, input.body) },
    withdraw: { handle: (input, ctx) => requests.withdraw(ctx, input.params.migrationId) },
    propose: { handle: (input, ctx) => requests.proposeRebalancing(ctx.correlationId, input.body) },
    sign: { handle: (input, ctx) => requests.sign(ctx.correlationId, input.params.migrationId, input.body) },
    schedule: { handle: (input, ctx) => requests.schedule(ctx.correlationId, input.params.migrationId, input.body) },
    abort: { handle: (input, ctx) => requests.abort(ctx.correlationId, input.params.migrationId, input.body) },
    importKey: { handle: (_input, ctx) => requests.importKey(ctx.correlationId) },
  };
}
