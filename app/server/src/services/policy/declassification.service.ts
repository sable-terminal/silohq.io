// Declassification (spec 58.9): the governed removal of a direct marking. See
// contracts/policy/declassification.contract.ts.
//
// A declassification is its own Action record (gov.marking_declassifications; action_id is
// its own id): it changes Silo's governance state, not a source record, so it has no
// action.mutations row. It is approved through an approval chain of its own subject kind,
// written here with the request (as a purge's is), decided by approvals, and executed here
// when approvals reports the chain approved.
//
// The lineage node it names is the resource's latest node (one is recorded if the resource
// has none yet), and the downstream walk starts from every version of it: a direct marking
// is read through the resource, so every version carried it.
//
// Readers gaining access are counted from clearances: active members who hold a clearance
// for every other marking on the resource and none for this one. A purpose marking is
// satisfied only inside a purpose session, so no member is counted as satisfying it.

import { canonicalJsonBytes } from '../../utils/canonicalJson.util.ts';
import type { ChainCondition } from '../../contracts/approvals/approval.contract.ts';
import type { NodeKind } from '../../contracts/lineage/lineage.contract.ts';
import type { DeclassificationView } from '../../contracts/policy/declassification.contract.ts';
import type { Markable } from '../../contracts/policy/governance.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { MarkingDeclassification } from '../../models/gov/markingDeclassification.model.ts';
import { approvalChainRepo, approvalStepRepo } from '../../repos/action/index.repo.ts';
import {
  artefactMarkingRepo, clearanceRepo, lineageNodeRepo, markingDeclassificationRepo, markingRepo, resourceMarkingRepo,
} from '../../repos/gov/index.repo.ts';
import { membershipRepo, objectTypeMarkingRepo } from '../../repos/iam/index.repo.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { storedConditions } from '../approvals/snapshot.service.ts';
import { PROPAGATION_DEPTH } from '../lineage/markings.service.ts';
import { auditActorOf, contextOf, may, membershipOf, recordPolicyEvent, requireActor, type AdminDeps } from './deps.service.ts';
import { declassificationDecision } from './governance.service.ts';
import { markingsByResource, type Subject } from './policy.service.ts';

/** A chain no one decides within this ends, and the request with it. */
const EXPIRY_HOURS = 72;
/** The downstream walk refuses past this many nodes rather than leave part of it undone. */
const MAX_DOWNSTREAM = 10_000;
const CONDITION = 'declassification';

/** The lineage node kind of each markable resource. An interface has no node of its own. */
const NODE_KIND: Partial<Record<Markable, NodeKind>> = {
  connection: 'connection', property: 'property', object_type: 'object_type_version', link_type: 'link_type_version',
  action_type: 'action_type_version', function: 'function_version', silo: 'silo', view: 'view', app: 'app_version',
  property_mapping: 'source_field',
};

const notFound = (): AppError => new AppError('not_found', 'no such declassification', { code: 'declassification.not_found' });

const tx = <T>(deps: AdminDeps, subject: Subject, work: (db: Queryable) => Promise<T>, readOnly = false): Promise<T> =>
  inTransaction(deps.databases.pool('control'), contextOf(subject.actor), work, { readOnly });

const refusal = (reason: string): AppError => {
  const messages: Record<string, string> = {
    principal_never_authorises: 'a service principal never requests or approves a declassification',
    not_granted: 'you need marking.declassify for this marking',
    marking_unsatisfied: 'you must satisfy the marking yourself',
    self_approval: 'you requested it; another person must approve it',
  };
  return new AppError('forbidden', messages[reason] ?? 'this request is not authorised', { code: `declassification.${reason}` });
};

interface Snapshot { markingId: string; downstreamLosing: number; markingsBefore: string[] }

function statusOf(row: MarkingDeclassification, chainStatus: string): DeclassificationView['status'] {
  if (row.revertedAt !== null) return 'reverted';
  if (row.executedAt !== null) return 'executed';
  if (chainStatus === 'pending') return 'awaiting_approval';
  return chainStatus as 'approved' | 'rejected' | 'expired';
}

