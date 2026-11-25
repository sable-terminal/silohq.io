// state-plane (spec 24.3, 30; catalogue: state-plane): live object state for subscribed
// sets only, in redis-state with persistence disabled. Resolves a set once under the
// holder's permissions, applies change-stream's deltas to the objects it holds, and
// publishes per-group frames on bus-live for the gateway to fan out. Groups are per set and
// permission fingerprint, so values are never shared across permissions. Nothing is written
// to disk: a lost replica's state is rebuilt by backfill (spec 30.6).

import { keysWithoutTtlGauge } from '../../infra/signals.infra.ts';
import { hostname } from 'node:os';
import {
  closeLiveSubscription, openLiveSubscription, renewLiveSubscriptions, reportLiveBufferMode,
} from '../../contracts/state-plane/subscription.contract.ts';
import { subscriptionController } from '../../controllers/state-plane/subscription.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { createDeltaApplier } from '../../services/state-plane/deltas.service.ts';
import type { StatePlaneDeps } from '../../services/state-plane/deps.service.ts';
import { createGroupStore } from '../../services/state-plane/groups.service.ts';
import { createSubscriptions } from '../../services/state-plane/subscriptions.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { liveWorker } from '../../workers/state-plane/live.worker.ts';
import { watchWorker } from '../../workers/state-plane/watch.worker.ts';

export interface StatePlaneOptions {
  /** How often policy versions and source health are checked; tests shorten it. */
  watchMs?: number;
  /** Changes a second per connection above which it coalesces (18.4); tests lower it. */
  coalesceAbovePerSecond?: number;
}

export function createStatePlaneService(options: StatePlaneOptions = {}): ServiceDefinition {
  return defineService({
    name: 'state-plane',
    needs: { postgres: ['control'], redis: ['state'], bus: ['live'] },
    create(deps) {
      // Keys without a TTL in redis-state page (13.2; D252).
      deps.signals.gauge('redis_state_keys_without_ttl', keysWithoutTtlGauge(() => deps.redis.state!.auditKeys()));
      // Spec 30.7: a node that finds RDB or AOF enabled refuses to start; connectRedis checks
      // every instance it opens, redis-state included.
      const planeDeps: StatePlaneDeps = {
        cellId: deps.config.cell.id, node: `${hostname()}:${uuidv7().slice(-12)}`, databases: deps.databases, services: deps.services,
        state: deps.redis.state!, liveBus: deps.liveBus!, logger: deps.logger,
      };
      const groups = createGroupStore(planeDeps);
      const applier = createDeltaApplier(planeDeps, groups);
      const subscriptions = createSubscriptions(planeDeps, groups, applier);
      const handlers = subscriptionController(subscriptions);
      return {
        routes: [
          route(openLiveSubscription, handlers.open), route(closeLiveSubscription, handlers.close), route(renewLiveSubscriptions, handlers.renew),
          route(reportLiveBufferMode, handlers.bufferMode),
        ],
        workers: [liveWorker(planeDeps, groups, applier, subscriptions, options.coalesceAbovePerSecond), watchWorker(planeDeps, groups, subscriptions, options.watchMs ?? 3_000, applier)],
      };
    },
  });
}

export const service = createStatePlaneService();
