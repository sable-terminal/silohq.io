// The audit writer (spec 7.5, 63.1; design: audit.auth_events, audit.audit_events): consumes
// audit.events from bus-durable and stores each event once.
//
// - auth_event goes to audit.auth_events (no chain: tamper detection is the partition
//   seal), keyed by the outbox event id in source_event_id, so a redelivery is found by it.
// - audit_event is appended to the organisation's chain in audit.audit_events with its
//   catalogue retention class; a redelivery is found by source_event_id under the chain
//   lock, before a link is assigned.
// - occurred_at is the outbox row's time, the change's commit basis, carried in the
//   envelope; recorded_at is when it reached the ledger, so the gap is the bus lag.
//
// Bus-durable is at least once, so a message may arrive more than once and out of order;
// both are harmless. What fails is told apart:
// - a message that can never be stored as it stands (not in the catalogue, not matching
//   its schema, naming an organisation, membership or user this cell does not hold) is
//   logged as an error with its event id and acknowledged, so it cannot block the stream;
//   the outbox row it came from still holds it for 14 days;
// - anything else (the database unavailable, a timeout) is thrown, and the bus redelivers.

import { metrics, type Counter, type Histogram } from '@opentelemetry/api';
import { AUDIT_EVENT_CATALOGUE, auditEventMessage, type AuditEventPayload } from '../../contracts/audit/auditEvent.contract.ts';
import { authEventMessage, type AuthEvent as AuthEventPayload } from '../../contracts/audit/authEvent.contract.ts';
import { envelopeOf, outboxMessage, type Envelope } from '../../contracts/outbox-relay/catalogue.contract.ts';
import { decode, type DurableEnvelope } from '../../infra/bus.infra.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import { auditEventRepo, authEventRepo } from '../../repos/audit/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { isUuid } from '../../utils/id.util.ts';
import { appendToChain, closeChainHeads, utcDate } from './chain.service.ts';

export type WriteOutcome = 'written' | 'duplicate' | 'rejected';

export interface AuditWriter {
  handle(message: DurableEnvelope): Promise<WriteOutcome>;
  /** Organisations this process has written for: the daily close visits them. */
  readonly organisations: ReadonlySet<string>;
}

let instruments: { outcomes: Counter; lag: Histogram } | undefined;
const meter = () => (instruments ??= {
  outcomes: metrics.getMeter('silo').createCounter('silo.audit.events'),
  lag: metrics.getMeter('silo').createHistogram('silo.audit.bus_lag_ms'),
});

// Errors that redelivery cannot fix: the message itself is wrong for this cell.
function permanent(error: unknown): boolean {
  if (!isAppError(error)) return false;
  if (error.category === 'validation') return true;
  const sqlstate = String(error.details['sqlstate'] ?? '');
  return sqlstate === '23503' || sqlstate === '23514' || sqlstate === '23502' || sqlstate.startsWith('22');
}

