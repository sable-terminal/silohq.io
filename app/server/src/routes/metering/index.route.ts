// The metering service (spec 73, 74.1): token and simulation charges, daily limits,
// allowances, purchased balances, the ledger, and Siloes byte counts from metering.usage.

import { grantAllowance, readAllowance } from '../../contracts/metering/allowance.contract.ts';
import { charge } from '../../contracts/metering/charge.contract.ts';
import { engagementCost, listLedger } from '../../contracts/metering/ledger.contract.ts';
import { creditPurchase } from '../../contracts/metering/purchase.contract.ts';
import { setAutoTopup } from '../../contracts/metering/autoTopup.contract.ts';
import { setAutoTopup as switchAutoTopup } from '../../services/metering/autoTopup.service.ts';
import { meteringController } from '../../controllers/metering/metering.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { DEFAULT_SETTINGS, type MeteringDeps, type MeteringSettings } from '../../services/metering/deps.service.ts';
import { usageWorker } from '../../workers/metering/usage.worker.ts';

export interface MeteringOptions {
  settings?: Partial<MeteringSettings>;
  /** The durable consumer's name. Each test run uses its own. */
  consumer?: string;
}

export function createMeteringService(options: MeteringOptions = {}): ServiceDefinition {
  return defineService({
    name: 'metering',
    needs: { postgres: ['control'], redis: ['data'], bus: ['durable'] },
    create(deps) {
      const metering: MeteringDeps = {
        databases: deps.databases, data: deps.redis.data!, services: deps.services, logger: deps.logger,
        settings: { ...DEFAULT_SETTINGS, ...options.settings },
      };
      const controller = meteringController(metering);
      return {
        routes: [
          route(charge, controller.charge),
          route(grantAllowance, controller.grantAllowance),
          route(readAllowance, controller.readAllowance),
          route(creditPurchase, controller.creditPurchase),
          route(listLedger, controller.listLedger),
          route(engagementCost, controller.engagementCost),
          // Auto top-up, opt-in (73.4).
          route(setAutoTopup, { handle: ({ params, body }, ctx) => switchAutoTopup(metering, ctx, params.membershipId, body.enabled) }),
        ],
        workers: [usageWorker(metering, deps.durableBus!, options.consumer ?? 'metering')],
      };
    },
  });
}

export const service = createMeteringService();
