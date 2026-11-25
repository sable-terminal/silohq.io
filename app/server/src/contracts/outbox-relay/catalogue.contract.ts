// The messages that travel from platform.outbox to bus-durable (spec 9.1, 9.2), and the
// envelope every one of them travels in.
//
// A producer writes an outbox row (topic, ordering key, event, schema version, payload)
// in the transaction that made the change. The relay finds the row's definition here by
// (topic, event, version), validates the payload against it, and publishes the envelope:
// the payload with the row's organisation, commit time and correlation id, which a
// consumer needs and the payload does not carry. The outbox row's id is the bus event id
// consumers deduplicate on. A row whose message is not listed here, or whose payload does
// not match, is never published (it waits, alerting, until fixed or dead-lettered).
//
// bus-durable persists, so these schemas carry references and counts only: a definition
// with a field marked as a record value is refused (spec 9.1).

import { z } from 'zod';
import { containsRecordValue } from '../../utils/recordValue.util.ts';
import { actionExecutedMessage } from '../actions/actionEvent.contract.ts';
import { mutationStageMessage } from '../actions/events.contract.ts';
import { auditEventMessage } from '../audit/auditEvent.contract.ts';
import { authEventMessage } from '../audit/authEvent.contract.ts';
import { storageMeasuredMessage } from '../metering/usage.contract.ts';
import { modelUsageMessage } from '../model-gateway/events.contract.ts';
import { purgeLedgerMessage } from '../platform/purgeLedger.contract.ts';

/**
 * The outbox's topics (its check constraint). control.release is Fleet's, not the outbox's.
 * platform.purge_ledger is delivered to object-backup, not the bus (contracts/platform/purgeLedger.contract.ts).
 */
export const OUTBOX_TOPICS = [
  'audit.events', 'metering.usage', 'control.policy', 'control.connection', 'control.agent', 'control.action', 'siloes.capture', 'platform.purge_ledger',
] as const;
export type OutboxTopic = (typeof OUTBOX_TOPICS)[number];

export interface OutboxMessage<S extends z.ZodType = z.ZodType> {
  readonly topic: OutboxTopic;
  /** The outbox row's event column. */
  readonly name: string;
  /** The outbox row's schema_version. */
  readonly version: number;
  readonly schema: S;
}

/** What crosses the bus for every outbox message. */
export function envelopeOf<S extends z.ZodType>(payload: S) {
  return z.strictObject({
    organisationId: z.uuid(),
    /** The outbox row's created_at: the commit time basis of the change. */
    occurredAt: z.iso.datetime({ offset: true }),
    correlationId: z.uuid(),
    payload,
  });
}
export type Envelope<S extends z.ZodType> = z.output<ReturnType<typeof envelopeOf<S>>>;

const NAME = /^[a-z][a-z0-9_]*$/;
export const catalogueKey = (topic: string, name: string, version: number): string => `${topic}/${name}/v${version}`;

function catalogue(messages: readonly OutboxMessage[]): ReadonlyMap<string, OutboxMessage> {
  const map = new Map<string, OutboxMessage>();
  for (const message of messages) {
    const key = catalogueKey(message.topic, message.name, message.version);
    if (!NAME.test(message.name)) throw new TypeError(`${key}: the name is snake_case`);
    if (!Number.isInteger(message.version) || message.version < 1) throw new TypeError(`${key}: the version is a positive integer`);
    if (map.has(key)) throw new TypeError(`${key} is listed twice`);
    if (containsRecordValue(message.schema)) throw new TypeError(`${key}: bus-durable carries no record values (spec 9.1)`);
    map.set(key, message);
  }
  return map;
}

/** Every message an outbox row may carry. A service adds its message here when it starts writing it. */
export const OUTBOX_CATALOGUE = catalogue([
  authEventMessage, auditEventMessage, modelUsageMessage, storageMeasuredMessage, mutationStageMessage, actionExecutedMessage, purgeLedgerMessage,
]);

export function outboxMessage(topic: string, name: string, version: number): OutboxMessage | undefined {
  return OUTBOX_CATALOGUE.get(catalogueKey(topic, name, version));
}
