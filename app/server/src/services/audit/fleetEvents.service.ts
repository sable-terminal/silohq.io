// Fleet's events about this single-tenant cell into its customers' audit logs (spec 11.6;
// contracts/audit/fleetEvents.contract.ts): each copied event becomes an audit event of the same
// name in every customer organisation's log, its actor fleet-control, its detail Fleet's sequence,
// the release, the rollout and the channel, and what Fleet's own detail said (flat, bounded). Once
// by sequence: the definer function refuses a sequence copied before.

import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import { COPIED_FLEET_EVENTS } from '../../contracts/audit/fleetEvents.contract.ts';
import type { fleetEventView } from '../../contracts/fleet-control/events.contract.ts';
import { inTransaction, type Databases } from '../../infra/postgres.infra.ts';
import { auditEventRepo } from '../../repos/audit/index.repo.ts';
import { organisationRepo } from '../../repos/iam/index.repo.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import type { z } from 'zod';

type FleetEvent = z.infer<typeof fleetEventView>;

const KEY = /^[a-z][a-z0-9_]{0,62}$/;

export async function recordFleetEvents(deps: { databases: Databases }, events: readonly FleetEvent[], correlationId: string): Promise<{ copied: number; skipped: number }> {
  const pool = deps.databases.pool('control');
  let copied = 0;
  let skipped = 0;
  for (const e of events) {
    if (!(COPIED_FLEET_EVENTS as readonly string[]).includes(e.event)) {
      skipped += 1;
      continue;
    }
    const own = Object.fromEntries(Object.entries(e.detail).filter(([key]) => KEY.test(key) && !key.startsWith('fleet_'))
      .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 200) : value]));
    const payload = auditEventMessage.schema.parse({
      event: e.event, actor: { kind: 'service', service: 'fleet-control' }, subjectMembershipId: null, scopeId: null, resource: null,
      purposeSessionId: null, operatorAccessSessionId: null, ipHash: null,
      detail: { ...own, fleet_seq: e.seq, release_id: e.releaseId, rollout_id: e.rolloutId, channel: e.channel, occurred_at: e.occurredAt },
    });
    const logs = await inTransaction(pool, {}, (db) => auditEventRepo.copyFleetEvent(db, {
      seq: e.seq, event: e.event, schemaVersion: auditEventMessage.version, topic: auditEventMessage.topic, payload, correlationId,
    }));
    if (logs > 0) copied += 1;
    else skipped += 1;
  }
  return { copied, skipped };
}

/** Status incidents naming this cell into its customers' logs, once each by notice and event (13.5; D209). */
export async function recordIncidentEvents(deps: { databases: Databases },
  events: readonly { noticeId: string; event: 'incident_declared' | 'incident_resolved'; occurredAt: string; severity: string | null; components: string[] }[],
  correlationId: string): Promise<{ copied: number; skipped: number }> {
  const pool = deps.databases.pool('control');
  let copied = 0;
  let skipped = 0;
  for (const e of events) {
    const payload = auditEventMessage.schema.parse({
      event: e.event, actor: { kind: 'service', service: 'fleet-control' }, subjectMembershipId: null, scopeId: null, resource: { type: 'status_notice', id: e.noticeId },
      purposeSessionId: null, operatorAccessSessionId: null, ipHash: null,
      detail: { severity: e.severity, components: e.components.join(',').slice(0, 200), occurred_at: e.occurredAt },
    });
    const logs = await inTransaction(pool, {}, (db) => auditEventRepo.copyIncidentEvent(db, {
      noticeId: e.noticeId, event: e.event, schemaVersion: auditEventMessage.version, topic: auditEventMessage.topic, payload, correlationId,
    }));
    if (logs > 0) copied += 1;
    else skipped += 1;
  }
  return { copied, skipped };
}

/** redaction_violation_detected into each named organisation's log, where this cell holds it (13.1, 13.5; D209). */
export async function recordRedactionViolations(deps: { databases: Databases },
  violations: readonly { organisationId: string; services: string[]; lines: number; kinds: string[] }[], correlationId: string): Promise<{ recorded: number }> {
  const pool = deps.databases.pool('control');
  let recorded = 0;
  for (const v of violations) {
    const payload = auditEventMessage.schema.parse({
      event: 'redaction_violation_detected', actor: { kind: 'service', service: 'fleet-control' }, subjectMembershipId: null, scopeId: null,
      resource: { type: 'organisation', id: v.organisationId }, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null,
      detail: { services: v.services.join(',').slice(0, 200), lines: v.lines, kinds: v.kinds.join(',').slice(0, 200) },
    });
    const written = await inTransaction(pool, { organisationId: v.organisationId }, async (db) => {
      if (await organisationRepo.findById(db, v.organisationId) === undefined) return false;
      await outboxRepo.insert(db, {
        id: uuidv7(), organisationId: v.organisationId, topic: auditEventMessage.topic, orderingKey: v.organisationId, event: auditEventMessage.name,
        schemaVersion: auditEventMessage.version, payload, correlationId,
      });
      return true;
    });
    if (written) recorded += 1;
  }
  return { recorded };
}