export function createAuditWriter(deps: { databases: Databases; logger: Logger }): AuditWriter {
  const pool = deps.databases.pool('control');
  const organisations = new Set<string>();
  // The last day each organisation's heads are known closed through, so the daily close
  // runs at most once a day per organisation on the write path.
  const closedThrough = new Map<string, string>();

  async function writeAuthEvent(envelope: Envelope<typeof authEventMessage.schema>, eventId: string): Promise<WriteOutcome> {
    const payload: AuthEventPayload = envelope.payload;
    return inTransaction(pool, { organisationId: envelope.organisationId }, async (db) => {
      const key = { organisationId: envelope.organisationId, occurredAt: envelope.occurredAt, sourceEventId: eventId };
      if (await authEventRepo.findBySourceEvent(db, key)) return 'duplicate';
      await authEventRepo.insert(db, {
        occurredAt: envelope.occurredAt, organisationId: envelope.organisationId, userId: payload.userId, membershipId: payload.membershipId,
        event: payload.event, detail: payload.detail, sourceEventId: eventId,
        ipHash: payload.ipHash === null ? null : Buffer.from(payload.ipHash, 'hex'), correlationId: envelope.correlationId,
      });
      return 'written';
    });
  }

  async function writeAuditEvent(envelope: Envelope<typeof auditEventMessage.schema>, eventId: string): Promise<WriteOutcome> {
    const payload: AuditEventPayload = envelope.payload;
    const organisationId = envelope.organisationId;
    const retentionClass = AUDIT_EVENT_CATALOGUE.get(payload.event)!;
    const actor = payload.actor;
    const today = utcDate(Date.now());
    return inTransaction(pool, { organisationId }, async (db) => {
      await auditEventRepo.lockChain(db, organisationId);
      const existing = await auditEventRepo.findBySourceEventIdAndRetentionClassAndOccurredAt(db, {
        organisationId, sourceEventId: eventId, retentionClass, occurredAt: envelope.occurredAt,
      });
      if (existing) return 'duplicate';
      await appendToChain(db, organisationId, {
        sourceEventId: eventId, occurredAt: envelope.occurredAt, retentionClass, event: payload.event,
        membershipId: actor.kind === 'membership' ? actor.membershipId : null,
        servicePrincipalId: actor.kind === 'service_principal' ? actor.servicePrincipalId : null,
        operatorId: actor.kind === 'operator' ? actor.operatorId : null,
        systemService: actor.kind === 'service' ? actor.service : null,
        subjectMembershipId: payload.subjectMembershipId, scopeId: payload.scopeId,
        resourceType: payload.resource?.type ?? null, resourceId: payload.resource?.id ?? null,
        purposeSessionId: payload.purposeSessionId,
        operatorAccessSessionId: actor.kind === 'operator' ? actor.operatorAccessSessionId : payload.operatorAccessSessionId,
        correlationId: envelope.correlationId, detail: payload.detail,
        ipHash: payload.ipHash === null ? null : Buffer.from(payload.ipHash, 'hex'),
      });
      // The first write of a new day closes the days before it (the daily worker covers
      // organisations that write nothing).
      if (closedThrough.get(organisationId) !== today) {
        await closeChainHeads(db, organisationId, today);
        closedThrough.set(organisationId, today);
      }
      return 'written';
    });
  }

  return {
    organisations,
    async handle(message) {
      const log = deps.logger.child({ eventId: message.eventId, topic: 'audit.events' });
      let outcome: WriteOutcome;
      let organisationId: string | undefined;
      try {
        if (!isUuid(message.eventId)) throw new AppError('validation', 'the message has no event id', { code: 'audit.no_event_id' });
        const spec = outboxMessage('audit.events', message.name, message.version);
        if (!spec) throw new AppError('validation', 'the message is not in the outbox catalogue', { code: 'audit.message_unknown' });
        const envelope = decode({ bus: 'durable', topic: spec.topic, name: spec.name, version: spec.version, schema: envelopeOf(spec.schema) },
          message.data) as Envelope<typeof spec.schema>;
        organisationId = envelope.organisationId;
        if (spec === authEventMessage) outcome = await writeAuthEvent(envelope as Envelope<typeof authEventMessage.schema>, message.eventId);
        else if (spec === auditEventMessage) outcome = await writeAuditEvent(envelope as Envelope<typeof auditEventMessage.schema>, message.eventId);
        else throw new AppError('validation', 'the message is not an audit message', { code: 'audit.message_unknown' });
        organisations.add(envelope.organisationId);
        if (outcome === 'written') meter().lag.record(Date.now() - Date.parse(envelope.occurredAt), { message: spec.name });
      } catch (error) {
        if (!permanent(error)) throw error;
        outcome = 'rejected';
        log.failure('an audit event cannot be stored as it stands; acknowledged so the stream moves on', error, {
          event: 'audit.event_rejected', ...(organisationId ? { organisationId } : {}),
        });
      }
      meter().outcomes.add(1, { outcome, message: message.name });
      return outcome;
    },
  };
}
