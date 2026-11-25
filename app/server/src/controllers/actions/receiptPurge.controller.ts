// Receipt purge's endpoints (spec 46.1, 70): thin, over services/actions/receiptPurges.

import type { getReceiptPurge, requestReceiptPurge, runReceiptRetentionSweep } from '../../contracts/actions/receiptPurge.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { ReceiptPurges } from '../../services/actions/receiptPurges.service.ts';

export function receiptPurgeController(purges: ReceiptPurges): {
  requestReceiptPurge: RouteHandlers<typeof requestReceiptPurge>;
  getReceiptPurge: RouteHandlers<typeof getReceiptPurge>;
  runReceiptRetentionSweep: RouteHandlers<typeof runReceiptRetentionSweep>;
} {
  return {
    requestReceiptPurge: { handle: (input, ctx) => purges.request(ctx, input.body) },
    getReceiptPurge: { handle: (input, ctx) => purges.get(ctx, input.params.purgeId) },
    runReceiptRetentionSweep: { handle: (_input, ctx) => purges.sweepOrganisation(ctx.request.organisationId!, ctx.correlationId) },
  };
}