async function viewOf(db: Queryable, row: MarkingDeclassification): Promise<DeclassificationView> {
  const chain = (await approvalChainRepo.findById(db, row.approvalChainId!))!;
  const snapshot = chain.policySnapshot as unknown as Snapshot;
  return {
    id: row.id, markingId: row.markingId, resource: { type: row.resourceType as Markable, id: row.resourceId }, applyDownstream: row.applyDownstream,
    justification: row.justification, requestedBy: row.requestedBy, status: statusOf(row, chain.status),
    preview: {
      markingsBefore: snapshot.markingsBefore, markingsAfter: snapshot.markingsBefore.filter((m) => m !== row.markingId),
      readersGainingAccess: row.readersGainingAccessCount ?? 0, downstreamLosing: snapshot.downstreamLosing,
    },
    approvalChainId: chain.id, diffHash: chain.diffHash!.toString('hex'), createdAt: row.createdAt, executedAt: row.executedAt, revertedAt: row.revertedAt,
  };
}

/** Members who satisfy every other marking on the resource and not this one. */
async function readersGaining(db: Queryable, markingId: string, markings: readonly string[]): Promise<number> {
  const members = await membershipRepo.activeIds(db);
  const now = Date.now();
  const cleared = new Map<string, Set<string>>();
  for (const c of await clearanceRepo.list(db, {})) {
    if (c.membershipId === null || c.revokedAt !== null || (c.expiresAt !== null && Date.parse(c.expiresAt) <= now)) continue;
    cleared.set(c.membershipId, (cleared.get(c.membershipId) ?? new Set()).add(c.markingId));
  }
  const others = markings.filter((m) => m !== markingId);
  return members.filter((m) => {
    const held = cleared.get(m) ?? new Set<string>();
    return !held.has(markingId) && others.every((o) => held.has(o));
  }).length;
}

/**
 * The downstream artefacts that lose the inherited marking: walked nearest first, each
 * keeping it while any of its inputs still carries it. With dryRun nothing is written, the
 * roots are taken as no longer carrying it directly, and removals so far are remembered.
 */
async function downstream(db: Queryable, organisationId: string, roots: readonly string[], markingId: string,
  write: { declassificationId: string } | undefined): Promise<string[]> {
  if (roots.length === 0) return [];
  const walk = await lineageNodeRepo.traverse(db, organisationId, roots, 'downstream', PROPAGATION_DEPTH, MAX_DOWNSTREAM);
  if (walk.overNodes) {
    throw new AppError('validation', `more than ${MAX_DOWNSTREAM} artefacts lie downstream: declassify without applying downstream, or narrow it`,
      { code: 'declassification.downstream_too_wide' });
  }
  const rootSet = new Set(roots);
  const removed = new Set<string>();
  const carries = async (ids: readonly string[]): Promise<boolean> => (await lineageNodeRepo.markings(db, organisationId, ids)).some((m) => m.markingId === markingId
    && !(write === undefined && m.origin === 'direct' && rootSet.has(m.nodeId)) && !(m.origin === 'inherited' && removed.has(m.nodeId)));
  for (const node of walk.nodes.filter((n) => n.depth > 0)) {
    const own = (await lineageNodeRepo.markings(db, organisationId, [node.nodeId])).filter((m) => m.markingId === markingId);
    if (!own.some((m) => m.origin === 'inherited') || own.some((m) => m.origin === 'direct')) continue;
    const inputs = (await lineageNodeRepo.traverse(db, organisationId, [node.nodeId], 'upstream', 1, 10_000)).nodes
      .filter((n) => n.depth === 1).map((n) => n.nodeId);
    if (await carries(inputs)) continue;
    removed.add(node.nodeId);
    if (write !== undefined) await artefactMarkingRepo.removeLive(db, organisationId, node.nodeId, markingId, write.declassificationId);
  }
  return [...removed];
}

/** The resource's node versions (the walk's roots), and the node the record names: its latest, recorded if there is none yet. */
async function nodesOf(db: Queryable, subject: Subject, type: Markable, id: string): Promise<{ named: string; roots: string[] }> {
  const kind = NODE_KIND[type];
  if (kind === undefined) {
    throw new AppError('validation', `a marking on ${type.replace('_', ' ')} is not declassified through lineage`, { code: 'declassification.unsupported_resource' });
  }
  const organisationId = subject.actor.organisationId;
  const versions = await lineageNodeRepo.findVersions(db, organisationId, kind, id, 1_000);
  if (versions.length > 0) return { named: versions[0]!.id, roots: versions.map((v) => v.id) };
  const [node] = await lineageNodeRepo.ensure(db, organisationId, [{ kind, refId: id, version: '1' }], { membershipId: membershipOf(subject) });
  return { named: node!.id, roots: [node!.id] };
}

