// The lineage writer (spec 59.3, 58.6): what every artefact-producing service calls, inside
// the transaction that creates the artefact, so the artefact cannot exist without its
// lineage and its inherited markings.
//
//   await writeLineage(db, { organisationId, createdBy }, {
//     artefact: { kind: 'view', refId: viewId, version: manifestHash },
//     inputs: [{ node: { kind: 'object_type_version', refId: typeId, version: typeVersionId }, relation: 'uses' }, ...],
//   });
//
// It records the artefact's node and every input node (nodes are immutable: an existing one
// is used, never changed), the input edges (an edge already recorded is not recorded
// twice), and the union of the inputs' markings on the artefact (spec 58.1: a superset of
// the union of markings on every input). An input's markings are its resource's direct
// markings, those stored on it, and any upstream marking still being propagated.
//
// A failure throws lineage.write_failed and the producer's transaction must abort with it.
// The producer then calls reportLineageWriteFailure, outside that transaction, so the
// failure is on the audit ledger (spec 59.7).

import { auditEventMessage } from '../../contracts/audit/auditEvent.contract.ts';
import { lineageWrite, type LineageWriteInput, type NodeRef } from '../../contracts/lineage/lineage.contract.ts';
import type { ServiceName } from '../../config/service.config.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import { artefactMarkingRepo, lineageEdgeRepo, lineageNodeRepo, type StoredMarking } from '../../repos/gov/index.repo.ts';
import { outboxRepo } from '../../repos/platform/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { markingsOfNodes } from './markings.service.ts';

export interface LineageActor {
  organisationId: string;
  /** Who created the artefact: a membership, a service principal, or neither for a platform service. */
  createdBy: { membershipId?: string | undefined; servicePrincipalId?: string | undefined };
}

export interface LineageWritten {
  nodeId: string;
  /** Every marking the artefact carries after the write. */
  markingIds: string[];
}

const nodeKey = (n: { kind: string; refId: string; version: string }): string => `${n.kind}\u0000${n.refId}\u0000${n.version}`;

/** Call inside the producer's transaction, with the organisation's context set. */
export async function writeLineage(db: Queryable, actor: LineageActor, input: LineageWriteInput): Promise<LineageWritten> {
  const parsed = lineageWrite.safeParse(input);
  if (!parsed.success) {
    throw new AppError('validation', 'the lineage write does not match its contract', {
      code: 'lineage.write_invalid', details: { issues: parsed.error.issues.length },
    });
  }
  const write = parsed.data;
  const { organisationId } = actor;
  try {
    const refs: NodeRef[] = [write.artefact, ...write.inputs.map((i) => i.node)];
    const nodes = await lineageNodeRepo.ensure(db, organisationId, refs, actor.createdBy);
    const byKey = new Map(nodes.map((n) => [nodeKey(n), n]));
    const idOf = (ref: NodeRef): string => {
      const found = byKey.get(nodeKey(ref));
      if (found === undefined) throw new AppError('internal', 'a lineage node was not recorded', { code: 'lineage.node_missing' });
      return found.id;
    };
    const artefactId = idOf(write.artefact);
    const inputIds = write.inputs.map((i) => ({ id: idOf(i.node), relation: i.relation }));
    await lineageEdgeRepo.insertMissing(db, organisationId, inputIds.map((i) => ({ from: i.id, to: artefactId, relation: i.relation })));

    // The union of the inputs' markings (spec 58.6), each from an input that carries it.
    const carried = await markingsOfNodes(db, organisationId, [...new Set(inputIds.map((i) => i.id))]);
    const stored: StoredMarking[] = write.directMarkings.map((markingId) => ({
      nodeId: artefactId, markingId, origin: 'direct' as const, inheritedFromNodeId: null,
    }));
    const seen = new Set(write.directMarkings);
    for (const { nodeId, markingId } of carried) {
      if (seen.has(markingId)) continue;
      seen.add(markingId);
      stored.push({ nodeId: artefactId, markingId, origin: 'inherited', inheritedFromNodeId: nodeId });
    }
    await artefactMarkingRepo.addMissing(db, organisationId, stored);
    const own = await markingsOfNodes(db, organisationId, [artefactId]);
    return { nodeId: artefactId, markingIds: [...new Set(own.map((m) => m.markingId))].sort() };
  } catch (error) {
    if (isAppError(error) && error.code === 'lineage.write_failed') throw error;
    throw new AppError('internal', 'the artefact\'s lineage could not be written, so the artefact is not created', {
      code: 'lineage.write_failed', cause: error,
    });
  }
}

/**
 * Records lineage_write_failed on the audit ledger, in its own transaction: the artefact's
 * transaction has aborted (spec 59.7). A failure to record it is the caller's to log.
 */
export async function reportLineageWriteFailure(pool: Parameters<typeof inTransaction>[0], actor: LineageActor, artefact: NodeRef, correlationId: string,
  producer: ServiceName): Promise<void> {
  const who = actor.createdBy.membershipId !== undefined ? { kind: 'membership' as const, membershipId: actor.createdBy.membershipId }
    : actor.createdBy.servicePrincipalId !== undefined ? { kind: 'service_principal' as const, servicePrincipalId: actor.createdBy.servicePrincipalId }
      : { kind: 'service' as const, service: producer };
  const payload = auditEventMessage.schema.parse({
    event: 'lineage_write_failed', actor: who, subjectMembershipId: null, scopeId: null,
    resource: { type: artefact.kind, id: artefact.refId }, purposeSessionId: null, operatorAccessSessionId: null, ipHash: null,
    detail: { producer },
  });
  await inTransaction(pool, { organisationId: actor.organisationId }, (db) => outboxRepo.insert(db, {
    id: uuidv7(), organisationId: actor.organisationId, topic: auditEventMessage.topic, orderingKey: actor.organisationId,
    event: auditEventMessage.name, schemaVersion: auditEventMessage.version, payload, correlationId,
  }));
}
