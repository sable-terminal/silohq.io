// The Warehouse sync endpoint: thin, over services/warehouse-sync. A person starting a sync
// holds silo.manage; the provisioner and reconciliation call as the Warehouse's principal.

import type { applyWarehouseObservations } from '../../contracts/warehouse/observations.contract.ts';
import type { purgeActionLedgerValues, syncWarehouse, writeActionLedger } from '../../contracts/warehouse/warehouse.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import { purgeLedgerValues, writeLedger } from '../../services/warehouse-sync/ledger.service.ts';
import { applyObservations } from '../../services/warehouse-sync/observations.service.ts';
import { startSync } from '../../services/warehouse-sync/sync.service.ts';
import { requireSiloes } from '../../services/siloes-capture/deps.service.ts';
import { demand, type WarehouseDeps } from '../../services/warehouse-schema/warehouse.service.ts';

export function syncController(deps: WarehouseDeps): {
  syncWarehouse: RouteHandlers<typeof syncWarehouse>; writeActionLedger: RouteHandlers<typeof writeActionLedger>;
  purgeActionLedgerValues: RouteHandlers<typeof purgeActionLedgerValues>;
  applyWarehouseObservations: RouteHandlers<typeof applyWarehouseObservations>;
} {
  return {
    applyWarehouseObservations: { handle: (input, ctx) => applyObservations(deps, ctx, input.body.siloId, input.body.entries) },
    writeActionLedger: { handle: (input, ctx) => writeLedger(deps, ctx, input.body.receiptId, input.body.rows) },
    purgeActionLedgerValues: { handle: (input, ctx) => purgeLedgerValues(deps, ctx, input.body.receiptIds) },
    syncWarehouse: {
      async handle(input, ctx) {
        if (ctx.caller === 'gateway') {
          await requireSiloes(deps, ctx);
          await demand(deps, ctx, 'silo.manage');
        }
        return startSync(deps, ctx, input.params.warehouseId, input.body.mode, input.body.objectTypeIds);
      },
    },
  };
}
