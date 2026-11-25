// The metering endpoints: contracts to the metering services. Nothing here decides anything.

import type { grantAllowance, readAllowance } from '../../contracts/metering/allowance.contract.ts';
import type { charge } from '../../contracts/metering/charge.contract.ts';
import type { engagementCost, listLedger } from '../../contracts/metering/ledger.contract.ts';
import type { creditPurchase } from '../../contracts/metering/purchase.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import * as allowances from '../../services/metering/allowances.service.ts';
import { chargeOperation, chargeRef, replayCharge } from '../../services/metering/charge.service.ts';
import type { MeteringDeps } from '../../services/metering/deps.service.ts';
import * as ledger from '../../services/metering/ledger.service.ts';
import * as purchases from '../../services/metering/purchases.service.ts';

export function meteringController(deps: MeteringDeps): {
  charge: RouteHandlers<typeof charge>;
  grantAllowance: RouteHandlers<typeof grantAllowance>;
  readAllowance: RouteHandlers<typeof readAllowance>;
  creditPurchase: RouteHandlers<typeof creditPurchase>;
  listLedger: RouteHandlers<typeof listLedger>;
  engagementCost: RouteHandlers<typeof engagementCost>;
} {
  return {
    charge: {
      handle: (input, ctx) => chargeOperation(deps, ctx, input.body),
      resultRef: chargeRef,
      replay: (ref, ctx) => replayCharge(deps, ctx, ref),
    },
    grantAllowance: { handle: (input, ctx) => allowances.grant(deps, ctx, input.body.membershipId) },
    readAllowance: { handle: (input, ctx) => allowances.read(deps, ctx, input.params.membershipId) },
    creditPurchase: { handle: (input, ctx) => purchases.credit(deps, ctx, input.body) },
    listLedger: { handle: (input, ctx) => ledger.list(deps, ctx, input.query) },
    engagementCost: { handle: (input, ctx) => ledger.engagementReport(deps, ctx, input.params.engagementId) },
  };
}
