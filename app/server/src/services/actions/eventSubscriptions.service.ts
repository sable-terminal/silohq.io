// Outbound Action event subscriptions (spec 48.3; contracts/actions/actionEvent.contract.ts):
// created, listed, paused and resumed by a holder of action.define. Creating one asks the
// credential service for its signing secret, shown to the creator once and stored only
// there; the subscription keeps the reference. A resumed subscription takes new events;
// deliveries that died with a dead letter stay dead.

import type { ActionEventFilter, SubscriptionView } from '../../contracts/actions/actionEvent.contract.ts';
import { createActionEventSecret } from '../../contracts/credential/actionEventSecret.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { ActionEventSubscription } from '../../models/action/actionEventSubscription.model.ts';
import { actionEventSubscriptionRepo } from '../../repos/action/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { callOptions, demand, memberOf, type Context, type WriteBackDeps } from './deps.service.ts';
import { recordActionEvent } from './events.service.ts';

export const subscriptionViewOf = (s: ActionEventSubscription): SubscriptionView => ({
  id: s.id, endpointUrl: s.endpointUrl, filter: s.filter as ActionEventFilter, status: s.status, statusChangedAt: s.statusChangedAt,
  createdBy: s.createdBy, createdAt: s.createdAt, version: s.version,
});

export function createEventSubscriptions(deps: WriteBackDeps) {
  const control = deps.databases.pool('control');

  return {
    async create(ctx: Context, input: { endpointUrl: string; filter: ActionEventFilter }): Promise<{ subscription: SubscriptionView; secret: string }> {
      const { organisationId, membershipId } = memberOf(ctx, 'subscribing to Action events');
      await demand(deps, ctx, 'action.define', undefined, 'action_event.not_permitted');
      const secret = await deps.services.call(createActionEventSecret, { body: {} }, callOptions(ctx));
      const id = uuidv7();
      try {
        await inTransaction(control, ctx.request, async (db) => {
          await actionEventSubscriptionRepo.insert(db, {
            id, organisationId, endpointUrl: input.endpointUrl, secretRef: secret.credentialId, filter: input.filter as never, createdBy: membershipId,
          });
          await recordActionEvent(db, {
            organisationId, correlationId: ctx.correlationId, event: 'action_event_subscription_created', request: ctx.request, service: 'actions',
            resource: { type: 'action_event_subscription', id }, detail: { host: new URL(input.endpointUrl).host },
          });
        });
      } catch (error) {
        if (fromDatabaseError(error).details['sqlstate'] === '23514') {
          throw new AppError('validation', 'an Action event endpoint is HTTPS', { code: 'action_event.endpoint_not_https' });
        }
        throw error;
      }
      const row = (await inTransaction(control, ctx.request, (db) => actionEventSubscriptionRepo.findById(db, id), { readOnly: true }))!;
      return { subscription: subscriptionViewOf(row), secret: secret.secret };
    },

    async list(ctx: Context, limit: number): Promise<SubscriptionView[]> {
      memberOf(ctx, 'listing Action event subscriptions');
      await demand(deps, ctx, 'action.define', undefined, 'action_event.not_permitted');
      const rows = await inTransaction(control, ctx.request, (db) => actionEventSubscriptionRepo.list(db, limit), { readOnly: true });
      return rows.map(subscriptionViewOf);
    },

    async setStatus(ctx: Context, subscriptionId: string, input: { status: 'active' | 'paused'; version: number }): Promise<SubscriptionView> {
      const { organisationId } = memberOf(ctx, 'pausing or resuming an Action event subscription');
      await demand(deps, ctx, 'action.define', undefined, 'action_event.not_permitted');
      const row = await inTransaction(control, ctx.request, async (db) => {
        const found = await actionEventSubscriptionRepo.findById(db, subscriptionId);
        if (!found) throw new AppError('not_found', 'no such Action event subscription', { code: 'action_event.subscription_not_found' });
        if (found.version !== input.version) throw new AppError('conflict', 'the subscription changed; read it again', { code: 'action_event.stale' });
        if (found.status === input.status) return found;
        const updated = await actionEventSubscriptionRepo.update(db, subscriptionId, {
          status: input.status, statusChangedAt: new Date().toISOString(), version: found.version + 1,
        });
        if (input.status === 'paused') {
          await recordActionEvent(db, {
            organisationId, correlationId: ctx.correlationId, event: 'action_event_subscription_paused', request: ctx.request, service: 'actions',
            resource: { type: 'action_event_subscription', id: subscriptionId },
          });
        }
        return updated!;
      });
      return subscriptionViewOf(row);
    },
  };
}

export type EventSubscriptions = ReturnType<typeof createEventSubscriptions>;