export async function requestDeclassification(deps: AdminDeps, ctx: HandlerContext, input: {
  markingId: string; resource: { type: Markable; id: string }; justification: string; applyDownstream: boolean;
}): Promise<DeclassificationView> {
  const reason = await declassificationDecision(deps, ctx, { markingId: input.markingId, step: 'request' });
  if (reason !== 'allowed') throw refusal(reason);
  const subject = await requireActor(deps, ctx);
  const requester = membershipOf(subject);
  const organisationId = subject.actor.organisationId;
  return tx(deps, subject, async (db) => {
    const marking = await markingRepo.findById(db, input.markingId);
    if (!marking) throw new AppError('not_found', 'no such marking', { code: 'marking.not_found' });
    const markings = (await markingsByResource(db, input.resource.type, [input.resource.id])).get(input.resource.id) ?? [];
    if (!markings.includes(input.markingId)) {
      throw new AppError('validation', 'the resource does not carry that marking directly', { code: 'declassification.not_marked' });
    }
    const { named, roots } = await nodesOf(db, subject, input.resource.type, input.resource.id);
    const losing = input.applyDownstream ? (await downstream(db, organisationId, roots, input.markingId, undefined)).length : 0;
    const gaining = await readersGaining(db, input.markingId, markings);
    const id = uuidv7();
    const chainId = uuidv7();
    const now = new Date();
    const document = {
      id, markingId: input.markingId, resource: input.resource, applyDownstream: input.applyDownstream, justification: input.justification,
      readersGainingAccess: gaining, downstreamLosing: losing, markingsBefore: [...markings].sort(),
    };
    await markingDeclassificationRepo.insert(db, {
      id, organisationId, actionId: id, lineageNodeId: named, markingId: input.markingId, resourceType: input.resource.type, resourceId: input.resource.id,
      applyDownstream: input.applyDownstream, justification: input.justification, readersGainingAccessCount: gaining, requestedBy: requester,
    });
    // At least one approver other than the requester who satisfies the marking; never self-approval (58.9).
    const condition: ChainCondition = {
      id: CONDITION, count: 1, qualification: 'marking_holder', qualifyingRoleId: null, requiresAdmin: false, selfApprovalPermitted: false,
      connectionIds: [], sources: ['declassification'], markingIds: [input.markingId],
    };
    await approvalChainRepo.insert(db, {
      id: chainId, organisationId, subjectKind: 'declassification', declassificationId: id, requesterMembershipId: requester,
      policySnapshot: {
        conditions: storedConditions([condition]), sequential: false, subject: 'declassification', markingId: input.markingId,
        downstreamLosing: losing, markingsBefore: document.markingsBefore,
      } as never,
      diffHash: sha256(canonicalJsonBytes(document)), approvalsRequired: 1, status: 'pending',
      expiresAt: new Date(now.getTime() + EXPIRY_HOURS * 3_600_000).toISOString(),
    });
    await approvalStepRepo.insert(db, { id: uuidv7(), organisationId, chainId, sequence: null, qualifyingRule: CONDITION, offeredAt: now.toISOString() });
    const updated = (await markingDeclassificationRepo.update(db, id, { approvalChainId: chainId }))!;
    await recordPolicyEvent(db, {
      organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor), event: 'marking_declassification_requested',
      resource: { type: input.resource.type, id: input.resource.id },
      detail: { declassification_id: id, marking_id: input.markingId, apply_downstream: input.applyDownstream, readers_gaining_access: gaining, downstream_losing: losing },
    });
    return viewOf(db, updated);
  });
}

/** Who sees a declassification: its requester, a holder of marking.declassify, or anyone satisfying the marking (who could approve it). */
async function visibleTo(deps: AdminDeps, subject: Subject): Promise<(row: MarkingDeclassification) => boolean> {
  const declassifier = await may(deps, subject, 'marking.declassify', { organisationWide: true });
  return (row) => declassifier || row.requestedBy === subject.actor.membershipId || subject.satisfied.has(row.markingId);
}

export async function getDeclassification(deps: AdminDeps, ctx: HandlerContext, id: string): Promise<DeclassificationView> {
  const subject = await requireActor(deps, ctx);
  const visible = await visibleTo(deps, subject);
  return tx(deps, subject, async (db) => {
    const row = await markingDeclassificationRepo.findById(db, id);
    if (!row || !visible(row)) throw notFound();
    return viewOf(db, row);
  }, true);
}

