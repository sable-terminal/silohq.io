// Approval chains (spec 44.3 to 44.7; contracts/approvals/approval.contract.ts).
//
// Requested by actions (and revert) when a mutation is previewed: the policies are resolved
// and the resolution written into the chain as its snapshot, so a policy changed later
// never alters a pending approval (44.5). The mutation waits in awaiting_approval.
//
// A Cron's mutation (43.11) is requested by the Cron's principal; its authorising member
// stands as the requester (self-approval rules apply to them). In execute within bounds, the
// authorisation they gave is the approval: the chain is approved with no steps, its snapshot
// naming the authorisation, and the mutation runs at once.
//
// A decision is recorded by a member (a service principal never approves) who:
// - holds mutation.approve at the owning scope of every connection the chain covers;
// - may read every field the diff writes (a person cannot approve a value they may not see);
// - approves the diff whose hash they were shown (43.8);
// - meets the qualification of an open slot: scope_admin or requires_admin is scope.manage
//   at the connection's owning scope; role and named_role hold the role; marking_holder is
//   cleared for the touched markings its condition names (58.5: clearance, or a purpose
//   session of the request).
// The markings a mutation touches (those its receipt inherits, 58.6) are read when the chain
// is requested and kept in its snapshot: on the Action type, the object type, the properties
// it writes (the proposal records them) and the connections it writes through.
// The approver takes the strictest open slot they meet, so their standing is used where it is
// needed. Self-approval only where the slot's condition permits it (the database records it
// and refuses it for physical Actions). One rejection rejects the chain and the mutation. A
// chain whose time has passed expires when next touched, discarding the mutation.
// The final approval approves the mutation and, where execution is not separated, runs it.

