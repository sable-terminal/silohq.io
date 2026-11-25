// Enterprise contracts and invoices: contracts to the billing services. Nothing here decides anything.

import type * as c from '../../contracts/billing/contract.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { Contracts } from '../../services/billing/contracts.service.ts';
import type { Invoicing } from '../../services/billing/invoicing.service.ts';

export function contractController(contracts: Contracts, invoicing: Invoicing) {
  return {
    quoteContract: { handle: ({ body }, ctx) => contracts.quote(ctx, body) } satisfies RouteHandlers<typeof c.quoteContract>,
    createContract: { handle: ({ body }, ctx) => contracts.create(ctx, body) } satisfies RouteHandlers<typeof c.createContract>,
    amendContractDraft: {
      handle: ({ params, body }, ctx) => contracts.amendDraft(ctx, params.contractId, body),
    } satisfies RouteHandlers<typeof c.amendContractDraft>,
    approveContractMargin: {
      handle: ({ params, body }, ctx) => contracts.approveMargin(ctx, params.contractId, body),
    } satisfies RouteHandlers<typeof c.approveContractMargin>,
    activateContract: {
      handle: ({ params, body }, ctx) => contracts.activate(ctx, params.contractId, body),
    } satisfies RouteHandlers<typeof c.activateContract>,
    amendContract: { handle: ({ params, body }, ctx) => contracts.amend(ctx, params.contractId, body) } satisfies RouteHandlers<typeof c.amendContract>,
    renewContract: { handle: ({ params, body }, ctx) => contracts.renew(ctx, params.contractId, body) } satisfies RouteHandlers<typeof c.renewContract>,
    setContractRenewalState: {
      handle: ({ params, body }, ctx) => contracts.setRenewalState(ctx, params.contractId, body),
    } satisfies RouteHandlers<typeof c.setContractRenewalState>,
    listContracts: { handle: ({ query }, ctx) => contracts.list(ctx, query.limit) } satisfies RouteHandlers<typeof c.listContracts>,
    readOwnContracts: { handle: (_input, ctx) => contracts.readOwn(ctx) } satisfies RouteHandlers<typeof c.readOwnContracts>,
    contractUsage: { handle: ({ params }, ctx) => contracts.usage(ctx, params.contractId) } satisfies RouteHandlers<typeof c.contractUsage>,
    raiseContractInvoice: {
      handle: ({ params, body }, ctx) => invoicing.raise(ctx, params.contractId, body),
    } satisfies RouteHandlers<typeof c.raiseContractInvoice>,
    recordManualInvoice: { handle: ({ body }, ctx) => invoicing.recordManual(ctx, body) } satisfies RouteHandlers<typeof c.recordManualInvoice>,
    recordManualPayment: {
      handle: ({ params, body }, ctx) => invoicing.recordPayment(ctx, params.invoiceId, body),
    } satisfies RouteHandlers<typeof c.recordManualPayment>,
  };
}
