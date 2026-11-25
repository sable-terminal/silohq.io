// Silo staff paths from the admin portal (spec 75.3).
// Each needs a live operator session that may act for the organisation, and names the
// operator in its audit event.

import type { HandlerOutput, ParsedInput } from '../../contracts/endpoint.contract.ts';
import type { setBillingStatus } from '../../contracts/billing/staff.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { recordEvent, requireOperator, type BillingDeps } from './deps.service.ts';
import { writeBillingStatus } from './webhook.service.ts';

/** Billing status by a named staff identity with a reason, writing the event the webhook writes. */
export async function setStatus(deps: BillingDeps, ctx: HandlerContext, body: ParsedInput<typeof setBillingStatus>['body'])
  : Promise<HandlerOutput<typeof setBillingStatus>> {
  const organisationId = ctx.request.organisationId!;
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const operator = await requireOperator(db, ctx);
    const current = await organisationRepo.lockBillingStatus(db, organisationId);
    if (current === undefined) throw new AppError('not_found', 'no such organisation', { code: 'billing.organisation_unknown' });
    const changed = await writeBillingStatus(db, organisationId, current, body.status, ctx.correlationId,
      { source: 'staff', reason: body.reason }, operator);
    return { billingStatus: body.status, changed };
  });
}
