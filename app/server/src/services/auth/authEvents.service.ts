// Auth events (spec 55.8) go to the outbox in the transaction that made the change, so an
// event exists exactly when its change committed. The outbox relay publishes them on
// audit.events and the audit service writes audit.auth_events. References only.

import { authEventMessage, type AuthEvent } from '../../contracts/audit/authEvent.contract.ts';
import type { Queryable } from '../../infra/postgres.infra.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export interface AuthEventInput {
  organisationId: string;
  correlationId: string;
  event: AuthEvent['event'];
  userId?: string | null;
  membershipId?: string | null;
  ipHash?: Buffer | undefined;
  detail?: AuthEvent['detail'];
}

/** Writes the event to the outbox. Call inside a transaction with the organisation's context. */
export async function recordAuthEvent(db: Queryable, input: AuthEventInput): Promise<void> {
  const payload = authEventMessage.schema.parse({
    event: input.event,
    userId: input.userId ?? null,
    membershipId: input.membershipId ?? null,
    ipHash: input.ipHash?.toString('hex') ?? null,
    detail: input.detail ?? {},
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: input.organisationId, topic: authEventMessage.topic, orderingKey: input.organisationId,
    event: authEventMessage.name, schemaVersion: authEventMessage.version, payload, correlationId: input.correlationId,
  });
}