export async function listDeclassifications(deps: AdminDeps, ctx: HandlerContext, limit: number): Promise<DeclassificationView[]> {
  const subject = await requireActor(deps, ctx);
  const visible = await visibleTo(deps, subject);
  return tx(deps, subject, async (db) => Promise.all((await markingDeclassificationRepo.latest(db, limit)).filter(visible).map((row) => viewOf(db, row))), true);
}

/** Once the chain is approved: the marking leaves the resource and, applied downstream, the artefacts that only inherited it. */
export async function executeDeclassification(deps: AdminDeps, ctx: HandlerContext, id: string): Promise<DeclassificationView> {
  const subject = await requireActor(deps, ctx);
  return tx(deps, subject, async (db) => {
    const row = await markingDeclassificationRepo.findById(db, id);
    if (!row) throw notFound();
    if (row.executedAt !== null) return viewOf(db, row);
    const chain = await approvalChainRepo.findById(db, row.approvalChainId!);
    if (chain?.status !== 'approved') {
      throw new AppError('conflict', `the declassification's approval is ${chain?.status ?? 'missing'}`, { code: 'declassification.not_approved' });
    }
    const organisationId = subject.actor.organisationId;
    const type = row.resourceType as Markable;
    if (type === 'object_type') await objectTypeMarkingRepo.remove(db, { organisationId, objectTypeId: row.resourceId, markingId: row.markingId });
    else {
      const direct = (await resourceMarkingRepo.listFor(db, type, row.resourceId)).find((m) => m.markingId === row.markingId);
      if (direct !== undefined) await resourceMarkingRepo.remove(db, direct.id);
    }
    const removed = row.applyDownstream
      ? await downstream(db, organisationId, (await nodesOf(db, subject, type, row.resourceId)).roots, row.markingId, { declassificationId: row.id })
      : [];
    const executed = (await markingDeclassificationRepo.update(db, row.id, { executedAt: new Date().toISOString() }))!;
    await recordPolicyEvent(db, {
      organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor), event: 'marking_declassified',
      resource: { type, id: row.resourceId },
      detail: { declassification_id: row.id, marking_id: row.markingId, downstream_removed: removed.length, approval_chain_id: chain.id },
    });
    return viewOf(db, executed);
  });
}

/** Puts back the direct marking and every inherited marking this declassification removed. */
export async function revertDeclassification(deps: AdminDeps, ctx: HandlerContext, id: string): Promise<DeclassificationView> {
  const subject = await requireActor(deps, ctx);
  const loaded = await tx(deps, subject, (db) => markingDeclassificationRepo.findById(db, id), true);
  if (!loaded) throw notFound();
  const reason = await declassificationDecision(deps, ctx, { markingId: loaded.markingId, step: 'request' });
  if (reason !== 'allowed') throw refusal(reason);
  const organisationId = subject.actor.organisationId;
  return tx(deps, subject, async (db) => {
    const row = (await markingDeclassificationRepo.findById(db, id))!;
    if (row.executedAt === null) throw new AppError('conflict', 'only an executed declassification is reverted', { code: 'declassification.not_executed' });
    if (row.revertedAt !== null) return viewOf(db, row);
    const type = row.resourceType as Markable;
    const actor = membershipOf(subject);
    const present = (await markingsByResource(db, type, [row.resourceId])).get(row.resourceId) ?? [];
    if (!present.includes(row.markingId)) {
      if (type === 'object_type') await objectTypeMarkingRepo.insert(db, { organisationId, objectTypeId: row.resourceId, markingId: row.markingId, appliedBy: actor });
      else {
        const column = `${type.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())}Id`;
        await resourceMarkingRepo.insert(db, { id: uuidv7(), organisationId, markingId: row.markingId, appliedBy: actor, [column]: row.resourceId } as never);
      }
    }
    const restored = await artefactMarkingRepo.removedBy(db, organisationId, row.id);
    await artefactMarkingRepo.addMissing(db, organisationId, restored);
    const reverted = (await markingDeclassificationRepo.update(db, row.id, { revertedAt: new Date().toISOString() }))!;
    await recordPolicyEvent(db, {
      organisationId, correlationId: ctx.correlationId, actor: auditActorOf(subject.actor), event: 'marking_declassification_reverted',
      resource: { type, id: row.resourceId }, detail: { declassification_id: row.id, marking_id: row.markingId, downstream_restored: restored.length },
    });
    return viewOf(db, reverted);
  });
}
