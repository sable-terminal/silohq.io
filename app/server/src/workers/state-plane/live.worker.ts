// The state plane's bus-live consumers (spec 9.2, 30.2, 30.6):
// - chg.<organisation>.<connection>.<object>: source changes from change-stream, applied to
//   live state and fanned out per group. A NATS queue group gives each change to one
//   replica.
// - ctl.<organisation>.resync.<group>: a subscriber saw a sequence gap; it is sent
//   resync_required and a fresh snapshot.
// At most once (spec 9.1): a change lost here shows as a sequence gap or a stale value until
// the next change, and a resync recovers.

import { inTransaction } from '../../infra/postgres.infra.ts';
import { recordCoalescing, recordSubscription } from '../../services/state-plane/deps.service.ts';
import { createCoalescer } from '../../services/state-plane/coalescing.service.ts';
import { rowIdOf, type Subscriptions } from '../../services/state-plane/subscriptions.service.ts';
import { sourceChange } from '../../contracts/change-stream/delta.contract.ts';
import { liveResyncRequest } from '../../contracts/gateway/live.contract.ts';
import type { Worker } from '../../infra/service.infra.ts';
import type { DeltaApplier } from '../../services/state-plane/deltas.service.ts';
import type { StatePlaneDeps } from '../../services/state-plane/deps.service.ts';
import type { GroupStore } from '../../services/state-plane/groups.service.ts';

const QUEUE = 'state-plane';
const ORG_OF_RESYNC = /^ctl\.([0-9a-f-]{36})\.resync\.([0-9a-f-]{36})$/;

/** Changes a second per connection above which it coalesces (18.4: 1,000, a target). */
export const COALESCE_ABOVE_PER_SECOND = 1_000;

export function liveWorker(deps: StatePlaneDeps, groups: GroupStore, applier: DeltaApplier, subscriptions?: Pick<Subscriptions, 'held'>,
  coalesceAbovePerSecond = COALESCE_ABOVE_PER_SECOND): Worker {
  const failed = (error: unknown, delta: { organisationId: string; connectionId: string }) => deps.logger.failure('a source change could not be applied', error, {
    event: 'live.apply_failed', organisationId: delta.organisationId, connectionId: delta.connectionId,
  });
  const coalescer = createCoalescer({
    abovePerSecond: coalesceAbovePerSecond,
    apply: (delta, coalesced) => applier.apply(delta, coalesced),
    onCoalescing: (delta, rate) => inTransaction(deps.databases.pool('control'), { organisationId: delta.organisationId }, (db) => recordCoalescing(db, {
      organisationId: delta.organisationId, connectionId: delta.connectionId, rate, threshold: coalesceAbovePerSecond, node: deps.node,
    })),
    onError: failed,
  });
  return {
    name: 'state-plane-live',
    async run(signal) {
      const stopChanges = deps.liveBus.subscribe(sourceChange, 'chg.>', async (delta, subject) => {
        if (!subject.startsWith(`chg.${delta.organisationId}.${delta.connectionId}.`)) return;
        try {
          await coalescer.push(delta);
        } catch (error) {
          failed(error, delta);
        }
      }, { queue: QUEUE });
      const stopResync = deps.liveBus.subscribe(liveResyncRequest, 'ctl.*.resync.*', async (request, subject) => {
        const match = ORG_OF_RESYNC.exec(subject);
        if (match === null || match[2] !== request.group) return;
        const organisationId = match[1]!;
        try {
          const plan = await groups.planOf(organisationId, request.group);
          if (plan === undefined) return;
          groups.publish(organisationId, request.group, { type: 'resync_required' }, request.subscription);
          await groups.snapshot(organisationId, request.group, plan, request.subscription);
          // subscription_resynced (32.7): the subscriber was sent the group anew; its holder where this replica opened it.
          const mine = subscriptions?.held.get(request.subscription);
          await inTransaction(deps.databases.pool('control'), { organisationId }, (db) => recordSubscription(db, {
            organisationId, membershipId: mine?.holder.membershipId, correlationId: rowIdOf(request.subscription), event: 'subscription_resynced',
            set: mine?.set, byStatePlane: true,
            detail: { subscription_id: rowIdOf(request.subscription), connection_id: plan.connectionId, ...(request.lastSeq === undefined ? {} : { last_seq: request.lastSeq }) },
          }));
        } catch (error) {
          deps.logger.failure('a resync could not be answered', error, { event: 'live.resync_failed', organisationId });
        }
      }, { queue: QUEUE });
      // Each second, the coalescing connections' records, one change apiece (18.4).
      const flusher = setInterval(() => { void coalescer.flush(); }, 1_000);
      await deps.liveBus.flush();
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      clearInterval(flusher);
      await coalescer.flush();
      stopChanges();
      stopResync();
    },
  };
}
