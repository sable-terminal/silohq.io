// The outbox relay (docs/siloServiceCatalogue.doc.md): a worker with no endpoints. Its
// login is a member of silo_outbox_relay only, which may execute the three relay
// functions and nothing else (design D21).

import { createObjectStore, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { createRelay, type RelayOptions } from '../../services/outbox-relay/relay.service.ts';
import { AppError } from '../../utils/errors.util.ts';
import { relayWorker } from '../../workers/outbox-relay/relay.worker.ts';

export interface OutboxRelayOptions {
  relay?: Partial<RelayOptions>;
  idleMs?: number;
  /** object-backup, for the purge ledger (D251); the configured object storage otherwise. */
  backup?: ObjectStore;
}

export function createOutboxRelayService(options: OutboxRelayOptions = {}): ServiceDefinition {
  return defineService({
    name: 'outbox-relay',
    needs: { postgres: ['control'], bus: ['durable'] },
    async create(deps) {
      if (!deps.durableBus) throw new AppError('configuration', 'the outbox relay needs bus-durable', { code: 'config.bus.durable' });
      // The purge ledger's entries go to object-backup (8.2; D251); without storage they wait, alerting.
      const backup = options.backup ?? (deps.config.objectStorage === undefined ? undefined : await createObjectStore(deps.config.objectStorage));
      const relay = createRelay({
        databases: deps.databases, bus: deps.durableBus, logger: deps.logger, backup, ...(options.relay ? { options: options.relay } : {}),
      });
      // The audit outbox backlog the cell's Fleet agent gates releases on (spec 11.2).
      deps.signals.gauge('audit_outbox_oldest_seconds', async () => (await relay.backlog()).oldestSeconds);
      deps.signals.gauge('audit_outbox_pending', async () => (await relay.backlog()).pending);
      return { routes: [], workers: [relayWorker(relay, deps.logger, options.idleMs)] };
    },
  });
}

export const service = createOutboxRelayService();
