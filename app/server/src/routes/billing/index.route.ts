// The billing service (spec 71, 74, 75): subscriptions, entitlements, the payment webhook,
// billing status, purchases, and Enterprise contracts with their
// invoices, manual payments and sweeps. Compiled out of the sovereign cell (spec 7): it
// refuses to start in a build without the payment capability.

import { receivePaymentEvent } from '../../contracts/billing/paymentEvent.contract.ts';
import { purchase } from '../../contracts/billing/purchase.contract.ts';
import * as c from '../../contracts/billing/contract.contract.ts';
import { setBillingStatus } from '../../contracts/billing/staff.contract.ts';
import { openBillingPortal, readBilling, startCheckout } from '../../contracts/billing/subscription.contract.ts';
import { listSiloCharges } from '../../contracts/billing/siloCharges.contract.ts';
import { buySeats, syncSeatCount } from '../../contracts/billing/seats.contract.ts';
import { autoTopUp } from '../../contracts/billing/autoTopup.contract.ts';
import { createSeatSync } from '../../services/billing/seats.service.ts';
import { autoTopUp as buyTopUp } from '../../services/billing/autoTopup.service.ts';
import { createSiloCharges } from '../../services/billing/siloCharges.service.ts';
import { required } from '../../config/index.config.ts';
import { billingController } from '../../controllers/billing/billing.controller.ts';
import { contractController } from '../../controllers/billing/contract.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { createPaymentProvider, type PaymentProvider } from '../../infra/payments/payments.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { createContracts } from '../../services/billing/contracts.service.ts';
import { createInvoicing } from '../../services/billing/invoicing.service.ts';
import { createSweeps, type Sweeps } from '../../services/billing/sweeps.service.ts';
import { AppError } from '../../utils/errors.util.ts';
import { sweepsWorker } from '../../workers/billing/sweeps.worker.ts';

export interface BillingOptions {
  /** The payment provider. Default: the configured provider's API. */
  payments?: PaymentProvider;
  /** The clock of the sweeps (tests move it). */
  now?: () => Date;
  /** Run the sweeps on their timer. Default true; tests call them directly. */
  sweep?: boolean;
  /** Hands the sweeps to a test. */
  onSweeps?: (sweeps: Sweeps) => void;
}

export function createBillingService(options: BillingOptions = {}): ServiceDefinition {
  return defineService({
    name: 'billing',
    needs: { postgres: ['control'], redis: ['data'] },
    create(deps) {
      const { config } = deps;
      if (!config.cell.capabilities.has('stripe')) {
        throw new AppError('configuration', 'billing is compiled out of this build (spec 7); entitlements come from a staff path', {
          code: 'config.billing.not_in_build',
        });
      }
      const payments = options.payments ?? createPaymentProvider(required(config.payments, 'PAYMENTS_API_KEY'));
      const billingDeps = { config, databases: deps.databases, services: deps.services, payments, logger: deps.logger };
      const controller = billingController(billingDeps);
      const enterprise = { ...billingDeps, contracts: config.contracts };
      const k = contractController(createContracts(enterprise), createInvoicing(billingDeps));
      const sweeps = createSweeps(enterprise, options.now);
      const siloCharges = createSiloCharges(billingDeps);
      const seats = createSeatSync(billingDeps);
      const topUps = { ...billingDeps, autoTopupsPerDay: config.contracts.autoTopupsPerDay };
      options.onSweeps?.(sweeps);
      return {
        workers: options.sweep === false ? [] : [sweepsWorker(sweeps, config.contracts.sweepSeconds * 1000, deps.logger)],
        routes: [
          route(receivePaymentEvent, controller.receivePaymentEvent),
          route(startCheckout, controller.startCheckout),
          route(openBillingPortal, controller.openBillingPortal),
          route(readBilling, controller.readBilling),
          // Siloes at provider cost plus 10%, per line (74.1).
          route(listSiloCharges, { handle: ({ query }, ctx) => siloCharges.list(ctx, query.period) }),
          // Seat counts synced with the provider (72.2, 74.5).
          route(buySeats, {
            handle: ({ body }, ctx) => seats.buy(ctx, body.seats),
            resultRef: (out) => `${out.seatCount}.${out.added}`,
            replay: async (ref) => ({ seatCount: Number(ref!.split('.')[0]), added: Number(ref!.split('.')[1]) }),
          }),
          route(syncSeatCount, { handle: (_input, ctx) => seats.sync(ctx.request.organisationId!, ctx.correlationId) }),
          // Auto top-up's purchase, asked by metering (73.4).
          route(autoTopUp, { handle: ({ body }, ctx) => buyTopUp(topUps, ctx, body) }),
          route(purchase, controller.purchase),
          route(setBillingStatus, controller.setBillingStatus),
          route(c.quoteContract, k.quoteContract), route(c.createContract, k.createContract), route(c.amendContractDraft, k.amendContractDraft),
          route(c.approveContractMargin, k.approveContractMargin), route(c.activateContract, k.activateContract),
          route(c.amendContract, k.amendContract), route(c.renewContract, k.renewContract),
          route(c.setContractRenewalState, k.setContractRenewalState), route(c.listContracts, k.listContracts),
          route(c.readOwnContracts, k.readOwnContracts), route(c.contractUsage, k.contractUsage),
          route(c.raiseContractInvoice, k.raiseContractInvoice), route(c.recordManualInvoice, k.recordManualInvoice),
          route(c.recordManualPayment, k.recordManualPayment),
        ],
      };
    },
  });
}

export const service = createBillingService();
