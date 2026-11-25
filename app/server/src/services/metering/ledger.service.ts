// Reading the ledger (spec 73.6) and the engagement cost report (73.5), under billing.view.
// The admin portal reads the report under an operator session.

import { modelCallRepo } from '../../repos/platform/index.repo.ts';
import type { engagementCost, listLedger } from '../../contracts/metering/ledger.contract.ts';
import type { HandlerOutput, ParsedInput } from '../../contracts/endpoint.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { requireOperatorSession } from '../admin-portal/sessionCheck.service.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import { tokenTransactionRepo } from '../../repos/billing/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { requirePermission, type MeteringDeps } from './deps.service.ts';
import { fromUnits, toUnits } from './funds.service.ts';

export async function list(deps: MeteringDeps, ctx: HandlerContext, query: ParsedInput<typeof listLedger>['query'])
  : Promise<HandlerOutput<typeof listLedger>> {
  await requirePermission(deps, ctx, 'billing.view');
  const organisationId = ctx.request.organisationId!;
  const rows = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => tokenTransactionRepo.list(db, organisationId, {
    membershipId: query.membershipId,
    before: query.beforeOccurredAt === undefined ? undefined : { occurredAt: query.beforeOccurredAt, id: query.beforeId! },
    limit: query.limit + 1,
  }), { readOnly: true });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    transactions: page.map((row) => ({
      id: row.id, membershipId: row.membershipId, operation: row.operation, pool: row.pool, weight: fromUnits(toUnits(row.weight)),
      source: row.source, correlationId: row.correlationId, engagementId: row.engagementId, occurredAt: row.occurredAt,
    })),
    next: rows.length > query.limit && last !== undefined ? { beforeOccurredAt: last.occurredAt, beforeId: last.id } : null,
  };
}

export async function engagementReport(deps: MeteringDeps, ctx: HandlerContext, engagementId: string)
  : Promise<HandlerOutput<typeof engagementCost>> {
  if (ctx.caller === 'admin-portal') {
    // Silo staff under a running break-glass session (spec 13.3): cost is metadata.
    await inTransaction(deps.databases.pool('control'), ctx.request, (db) => requireOperatorSession(db, ctx.request, 'metadata_read'), { readOnly: true });
  } else {
    await requirePermission(deps, ctx, 'billing.view');
  }
  const organisationId = ctx.request.organisationId!;
  return inTransaction(deps.databases.pool('control'), ctx.request, (db) => engagementTotals(db, organisationId, engagementId), { readOnly: true });
}

/**
 * The engagement cost report's figures (73.5): tokens and simulations charged by operation,
 * and the underlying model cost where measured. Also read by fde-orchestrator when an
 * engagement ends, for engagement_cost_reported.
 */
export async function engagementTotals(db: Queryable, organisationId: string, engagementId: string): Promise<HandlerOutput<typeof engagementCost>> {
  const lines = await tokenTransactionRepo.engagementTotals(db, organisationId, engagementId);
  const model = await modelCallRepo.engagementCost(db, engagementId);
  const total = (pool: 'tokens' | 'simulations') =>
    fromUnits(lines.filter((l) => l.pool === pool).reduce((sum, l) => sum + toUnits(l.units), 0n));
  return {
    engagementId,
    lines: lines.map((l) => ({ ...l, units: fromUnits(toUnits(l.units)) })),
    tokensCharged: total('tokens'),
    simulationsCharged: total('simulations'),
    modelCost: { calls: model.calls, priced: model.priced, amount: model.cost, measured: model.calls > 0 && model.priced === model.calls },
  };
}
