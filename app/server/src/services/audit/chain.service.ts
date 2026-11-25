// The organisation's hash chain over audit.audit_events, and its daily heads (spec 13.4,
// 63.1; design: audit.audit_events, audit.chain_heads; utils/auditChain.util.ts).
//
// Appending: under the organisation's chain lock, read the tip, compute the next link and
// insert it. The lock makes the chain single-writer whichever audit pod holds the message,
// so concurrent consumers cannot fork it.
//
// Daily heads: the head of a UTC day is the last link recorded before the day ended, with
// the number of links recorded that day. Each head is published as it is closed: inserted
// with published_at, and itself recorded in the chain as audit_chain_head_published, so the
// published hash is anchored in the chain it describes. Days are closed in order from the
// last head (or the first event), a bounded number per call.

import type { Queryable } from '../../infra/postgres.infra.ts';
import type { RetentionClass } from '../../contracts/audit/auditEvent.contract.ts';
import type { AuditEvent } from '../../models/audit/auditEvent.model.ts';
import { auditEventRepo, chainHeadRepo } from '../../repos/audit/index.repo.ts';
import { auditGenesisHash, auditRowHash, type ChainedAuditEvent } from '../../utils/auditChain.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';

export type ChainEntry = Omit<ChainedAuditEvent, 'chainSeq' | 'organisationId'> & { retentionClass: RetentionClass };

/** Appends one event to the organisation's chain. The caller holds the chain lock (lockChain). */
export async function appendToChain(db: Queryable, organisationId: string, entry: ChainEntry): Promise<AuditEvent> {
  const tip = await auditEventRepo.chainTip(db, organisationId);
  const prevHash = tip?.rowHash ?? auditGenesisHash(organisationId);
  const chainSeq = String((tip ? BigInt(tip.chainSeq) : 0n) + 1n);
  const event: ChainedAuditEvent = { ...entry, organisationId, chainSeq };
  const rowHash = auditRowHash(prevHash, event);
  return auditEventRepo.insertChained(db, {
    ...entry, organisationId, chainSeq, prevHash, rowHash, detail: entry.detail as AuditEvent['detail'],
  });
}

const DAY_MS = 86_400_000;
export const utcDate = (instant: number | string): string => new Date(instant).toISOString().slice(0, 10);
const nextDate = (date: string): string => utcDate(Date.parse(`${date}T00:00:00Z`) + DAY_MS);
const startOf = (date: string): string => `${date}T00:00:00.000Z`;

/**
 * Closes and publishes every unclosed day before `today` (UTC), up to maxDays of them.
 * Takes the chain lock itself. Returns the number of heads closed.
 */
export async function closeChainHeads(db: Queryable, organisationId: string, today: string, maxDays = 31): Promise<number> {
  await auditEventRepo.lockChain(db, organisationId);
  const latest = await chainHeadRepo.latest(db, organisationId);
  let day: string | undefined;
  if (latest) {
    day = nextDate(latest.headDate);
  } else {
    const first = await auditEventRepo.firstRecordedAt(db, organisationId);
    day = first === undefined ? undefined : utcDate(first);
  }
  let closed = 0;
  while (day !== undefined && day < today && closed < maxDays) {
    const end = startOf(nextDate(day));
    const tip = await auditEventRepo.tipRecordedBefore(db, organisationId, end);
    if (tip) {
      const eventCount = await auditEventRepo.countRecorded(db, organisationId, startOf(day), end);
      const now = new Date().toISOString();
      const head = await chainHeadRepo.insert(db, {
        id: uuidv7(), organisationId, headDate: day, lastChainSeq: tip.chainSeq, headHash: tip.rowHash,
        eventCount: String(eventCount), publishedAt: now,
      });
      await appendToChain(db, organisationId, {
        sourceEventId: head.id, occurredAt: now, retentionClass: 'standard', event: 'audit_chain_head_published',
        membershipId: null, servicePrincipalId: null, operatorId: null, systemService: 'audit', subjectMembershipId: null,
        scopeId: null, resourceType: null, resourceId: null, purposeSessionId: null, operatorAccessSessionId: null,
        correlationId: uuidv7(), ipHash: null,
        detail: { head_date: day, last_chain_seq: tip.chainSeq, event_count: eventCount, head_hash: tip.rowHash.toString('hex') },
      });
      closed += 1;
    }
    day = nextDate(day);
  }
  return closed;
}
