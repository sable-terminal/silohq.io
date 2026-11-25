// A mutation's webhook deliveries and their effect (spec 20.4): read by whoever may see the mutation.

import type { WebhookDeliveryView } from '../../contracts/actions/webhookDelivery.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { mutationRepo, webhookDeliveryRepo } from '../../repos/action/index.repo.ts';
import { webhookEndpointRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import type { Context, WriteBackDeps } from './deps.service.ts';

export async function listDeliveries(deps: WriteBackDeps, ctx: Context, mutationId: string): Promise<{ deliveries: WebhookDeliveryView[] }> {
  return inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    if (await mutationRepo.findById(db, mutationId) === undefined) throw new AppError('not_found', 'no such mutation', { code: 'mutation.not_found' });
    const rows = await webhookDeliveryRepo.listForMutation(db, mutationId);
    const endpoints = new Map<string, boolean>();
    for (const id of new Set(rows.map((r) => r.endpointId))) endpoints.set(id, ((await webhookEndpointRepo.findById(db, id))?.statusUrl ?? null) !== null);
    return {
      deliveries: rows.map((r) => ({
        id: r.id, endpointId: r.endpointId, status: r.status as WebhookDeliveryView['status'], attempts: r.attempts, lastStatus: r.lastStatus, lastError: r.lastError,
        deliveredAt: r.deliveredAt, failedAt: r.failedAt, records: endpoints.get(r.endpointId) === true ? 'effect' as const : 'delivery' as const,
        effect: r.effect as WebhookDeliveryView['effect'], effectCheckedAt: r.effectCheckedAt,
      })),
    };
  }, { readOnly: true });
}
