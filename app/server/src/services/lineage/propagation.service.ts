// Propagation of a marking added upstream (spec 58.6): "When a marking is later added
// upstream, the lineage service adds it downstream in bounded batches, and until that walk
// completes the policy service also evaluates the upstream marking at read time, so there
// is no window of exposure."
//
// A direct marking applied to a resource requests a propagation in the same transaction (a
// trigger on gov.resource_markings and iam.object_type_markings). Each round:
// - a request is claimed with a row lock, so two replicas never walk the same one at once;
// - batches mark the nearest unmarked nodes downstream, nearest first, each inheriting from
//   its nearest upstream node, one transaction per batch;
// - when a walk finds nothing left, the first pass is recorded; after a grace period a
//   second walk catches artefacts whose transactions were open while the first ran, and
//   then the request completes and marking_propagated is audited;
// - a source that no longer carries the marking (declassified meanwhile) completes at once;
// - a walk cut short by the depth bound stays pending, so policy keeps evaluating it at read
//   time, and alerts.

import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import type { Logger } from '../../infra/logger.infra.ts';
import { inTransaction, type Databases, type Queryable } from '../../infra/postgres.infra.ts';
import type { MarkingPropagation } from '../../models/gov/index.model.ts';
import { markingPropagationRepo } from '../../repos/gov/index.repo.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { PROPAGATION_DEPTH, propagateBatch } from './markings.service.ts';

export interface PropagationOptions {
  /** Nodes marked per transaction. */
  batch: number;
  /** Batches per request per round, so one large walk does not starve the others. */
  batchesPerRound: number;
  /** Requests taken per round. */
  requests: number;
  /** The wait between the first complete pass and the confirming one. */
  graceMs: number;
}

export const DEFAULT_PROPAGATION: PropagationOptions = { batch: 500, batchesPerRound: 20, requests: 20, graceMs: 60_000 };

type Step = 'skipped' | 'more' | 'first_pass' | 'waiting' | 'completed' | 'stuck';

async function audit(db: Queryable, p: MarkingPropagation, nodesMarked: number, correlationId: string): Promise<void> {
  const payload = auditEventMessage.schema.parse({
    event: 'marking_propagated', actor: { kind: 'service', service: 'lineage' }, subjectMembershipId: null, scopeId: null,
    resource: { type: 'marking', id: p.markingId }, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null,
    detail: { source_kind: p.sourceKind, source_id: p.sourceRefId, nodes_marked: nodesMarked },
  });
  await outboxRepo.insert(db, {
    id: uuidv7(), organisationId: p.organisationId, topic: auditEventMessage.topic, orderingKey: p.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  });
}

/** One batch of one request, in its own transaction. */
async function step(databases: Databases, organisationId: string, id: string, options: PropagationOptions): Promise<Step> {
  return inTransaction(databases.pool('control'), { organisationId }, async (db): Promise<Step> => {
    const p = await markingPropagationRepo.claim(db, id);
    if (p === undefined) return 'skipped';
    if (!await markingPropagationRepo.sourceStillMarked(db, p)) {
      await markingPropagationRepo.progress(db, id, { added: 0, firstPassAt: true, completedAt: true, refusedReason: 'source_unmarked' });
      return 'completed';
    }
    const batch = await propagateBatch(db, p, options.batch);
    if (!batch.done) {
      await markingPropagationRepo.progress(db, id, { added: batch.added });
      return 'more';
    }
    if (await markingPropagationRepo.beyondDepth(db, p, PROPAGATION_DEPTH)) {
      await markingPropagationRepo.progress(db, id, { added: batch.added, firstPassAt: true, refusedReason: 'depth_bound' });
      return 'stuck';
    }
    if (p.firstPassAt === null) {
      await markingPropagationRepo.progress(db, id, { added: batch.added, firstPassAt: true });
      return 'first_pass';
    }
    if (Date.now() - Date.parse(p.firstPassAt) < options.graceMs) {
      await markingPropagationRepo.progress(db, id, { added: batch.added });
      return 'waiting';
    }
    await markingPropagationRepo.progress(db, id, { added: batch.added, completedAt: true });
    await audit(db, p, p.nodesMarked + batch.added, uuidv7());
    return 'completed';
  });
}

/** One round over the queue. Returns how many requests completed. */
export async function propagationRound(databases: Databases, logger: Logger, options: PropagationOptions): Promise<number> {
  const queue = await inTransaction(databases.pool('control'), {}, (db) => markingPropagationRepo.queue(db, options.requests), { readOnly: true });
  let completed = 0;
  for (const { organisationId, id } of queue) {
    try {
      for (let i = 0; i < options.batchesPerRound; i += 1) {
        const outcome = await step(databases, organisationId, id, options);
        if (outcome === 'completed') completed += 1;
        if (outcome === 'stuck') {
          logger.failure('a marking propagation is deeper than its bound; policy keeps evaluating it at read time', undefined, {
            event: 'lineage.propagation_depth_bound', organisationId, resourceId: id,
          });
        }
        if (outcome !== 'more') break;
      }
    } catch (error) {
      logger.failure('a marking propagation batch failed; the next round retries', error, { event: 'lineage.propagation_failed', organisationId });
    }
  }
  return completed;
}