import { purgeRequestRepo } from '../../repos/siloes/index.repo.ts';
import { declassificationDecision } from '../../contracts/policy/decision.contract.ts';
import { executeDeclassification } from '../../contracts/policy/declassification.contract.ts';
import { executeMutation } from '../../contracts/actions/mutation.contract.ts';
import type { ChainCondition, ChainView } from '../../contracts/approvals/approval.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { ApprovalChain } from '../../models/action/approvalChain.model.ts';
import type { ApprovalPolicy } from '../../models/action/approvalPolicy.model.ts';
import {
  actionTypeVersionRepo, approvalChainConnectionRepo, approvalChainRepo, approvalPolicyRepo, approvalStepRepo, mutationRepo, mutationTargetRepo,
  policyFloorRepo,
} from '../../repos/action/index.repo.ts';
import { resourceMarkingRepo } from '../../repos/gov/index.repo.ts';
import { objectTypeMarkingRepo, roleAssignmentRepo } from '../../repos/iam/index.repo.ts';
import { AppError, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import {
  accessOf, callOptions, clearedFor, memberOf, permitted, readConnections, type Context, type WriteBackDeps,
} from '../actions/deps.service.ts';
import { recordActionEvent, recordMutationStage } from '../actions/events.service.ts';
import { allocateSlots, resolvePolicies, strictness, type PolicyRow } from './resolution.service.ts';
import { readConditions, storedConditions } from './snapshot.service.ts';

const policyRow = (p: ApprovalPolicy): PolicyRow => ({
  id: p.id, connectionId: p.connectionId, scopeId: p.scopeId, approvalsRequired: p.approvalsRequired, approverQualification: p.approverQualification,
  qualifyingRoleId: p.qualifyingRoleId, requiresAdmin: p.requiresAdmin, selfApprovalPermitted: p.selfApprovalPermitted, sequential: p.sequential,
  rowThreshold: p.rowThreshold, riskClassCondition: p.riskClassCondition, markingCondition: p.markingCondition, expiryHours: p.expiryHours,
});

interface Snapshot {
  /** As stored: snake_case keys (snapshot.service.ts). */
  conditions: unknown;
  sequential?: boolean;
}

async function chainView(db: Queryable, chain: ApprovalChain): Promise<ChainView> {
  const snapshot = chain.policySnapshot as unknown as Snapshot;
  const steps = await approvalStepRepo.listByChain(db, chain.id);
  const subjectId = (chain.mutationId ?? chain.purgeRequestId ?? chain.discoveryAuthorisationId ?? chain.declassificationId ?? chain.receiptPurgeId)!;
  const siloId = chain.purgeRequestId === null ? null : (await purgeRequestRepo.findById(db, chain.purgeRequestId))?.siloId ?? null;
  return {
    id: chain.id, subjectKind: chain.subjectKind, subject: { kind: chain.subjectKind, id: subjectId, siloId }, mutationId: chain.mutationId, requesterMembershipId: chain.requesterMembershipId,
    riskClass: chain.riskClass, status: chain.status, approvalsRequired: chain.approvalsRequired, approvalsReceived: chain.approvalsReceived,
    sequential: snapshot.sequential === true, floorOverrodePolicy: chain.floorOverrodePolicy, expiresAt: chain.expiresAt, createdAt: chain.createdAt,
    conditions: readConditions(snapshot.conditions),
    steps: steps.map((s) => ({
      id: s.id, sequence: s.sequence, qualifyingRule: s.qualifyingRule, offered: s.offeredAt !== null, approverMembershipId: s.approverMembershipId,
      decision: s.decision, selfApproval: s.selfApproval, decidedAt: s.decidedAt,
    })),
  };
}

/** The rows the bulk guardrails count: for a promotion, everything promoted together (39.8), never fewer than its own. */
function guardrailRows(mutation: { rowCount: number; origin: string; manifest: unknown }): number {
  const together = (mutation.manifest as { promotion?: { rowsTogether?: unknown } } | null)?.promotion?.rowsTogether;
  return mutation.origin === 'scenario_promotion' && typeof together === 'number' ? Math.max(mutation.rowCount, together) : mutation.rowCount;
}

export function createChains(deps: WriteBackDeps) {
  const control = deps.databases.pool('control');

  /** A pending chain past its time expires now, and its mutation with it. Returns whether it did. */
  async function expireIfDue(ctx: Context, chainId: string): Promise<boolean> {
    return inTransaction(control, ctx.request, async (db) => {
      const chain = await approvalChainRepo.findForUpdate(db, chainId);
      if (!chain || chain.status !== 'pending' || Date.parse(chain.expiresAt) > Date.now()) return false;
      const now = new Date().toISOString();
      await approvalChainRepo.update(db, chain.id, { status: 'expired', closedAt: now });
      if (chain.mutationId !== null) {
        const mutation = await mutationRepo.findById(db, chain.mutationId);
        if (mutation?.status === 'awaiting_approval') await mutationRepo.update(db, mutation.id, { status: 'expired', completedAt: now });
        await recordMutationStage(db, { organisationId: chain.organisationId, correlationId: ctx.correlationId, mutationId: chain.mutationId, stage: 'expired', rowCount: mutation?.rowCount ?? 0 });
      }
      await recordActionEvent(db, {
        organisationId: chain.organisationId, correlationId: ctx.correlationId, event: 'approval_expired', service: 'approvals',
        resource: { type: 'approval_chain', id: chain.id }, detail: { mutation_id: chain.mutationId },
      });
      return true;
    });
  }

  async function view(ctx: Context, chainId: string): Promise<ChainView> {
    await expireIfDue(ctx, chainId);
    return inTransaction(control, ctx.request, async (db) => {
      const chain = await approvalChainRepo.findById(db, chainId);
      if (!chain) throw new AppError('not_found', 'no such approval chain', { code: 'approval.not_found' });
      return chainView(db, chain);
    }, { readOnly: true });
  }

  async function execute(ctx: Context, mutationId: string): Promise<void> {
    await deps.services.call(executeMutation, { params: { mutationId } }, callOptions(ctx));
  }

  type Loaded = Awaited<ReturnType<typeof loadChain>>;

  async function loadChain(ctx: Context, chainId: string) {
    return inTransaction(control, ctx.request, async (db) => {
      const chain = await approvalChainRepo.findById(db, chainId);
      if (!chain) throw new AppError('not_found', 'no such approval chain', { code: 'approval.not_found' });
      return {
        chain, steps: await approvalStepRepo.listByChain(db, chainId), connectionIds: await approvalChainConnectionRepo.listByChain(db, chainId),
        mutation: chain.mutationId === null ? undefined : await mutationRepo.findById(db, chain.mutationId),
      };
    }, { readOnly: true });
  }

  /**
   * The open step this member may decide on (spec 44: qualification, separation of duties,
   * the subject's own rule, the connections' permission and every field of the diff readable),
   * or the refusal saying why not. Run by decide, and by the inbox to list only what waits for
   * the member.
   */
  async function slotFor(ctx: Context, loaded: Loaded, membershipId: string, decision: 'approved' | 'rejected') {
    const { chain, steps, connectionIds, mutation } = loaded;
    if (steps.some((s) => s.approverMembershipId === membershipId)) {
      throw new AppError('conflict', 'you have already decided on this chain; two approvals come from two people', { code: 'approval.already_decided' });
    }
    // A discovery scan's chain (spec 19.2; written by the discovery service with its
    // authorisation): it names no connection, so its approver is someone who could have
    // authorised the scan themselves.
    if (chain.subjectKind === 'discovery_scan' && !await permitted(deps, ctx, 'discovery.authorise')) {
      throw new AppError('forbidden', 'you need discovery.authorise to approve a scan', { code: 'approval.not_permitted' });
    }
    // A purge's chain (spec 70.3; written by siloes-capture with its request): its approver
    // is someone who could have asked for the wipe themselves.
    if ((chain.subjectKind === 'purge' || chain.subjectKind === 'receipt_purge') && !await permitted(deps, ctx, 'silo.purge')) {
      throw new AppError('forbidden', 'you need silo.purge to approve a wipe', { code: 'approval.not_permitted' });
    }
    // A declassification's chain (spec 58.9; written by policy with its request): policy decides who
    // may approve it (satisfies the marking, is not the requester, is no service principal).
    if (chain.subjectKind === 'declassification') {
      const markingId = (chain.policySnapshot as { markingId?: string }).markingId!;
      const answer = await deps.services.call(declassificationDecision, {
        body: { markingId, step: 'approve', requestedBy: chain.requesterMembershipId },
      }, { request: ctx.request, correlationId: ctx.correlationId });
      if (answer.decision !== 'allow') {
        throw new AppError('forbidden', answer.reason === 'self_approval' ? 'you requested this declassification; another person approves it'
          : 'you must satisfy the marking to approve its declassification', { code: `approval.declassification_${answer.reason}` });
      }
    }
    const connections = await readConnections(deps, ctx.request, connectionIds);
    const scopeOf = (id: string) => connections.get(id)!.connection.owningScopeId;
    for (const id of connectionIds) {
      if (!await permitted(deps, ctx, 'mutation.approve', scopeOf(id))) {
        throw new AppError('forbidden', 'you need mutation.approve on the connection', { code: 'approval.not_permitted' });
      }
    }
    // A person cannot approve a value they may not see.
    const targets = mutation === undefined ? [] : await inTransaction(control, ctx.request, (db) => mutationTargetRepo.listByMutation(db, mutation.id), { readOnly: true });
    const fields = targets.filter((t) => !t.excluded).flatMap((t) => t.fields.map((path) => ({ connectionId: t.connectionId!, path })));
    if (fields.length > 0) {
      const access = await accessOf(deps, ctx, { connections: connectionIds, objectTypes: [], properties: [], fields });
      if (fields.some((f) => access.fieldEffect(f.connectionId, f.path) !== 'allow')) {
        throw new AppError('forbidden', 'the diff writes a field you may not read, so you cannot approve it', { code: 'approval.field_not_visible' });
      }
    }

    const snapshot = chain.policySnapshot as unknown as Snapshot;
    const conditions = readConditions(snapshot.conditions);
    const conditionOf = (id: string) => conditions.find((c) => c.id === id)!;
    let roles: Set<string> | undefined;
    const meets = async (c: ChainCondition): Promise<boolean> => {
      if (c.requiresAdmin || c.qualification === 'scope_admin') {
        for (const id of c.connectionIds) if (!await permitted(deps, ctx, 'scope.manage', scopeOf(id))) return false;
      }
      if (c.qualification === 'marking_holder' && !await clearedFor(deps, ctx, c.markingIds ?? [])) return false;
      if (c.qualification === 'role' || c.qualification === 'named_role') {
        roles ??= new Set((await inTransaction(control, ctx.request, (db) => roleAssignmentRepo.liveAssignments(db, membershipId), { readOnly: true })).map((a) => a.roleId));
        if (c.qualifyingRoleId === null || !roles.has(c.qualifyingRoleId)) return false;
      }
      if (membershipId === chain.requesterMembershipId && (!c.selfApprovalPermitted || decision !== 'approved')) return false;
      return true;
    };
    const open = steps.filter((s) => s.decision === null && s.offeredAt !== null)
      .sort((a, b) => strictness(conditionOf(b.qualifyingRule)) - strictness(conditionOf(a.qualifyingRule)));
    let slot: (typeof steps)[number] | undefined;
    for (const s of open) {
      if (await meets(conditionOf(s.qualifyingRule))) {
        slot = s;
        break;
      }
    }
    if (slot === undefined) {
      throw new AppError('forbidden', membershipId === chain.requesterMembershipId
        ? 'you proposed this change; self-approval is not permitted here' : 'you do not meet the qualification of any open approval', { code: 'approval.not_qualified' });
    }
    return slot;
  }

  return {
    get: view,

    /** Pending chains, oldest first; for the member, only those with an open step they may decide (spec 33.7). */
    async inbox(ctx: Context, limit: number, forMe = false): Promise<ChainView[]> {
      const { membershipId } = memberOf(ctx, 'reading the approvals inbox');
      const chains = await inTransaction(control, ctx.request, (db) => approvalChainRepo.listPending(db, forMe ? 200 : limit), { readOnly: true });
      const out: ChainView[] = [];
      for (const chain of chains) {
        if (out.length >= limit) break;
        if (await expireIfDue(ctx, chain.id)) continue;
        if (forMe) {
          const loaded = await loadChain(ctx, chain.id);
          if (loaded.chain.status !== 'pending') continue;
          const waits = await slotFor(ctx, loaded, membershipId, 'approved').then(() => true, (error: unknown) => {
            if (isAppError(error) && (error.category === 'forbidden' || error.category === 'conflict')) return false;
            throw error;
          });
          if (!waits) continue;
        }
        out.push(await view(ctx, chain.id));
      }
      return out;
    },

    async request(ctx: Context, mutationId: string): Promise<ChainView> {
      // A member, or a Cron's principal for its own mutation (checked below).
      const organisationId = ctx.request.servicePrincipalId !== undefined && ctx.request.organisationId !== undefined
        ? ctx.request.organisationId : memberOf(ctx, 'requesting approval').organisationId;
      const loaded = await inTransaction(control, ctx.request, async (db) => {
        const mutation = await mutationRepo.findById(db, mutationId);
        if (!mutation) throw new AppError('not_found', 'no such mutation', { code: 'mutation.not_found' });
        const targets = await mutationTargetRepo.listByMutation(db, mutationId);
        const version = (await actionTypeVersionRepo.findById(db, mutation.actionTypeVersionId))!;
        let typePolicy: ApprovalPolicy | undefined;
        if (version.approvalPolicyId !== null) {
          typePolicy = await approvalPolicyRepo.findById(db, version.approvalPolicyId);
          // Follow supersession to the policy in force.
          for (let n = 0; typePolicy?.supersededById != null && n < 100; n++) typePolicy = await approvalPolicyRepo.findById(db, typePolicy.supersededById);
        }
        // The markings it touches (see the header).
        const connectionIds = [...new Set(targets.filter((t) => !t.excluded).map((t) => t.connectionId!))];
        const touchedProperties = (mutation.manifest as { touchedProperties?: string[] }).touchedProperties ?? [];
        const markings = new Set([
          ...await resourceMarkingRepo.markingsFor(db, 'action_type', [version.actionTypeId]),
          ...await objectTypeMarkingRepo.markingsFor(db, [mutation.objectTypeId]),
          ...await resourceMarkingRepo.markingsFor(db, 'property', touchedProperties),
          // And the source fields those properties map (58.4, 21.15).
          ...await resourceMarkingRepo.mappedFieldMarkings(db, touchedProperties),
          ...await resourceMarkingRepo.markingsFor(db, 'connection', connectionIds),
        ].map((m) => m.markingId));
        return { mutation, targets, typePolicy, markings, policies: await approvalPolicyRepo.listLive(db), floors: await policyFloorRepo.listLive(db) };
      }, { readOnly: true });
      const { mutation } = loaded;
      if (mutation.status !== 'previewed') throw new AppError('conflict', `the mutation is ${mutation.status}; approval is requested once, at preview`, { code: 'approval.not_previewed' });
      const requester = mutation.authorisingMembershipId ?? mutation.proposerMembershipId;
      const byCron = mutation.origin === 'cron' && ctx.request.servicePrincipalId !== undefined && ctx.request.servicePrincipalId === mutation.proposerPrincipalId;
      if (requester === null || (requester !== ctx.request.membershipId && !byCron)) {
        throw new AppError('forbidden', 'approval is requested for the proposer\'s own mutation', { code: 'approval.not_requester' });
      }
      const authorised = mutation.cronMode === 'execute_within_bounds';
      const connectionIds = [...new Set(loaded.targets.filter((t) => !t.excluded).map((t) => t.connectionId!))];
      const connections = await readConnections(deps, ctx.request, connectionIds);
      const resolution = resolvePolicies({
        connections: connectionIds.map((id) => ({ id, owningScopeId: connections.get(id)!.connection.owningScopeId })),
        policies: loaded.policies.map(policyRow), floors: loaded.floors.map((f) => ({
          id: f.id, connectionId: f.connectionId, minimumApprovals: f.minimumApprovals, minimumQualification: f.minimumQualification, riskClass: f.riskClass,
          unwaivableMarkings: f.unwaivableMarkings,
        })),
        rowCount: guardrailRows(mutation), riskClass: mutation.riskClass,
        actionTypePolicy: loaded.typePolicy === undefined ? undefined : policyRow(loaded.typePolicy), markings: loaded.markings,
      });
      // Execute within bounds: the authorisation is the approval (43.11).
      const slots = authorised ? [] : allocateSlots(resolution.conditions);
      const chainId = uuidv7();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + resolution.expiryHours * 3_600_000).toISOString();
      const approvedNow = slots.length === 0;
      // Promotion creates proposals and never approves them (39.8); every non-Cron chain has an approver, and this holds it.
      if (approvedNow && mutation.origin === 'scenario_promotion') {
        throw new AppError('internal', 'a promotion is never approved at request: it is a proposal', { code: 'approval.promotion_unapproved' });
      }
      const snapshot = authorised ? {
        conditions: [], sequential: false, policies: [], floors: [], riskClass: mutation.riskClass, rowCount: mutation.rowCount,
        expiryHours: resolution.expiryHours, markings: [...loaded.markings].sort(),
        cron: { mode: 'execute_within_bounds', authorisingMembershipId: mutation.authorisingMembershipId },
      } : {
        conditions: storedConditions(resolution.conditions), sequential: resolution.sequential, policies: resolution.policyIds, floors: resolution.floorIds,
        actionTypePolicyId: loaded.typePolicy?.id ?? null, riskClass: mutation.riskClass, rowCount: mutation.rowCount, expiryHours: resolution.expiryHours,
        markings: [...loaded.markings].sort(),
        ...(resolution.overrides.length > 0 ? { override: resolution.overrides } : {}),
      };
      await inTransaction(control, ctx.request, async (db) => {
        await approvalChainRepo.insert(db, {
          id: chainId, organisationId, subjectKind: 'mutation', mutationId, requesterMembershipId: requester, riskClass: mutation.riskClass,
          policySnapshot: snapshot as never, floorOverrodePolicy: !authorised && resolution.overrides.length > 0, diffHash: mutation.diffHash,
          approvalsRequired: slots.length, status: approvedNow ? 'approved' : 'pending', expiresAt, ...(approvedNow ? { closedAt: now.toISOString() } : {}),
        });
        let sequence = 0;
        for (const rule of slots) {
          sequence += 1;
          const condition = resolution.conditions.find((c) => c.id === rule)!;
          await approvalStepRepo.insert(db, {
            id: uuidv7(), organisationId, chainId, sequence: resolution.sequential ? sequence : null, qualifyingRule: rule,
            qualifyingRoleId: condition.qualifyingRoleId, offeredAt: !resolution.sequential || sequence === 1 ? now.toISOString() : null,
          });
        }
        for (const connectionId of connectionIds) {
          await approvalChainConnectionRepo.insert(db, { id: uuidv7(), organisationId, chainId, connectionId });
        }
        await mutationRepo.update(db, mutationId, { status: approvedNow ? 'approved' : 'awaiting_approval' });
        const event = { organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'approvals' as const, resource: { type: 'approval_chain' as const, id: chainId } };
        await recordActionEvent(db, { ...event, event: 'approval_requested', detail: { mutation_id: mutationId, approvals_required: slots.length, risk_class: mutation.riskClass } });
        for (const o of authorised ? [] : resolution.overrides) {
          await recordActionEvent(db, { ...event, event: 'policy_floor_overrode_configured_policy', detail: { floor_id: o.floorId, connection_id: o.connectionId, from: o.from, to: o.to } });
        }
        await recordMutationStage(db, { organisationId, correlationId: ctx.correlationId, mutationId, stage: approvedNow ? 'approved' : 'awaiting_approval', rowCount: mutation.rowCount });
      });
      if (approvedNow && !mutation.executionSeparated) await execute(ctx, mutationId);
      return view(ctx, chainId);
    },

    async decide(ctx: Context, chainId: string, input: { decision: 'approved' | 'rejected'; diffHash: string; comment?: string | undefined }): Promise<ChainView> {
      const { organisationId, membershipId } = memberOf(ctx, 'approving');
      if (await expireIfDue(ctx, chainId)) throw new AppError('conflict', 'the approval chain has expired; the mutation is discarded', { code: 'approval.expired' });
      const loaded = await loadChain(ctx, chainId);
      const { chain, mutation } = loaded;
      if (chain.status !== 'pending') throw new AppError('conflict', `the approval chain is ${chain.status}`, { code: 'approval.chain_closed' });
      if (chain.diffHash === null || chain.diffHash.toString('hex') !== input.diffHash) {
        throw new AppError('conflict', 'the diff you saw is not the one this chain approves', { code: 'approval.diff_mismatch' });
      }
      const slot = await slotFor(ctx, loaded, membershipId, input.decision);
      const holdsActuation = chain.riskClass === 'physical' && await permitted(deps, ctx, 'actuation.approve');

      let approved = false;
      try {
        approved = await inTransaction(control, ctx.request, async (db) => {
          const locked = (await approvalChainRepo.findForUpdate(db, chainId))!;
          if (locked.status !== 'pending') throw new AppError('conflict', `the approval chain is ${locked.status}`, { code: 'approval.chain_closed' });
          const now = new Date().toISOString();
          await approvalStepRepo.update(db, slot.id, {
            approverMembershipId: membershipId, decision: input.decision, decidedAt: now, comment: input.comment ?? null, holdsActuationApprove: holdsActuation,
          });
          const after = (await approvalChainRepo.findById(db, chainId))!;
          const event = { organisationId, correlationId: ctx.correlationId, request: ctx.request, service: 'approvals' as const, resource: { type: 'approval_chain' as const, id: chainId } };
          const stepRow = (await approvalStepRepo.findById(db, slot.id))!;
          if (input.decision === 'rejected') {
            await approvalChainRepo.update(db, chainId, { status: 'rejected', closedAt: now });
            if (mutation !== undefined) await mutationRepo.update(db, mutation.id, { status: 'rejected', completedAt: now });
            await recordActionEvent(db, { ...event, event: 'approval_rejected', detail: { mutation_id: chain.mutationId } });
            if (mutation !== undefined) await recordMutationStage(db, { organisationId, correlationId: ctx.correlationId, mutationId: mutation.id, stage: 'rejected', rowCount: mutation.rowCount });
            return false;
          }
          await recordActionEvent(db, { ...event, event: stepRow.selfApproval ? 'self_approval_used' : 'approval_granted', detail: { mutation_id: chain.mutationId, rule: slot.qualifyingRule.slice(0, 200) } });
          if (after.approvalsReceived >= after.approvalsRequired) {
            await approvalChainRepo.update(db, chainId, { status: 'approved', closedAt: now });
            if (mutation !== undefined) {
              await mutationRepo.update(db, mutation.id, { status: 'approved' });
              await recordMutationStage(db, { organisationId, correlationId: ctx.correlationId, mutationId: mutation.id, stage: 'approved', rowCount: mutation.rowCount });
              // A physical Action's chain complete (47.8): both approvers named.
              if (chain.riskClass === 'physical') {
                const approvers = (await approvalStepRepo.listByChain(db, chainId)).filter((s) => s.decision === 'approved' && s.approverMembershipId !== null)
                  .map((s) => s.approverMembershipId!);
                await recordActionEvent(db, {
                  ...event, event: 'physical_action_approved', resource: { type: 'mutation', id: mutation.id },
                  detail: { chain_id: chainId, approvers: approvers.slice(0, 100), dry_run: mutation.dryRun === true },
                });
              }
            }
            return true;
          }
          if (slot.sequence !== null) {
            const next = (await approvalStepRepo.listByChain(db, chainId)).find((s) => s.sequence === slot.sequence! + 1);
            if (next !== undefined && next.offeredAt === null) await approvalStepRepo.update(db, next.id, { offeredAt: now });
          }
          return false;
        });
      } catch (error) {
        const mapped = fromDatabaseError(error);
        if (mapped.category === 'conflict' && mapped.details['constraint'] === 'approval_steps_one_per_approver') {
          throw new AppError('conflict', 'you have already decided on this chain; two approvals come from two people', { code: 'approval.already_decided' });
        }
        throw error;
      }
      if (approved && mutation !== undefined && !mutation.executionSeparated) await execute(ctx, mutation.id);
      // The final approver's decision executes the declassification (spec 58.9).
      if (approved && chain.subjectKind === 'declassification') {
        await deps.services.call(executeDeclassification, { params: { declassificationId: chain.declassificationId! } },
          { request: ctx.request, correlationId: ctx.correlationId });
      }
      return view(ctx, chainId);
    },
  };
}

export type Chains = ReturnType<typeof createChains>;
