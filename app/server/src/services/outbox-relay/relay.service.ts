// The outbox relay (spec 9.2; design: platform.outbox, D21): publishes each committed
// outbox row to bus-durable, in order per ordering key, with retries and dead-lettering.
//
// One pass:
// 1. claim the due head of each ordering key (platform.outbox_claim leases it, so another
//    relay replica neither claims it nor the row behind it until it is published or the
//    lease runs out: per-key order holds across replicas);
// 2. find each row's message in the outbox catalogue, validate the payload, and publish
//    the envelope with the row id as the bus event id, the keys in parallel;
// 3. mark the published rows in one statement, and each failure with a category and when
//    to retry: exponential backoff from 1 second to maxBackoffSeconds. A row that cannot
//    be published as it stands (no message listed, payload does not match, too large)
//    waits an hour at a time and alerts; it holds its key, because skipping it would break
//    the order consumers rely on. platform.outbox_mark_failed dead-letters any row
//    unacknowledged for 7 days (spec 9.1), which alerts, and the key moves on.
//
// A row published and then not marked (the database went away) is published again when
// its lease runs out: consumers are idempotent on the event id (bus-durable is at least
// once), and JetStream also drops the duplicate by message id.

import { metrics, type Counter, type Histogram } from '@opentelemetry/api';
import { envelopeOf, outboxMessage, type OutboxMessage } from '../../contracts/outbox-relay/catalogue.contract.ts';
import { PURGE_LEDGER_TOPIC, purgeLedgerParts } from '../../contracts/platform/purgeLedger.contract.ts';
import type { DurableBus, DurableMessage } from '../../infra/bus.infra.ts';
import { objectKey, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import { outboxRepo, type ClaimedOutboxRow } from '../../repos/platform/outbox.repo.ts';
import { isAppError } from '../../utils/errors.util.ts';

export interface RelayOptions {
  /** Rows claimed per pass, at most one per ordering key (1 to 1000). */
  batchSize: number;
  /** How long a claim holds its row before another relay may take it. */
  leaseSeconds: number;
  maxBackoffSeconds: number;
  /** Retry interval for a row that cannot be published as it stands. */
  unpublishableRetrySeconds: number;
  /** Backlog age above which the relay warns (spec 9.4: audit.events pages at 5 minutes). */
  backlogAlertSeconds: number;
}

export const DEFAULT_RELAY_OPTIONS: RelayOptions = {
  batchSize: 200, leaseSeconds: 30, maxBackoffSeconds: 300, unpublishableRetrySeconds: 3_600, backlogAlertSeconds: 300,
};

const DEAD_LETTER_MS = 7 * 86_400_000;
const UNPUBLISHABLE = new Set(['unregistered_message', 'schema_mismatch', 'message_too_large']);

export interface PassResult {
  claimed: number;
  published: number;
  failed: number;
  deadLettered: number;
}

export interface RelayDeps {
  databases: Databases;
  bus: DurableBus;
  logger: Logger;
  options?: Partial<RelayOptions>;
  /** object-backup: where the purge ledger's entries go (spec 8.2; D251). Without it they wait, alerting. */
  backup?: ObjectStore | undefined;
}

export interface Relay {
  /** One claim, publish and mark pass. */
  pass(): Promise<PassResult>;
  /** What waits to be published and the oldest's age: the Fleet agent's audit outbox gate (spec 11.2). */
  backlog(): Promise<{ pending: number; oldestSeconds: number }>;
  readonly options: RelayOptions;
}

let instruments: { published: Counter; failed: Counter; deadLettered: Counter; lag: Histogram } | undefined;
const meter = () => (instruments ??= {
  published: metrics.getMeter('silo').createCounter('silo.outbox.published'),
  failed: metrics.getMeter('silo').createCounter('silo.outbox.publish_failed'),
  deadLettered: metrics.getMeter('silo').createCounter('silo.outbox.dead_lettered'),
  lag: metrics.getMeter('silo').createHistogram('silo.outbox.publish_lag_ms'),
});

/** Seconds before the next attempt: 1, 2, 4 ... up to the cap, with 20% jitter either way. */
export function backoffSeconds(attempts: number, maxSeconds: number, random: () => number = Math.random): number {
  const base = Math.min(maxSeconds, 2 ** Math.max(0, Math.min(attempts - 1, 30)));
  return Math.max(1, Math.round(base * (0.8 + 0.4 * random())));
}

// A category for last_error_category: closed-set names only, never a broker message.
function categoryOf(error: unknown): string {
  if (isAppError(error)) {
    if (error.code === 'bus.message_too_large') return 'message_too_large';
    if (error.code === 'bus.schema_mismatch') return 'schema_mismatch';
    return error.category;
  }
  return 'internal';
}

export function createRelay(deps: RelayDeps): Relay {
  const options: RelayOptions = { ...DEFAULT_RELAY_OPTIONS, ...deps.options };
  const pool = deps.databases.pool('control');
  const definitions = new Map<OutboxMessage, DurableMessage>();
  const definitionOf = (message: OutboxMessage): DurableMessage => {
    let definition = definitions.get(message);
    if (!definition) {
      definition = { bus: 'durable', topic: message.topic, name: message.name, version: message.version, schema: envelopeOf(message.schema) };
      definitions.set(message, definition);
    }
    return definition;
  };

  async function publish(row: ClaimedOutboxRow): Promise<void> {
    const message = outboxMessage(row.topic, row.event, row.schemaVersion);
    if (!message) throw Object.assign(new Error('unregistered'), { relayCategory: 'unregistered_message' });
    // The purge ledger goes to object-backup, outside the database a restore rewinds (8.2; D251).
    if (row.topic === PURGE_LEDGER_TOPIC) {
      if (!message.schema.safeParse(row.payload).success) throw Object.assign(new Error('mismatch'), { relayCategory: 'schema_mismatch' });
      if (deps.backup === undefined) throw Object.assign(new Error('no backup store'), { relayCategory: 'ledger_store_missing' });
      const stored = { id: row.id, organisationId: row.organisationId, occurredAt: row.createdAt, correlationId: row.correlationId, entry: row.payload };
      await deps.backup.put('backup', objectKey.cell(...purgeLedgerParts(row.createdAt, row.id)), Buffer.from(JSON.stringify(stored)), 'application/json');
      return;
    }
    const definition = definitionOf(message);
    const envelope = { organisationId: row.organisationId, occurredAt: row.createdAt, correlationId: row.correlationId, payload: row.payload };
    if (!definition.schema.safeParse(envelope).success) {
      throw Object.assign(new Error('mismatch'), { relayCategory: 'schema_mismatch' });
    }
    await deps.bus.publish(definition, envelope, { eventId: row.id, orderingKey: row.orderingKey });
  }

  return {
    options,
    backlog() {
      return inTransaction(pool, {}, (db) => outboxRepo.backlog(db), { readOnly: true });
    },

    async pass() {
      const claimed = await inTransaction(pool, {}, (db) => outboxRepo.claim(db, options.batchSize, options.leaseSeconds));
      if (claimed.length === 0) return { claimed: 0, published: 0, failed: 0, deadLettered: 0 };

      const now = Date.now();
      const outcomes = await Promise.all(claimed.map(async (row) => {
        try {
          await publish(row);
          return { row, category: undefined };
        } catch (error) {
          const relayCategory = (error as { relayCategory?: string }).relayCategory;
          return { row, category: relayCategory ?? categoryOf(error) };
        }
      }));

      const published = outcomes.filter((o) => o.category === undefined).map((o) => o.row);
      const failed = outcomes.filter((o): o is { row: ClaimedOutboxRow; category: string } => o.category !== undefined);
      let deadLettered = 0;
      await inTransaction(pool, {}, async (db) => {
        await outboxRepo.markPublished(db, published);
        for (const { row, category } of failed) {
          const retry = UNPUBLISHABLE.has(category) ? options.unpublishableRetrySeconds : backoffSeconds(row.attempts, options.maxBackoffSeconds);
          await outboxRepo.markFailed(db, row, category, retry);
        }
      });

      let oldest = 0;
      for (const row of published) {
        const lag = now - Date.parse(row.createdAt);
        oldest = Math.max(oldest, lag);
        meter().published.add(1, { topic: row.topic });
        meter().lag.record(lag, { topic: row.topic });
      }
      for (const { row, category } of failed) {
        const age = now - Date.parse(row.createdAt);
        oldest = Math.max(oldest, age);
        meter().failed.add(1, { topic: row.topic, category });
        const fields = { eventId: row.id, topic: row.topic, organisationId: row.organisationId, reason: category, attempt: row.attempts };
        if (age > DEAD_LETTER_MS) {
          // outbox_mark_failed dead-lettered it: the key moves on, and on-call must look (spec 9.1).
          deadLettered += 1;
          meter().deadLettered.add(1, { topic: row.topic, category });
          deps.logger.error('an outbox row was dead-lettered after 7 days unpublished', { ...fields, event: 'outbox.dead_lettered' });
        } else if (UNPUBLISHABLE.has(category)) {
          deps.logger.error('an outbox row cannot be published as it stands; its ordering key waits', { ...fields, event: 'outbox.unpublishable' });
        } else {
          deps.logger.warn('an outbox row failed to publish; it will be retried', { ...fields, event: 'outbox.publish_failed' });
        }
      }
      if (oldest > options.backlogAlertSeconds * 1000) {
        deps.logger.warn('the outbox backlog is older than its alert threshold', {
          event: 'outbox.backlog', durationMs: oldest, limit: options.backlogAlertSeconds,
        });
      }
      return { claimed: claimed.length, published: published.length, failed: failed.length, deadLettered };
    },
  };
}
