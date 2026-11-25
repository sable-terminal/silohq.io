// Branches, versions, proposals and merge (spec 25.1 to 25.6).
//
// A proposal carries the branch's diff against its base: each changed element with its
// change class (spec 25.5), and the impact on dependants from the dependency index (spec
// 25.6). Merge needs: an ontology.confirm approval from someone not the author; an
// ontology.manage approval too when any change is breaking; the branch rebased onto main's
// head; and the impact unchanged since review. The merge copies the branch's entries onto
// main as one new version and brings the current-state rows level with it.
//
// An approval is for the diff it saw. When a rebase changes the diff, or the impact moves
// before merge, the proposal is withdrawn and a fresh one opened for review in its place:
// the earlier approvals do not carry over.

import { refreshEmbeddings } from './embeddings.service.ts';
import type { OntologyManifest, VersionView } from '../../contracts/ontology/manifest.contract.ts';
import { MANIFEST_SCHEMA_VERSION } from '../../contracts/ontology/manifest.contract.ts';
import type {
  BranchView, ChangeClass, ChangeView, DecisionView, ElementKind, ImpactView, ProposalView,
} from '../../contracts/ontology/proposal.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { OntologyBranch } from '../../models/ontology/ontologyBranch.model.ts';
import type { OntologyProposal } from '../../models/ontology/ontologyProposal.model.ts';
import {
  ontologyBranchRepo, ontologyDependencyRepo, ontologyProposalRepo, ontologyVersionRepo, propertyMappingRepo, proposalApprovalRepo,
} from '../../repos/ontology/index.repo.ts';
import { canonicalJson } from '../../utils/canonicalJson.util.ts';
import { AppError, fromDatabaseError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { diff, findById, highest, toView, type Content } from './content.service.ts';
import { acting, allowed, demand, demandView, mainBranch, person, recordEvent, type Acting, type Context, type OntologyDeps } from './deps.service.ts';
import { commit, loadVersion, readContent, versionToView, type Write } from './store.service.ts';

const pool = (deps: OntologyDeps) => deps.databases.pool('control');

// ----------------------------------------------------------------------------- reading

export function manifestOf(organisationId: string, version: VersionView, content: Content): OntologyManifest {
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, organisationId, version, ...toView(content) };
}

/** The head a read means: main's, or a branch's for a holder of ontology.branch. */
async function headFor(deps: OntologyDeps, ctx: Context, actor: Acting, branchId: string | undefined): Promise<string> {
  if (branchId === undefined) return (await mainBranch(deps, actor)).headVersionId!;
  const branch = await inTransaction(pool(deps), ctx.request, (db) => ontologyBranchRepo.findById(db, branchId), { readOnly: true });
  if (!branch) throw new AppError('not_found', 'no such branch', { code: 'ontology.branch_not_found' });
  // Compiling against a branch is for holders of ontology.branch (spec 25.3).
  if (branch.kind !== 'main') await demand(deps, ctx, 'ontology.branch');
  return branch.headVersionId!;
}

export async function getVersionManifest(deps: OntologyDeps, ctx: Context, versionId: string): Promise<OntologyManifest> {
  const actor = acting(ctx);
  await demandView(deps, ctx);
  const loaded = await inTransaction(pool(deps), ctx.request, (db) => loadVersion(db, actor.organisationId, versionId), { readOnly: true });
  // A version on a branch, as its head, is for a person holding ontology.branch (spec 25.3):
  // a plan pinned to one runs only for them.
  if (loaded.branch.kind !== 'main' && ctx.request.membershipId !== undefined) await demand(deps, ctx, 'ontology.branch');
  return manifestOf(actor.organisationId, loaded.version, loaded.content);
}

export async function getManifest(deps: OntologyDeps, ctx: Context, branchId: string | undefined): Promise<OntologyManifest> {
  const actor = acting(ctx);
  await demandView(deps, ctx);
  const head = await headFor(deps, ctx, actor, branchId);
  const loaded = await inTransaction(pool(deps), ctx.request, (db) => loadVersion(db, actor.organisationId, head), { readOnly: true });
  return manifestOf(actor.organisationId, loaded.version, loaded.content);
}

/** The source fields a type's properties map on main, as rows a field marking names (58.3). */
export async function listPropertyMappings(deps: OntologyDeps, ctx: Context, objectTypeId: string)
  : Promise<{ objectTypeId: string; typeVersionId: string; mappings: Awaited<ReturnType<typeof propertyMappingRepo.listWithProperties>> }> {
  const actor = acting(ctx);
  await demandView(deps, ctx);
  const head = await headFor(deps, ctx, actor, undefined);
  return inTransaction(pool(deps), ctx.request, async (db) => {
    const content = await readContent(db, actor.organisationId, head);
    const type = content.objectTypes.find((t) => t.id === objectTypeId && t.status !== 'retired');
    if (type === undefined) throw new AppError('not_found', 'no such object type on main', { code: 'ontology.element_not_found' });
    return { objectTypeId, typeVersionId: type.typeVersionId, mappings: await propertyMappingRepo.listWithProperties(db, type.typeVersionId) };
  }, { readOnly: true });
}

export async function getActiveVersion(deps: OntologyDeps, ctx: Context, branchId: string | undefined): Promise<VersionView> {
  const actor = acting(ctx);
  await demandView(deps, ctx);
  const head = await headFor(deps, ctx, actor, branchId);
  return inTransaction(pool(deps), ctx.request, async (db) => {
    const row = (await ontologyVersionRepo.findById(db, head))!;
    return versionToView(row, (await ontologyBranchRepo.findById(db, row.branchId))!);
  }, { readOnly: true });
}

export async function listVersions(deps: OntologyDeps, ctx: Context, branchId: string | undefined, limit: number): Promise<VersionView[]> {
  const actor = acting(ctx);
  await demandView(deps, ctx);
  const branch = branchId === undefined ? await mainBranch(deps, actor)
    : await inTransaction(pool(deps), ctx.request, (db) => ontologyBranchRepo.findById(db, branchId), { readOnly: true });
  if (!branch) throw new AppError('not_found', 'no such branch', { code: 'ontology.branch_not_found' });
  return inTransaction(pool(deps), ctx.request, async (db) =>
    (await ontologyVersionRepo.listForBranch(db, branch.id, limit)).map((v) => versionToView(v, branch)), { readOnly: true });
}

// ----------------------------------------------------------------------------- branches

export function branchView(b: OntologyBranch, mainHead: string | null): BranchView {
  return {
    id: b.id, name: b.name, kind: b.kind as BranchView['kind'], status: b.status as BranchView['status'], baseVersionId: b.baseVersionId,
    headVersionId: b.headVersionId, ownerMembershipId: b.ownerMembershipId,
    behindMain: b.kind !== 'main' && b.status === 'open' && mainHead !== null && b.baseVersionId !== mainHead,
    createdAt: b.createdAt, closedAt: b.closedAt,
  };
}

async function mainHeadIn(db: Queryable): Promise<string | null> {
  return (await ontologyBranchRepo.findMain(db))?.headVersionId ?? null;
}

/** Opens a branch at main's head (ontology.branch). Its head is main's head until its first commit. */
export async function openBranch(deps: OntologyDeps, ctx: Context, name: string, kind: 'working' | 'derivation' = 'working'): Promise<BranchView> {
  const actor = acting(ctx);
  if (kind === 'working') await demand(deps, ctx, 'ontology.branch');
  const main = await mainBranch(deps, actor);
  return inTransaction(pool(deps), ctx.request, async (db) => {
    const id = uuidv7();
    try {
      await ontologyBranchRepo.insert(db, {
        id, organisationId: actor.organisationId, name, kind, baseVersionId: main.headVersionId, headVersionId: main.headVersionId,
        ownerMembershipId: actor.membershipId ?? null, status: 'open',
      });
    } catch (error) {
      const mapped = fromDatabaseError(error);
      if (mapped.category === 'conflict') throw new AppError('conflict', 'an open branch has that name', { code: 'ontology.branch_name_taken' });
      throw mapped;
    }
    await recordEvent(db, actor, ctx.correlationId, { event: 'ontology_branch_opened', resource: { type: 'ontology_branch', id }, detail: { kind } });
    return branchView((await ontologyBranchRepo.findById(db, id))!, main.headVersionId);
  });
}

export async function getBranch(deps: OntologyDeps, ctx: Context, branchId: string): Promise<BranchView> {
  await demandView(deps, ctx);
  return inTransaction(pool(deps), ctx.request, async (db) => {
    const branch = await ontologyBranchRepo.findById(db, branchId);
    if (!branch) throw new AppError('not_found', 'no such branch', { code: 'ontology.branch_not_found' });
    return branchView(branch, await mainHeadIn(db));
  }, { readOnly: true });
}

export async function listBranches(deps: OntologyDeps, ctx: Context, openOnly: boolean, limit: number): Promise<BranchView[]> {
  await demandView(deps, ctx);
  return inTransaction(pool(deps), ctx.request, async (db) => {
    const head = await mainHeadIn(db);
    return (await ontologyBranchRepo.list(db, openOnly, limit)).map((b) => branchView(b, head));
  }, { readOnly: true });
}

async function lockOwnBranch(deps: OntologyDeps, ctx: Context, db: Queryable, actor: Acting, branchId: string, mayManage: boolean): Promise<OntologyBranch> {
  const branch = await ontologyBranchRepo.lock(db, branchId);
  if (!branch) throw new AppError('not_found', 'no such branch', { code: 'ontology.branch_not_found' });
  if (branch.kind === 'main') throw new AppError('forbidden', 'main is not a working branch', { code: 'ontology.main_merge_only' });
  if (branch.status !== 'open') throw new AppError('conflict', 'the branch is closed', { code: 'ontology.branch_closed' });
  if (branch.ownerMembershipId !== null && branch.ownerMembershipId !== actor.membershipId && !mayManage) {
    throw new AppError('forbidden', 'the branch is someone else\'s', { code: 'ontology.not_branch_owner' });
  }
  return branch;
}

export async function abandonBranch(deps: OntologyDeps, ctx: Context, branchId: string): Promise<BranchView> {
  const actor = acting(ctx);
  await demand(deps, ctx, 'ontology.branch');
  const mayManage = await allowed(deps, ctx, 'ontology.manage');
  return inTransaction(pool(deps), ctx.request, async (db) => {
    const branch = await lockOwnBranch(deps, ctx, db, actor, branchId, mayManage);
    const open = await ontologyProposalRepo.openForBranch(db, branch.id);
    if (open) await ontologyProposalRepo.update(db, open.id, { status: 'withdrawn', decidedAt: new Date().toISOString() });
    const closed = await ontologyBranchRepo.update(db, branch.id, { status: 'abandoned', closedAt: new Date().toISOString(), rowVersion: branch.rowVersion + 1 });
    await recordEvent(db, actor, ctx.correlationId, { event: 'ontology_branch_abandoned', resource: { type: 'ontology_branch', id: branch.id } });
    return branchView(closed!, await mainHeadIn(db));
  });
}

/** The branch's diff against its base. */
async function branchDiff(db: Queryable, organisationId: string, branch: OntologyBranch): Promise<{ base: Content; head: Content; changes: ChangeView[] }> {
  const [base, head] = await Promise.all([
    readContent(db, organisationId, branch.baseVersionId!), readContent(db, organisationId, branch.headVersionId!),
  ]);
  return { base, head, changes: diff(base, head) };
}

export async function getBranchChanges(deps: OntologyDeps, ctx: Context, branchId: string): Promise<{ changes: ChangeView[]; highestChangeClass: ChangeClass | null }> {
  const actor = acting(ctx);
  await demandView(deps, ctx);
  return inTransaction(pool(deps), ctx.request, async (db) => {
    const branch = await ontologyBranchRepo.findById(db, branchId);
    if (!branch) throw new AppError('not_found', 'no such branch', { code: 'ontology.branch_not_found' });
    if (branch.kind === 'main') return { changes: [], highestChangeClass: null };
    const { changes } = await branchDiff(db, actor.organisationId, branch);
    return { changes, highestChangeClass: highest(changes.map((c) => c.changeClass)) };
  }, { readOnly: true });
}

export interface RebaseResult {
  rebased: boolean;
  branch: BranchView;
  version: VersionView | null;
  conflicts: { kind: ElementKind; id: string; apiName: string }[];
}

/** Re-applies the branch's changes onto main's head (spec 25.3); conflicts need a resolution each. */
export async function rebaseBranch(deps: OntologyDeps, ctx: Context, branchId: string, resolutions: Record<string, 'branch' | 'main'>): Promise<RebaseResult> {
  const actor = acting(ctx);
  await demand(deps, ctx, 'ontology.branch');
  const mayManage = await allowed(deps, ctx, 'ontology.manage');
  return inTransaction(pool(deps), ctx.request, async (db) => {
    const branch = await lockOwnBranch(deps, ctx, db, actor, branchId, mayManage);
    const main = (await ontologyBranchRepo.findMain(db))!;
    if (branch.baseVersionId === main.headVersionId) {
      return { rebased: true, branch: branchView(branch, main.headVersionId), version: null, conflicts: [] };
    }
    const { base, head, changes } = await branchDiff(db, actor.organisationId, branch);
    const mainContent = await readContent(db, actor.organisationId, main.headVersionId!);
    const onMain = new Set(diff(base, mainContent).map((c) => c.id));
    const conflicts = changes.filter((c) => onMain.has(c.id)).map((c) => ({ kind: c.kind, id: c.id, apiName: c.apiName }));
    const unresolved = conflicts.filter((c) => resolutions[c.id] === undefined);
    if (unresolved.length > 0) return { rebased: false, branch: branchView(branch, main.headVersionId), version: null, conflicts: unresolved };

    const writes: Write[] = changes.filter((c) => !onMain.has(c.id) || resolutions[c.id] === 'branch').map((c) => {
      const written = writeOf(c, base, head);
      if (c.operation === 'retire') return written;
      return { ...written, operation: findById(mainContent, c.kind, c.id) ? 'change' : 'create' };
    });
    const result = await commit(db, {
      organisationId: actor.organisationId, branch, parentVersionId: main.headVersionId!, parentContent: mainContent, kind: 'change', actor,
      writes, newBaseVersionId: main.headVersionId!,
    });
    const moved = (await ontologyBranchRepo.findById(db, branch.id))!;
    await recordEvent(db, actor, ctx.correlationId, {
      event: 'ontology_branch_rebased', resource: { type: 'ontology_branch', id: branch.id },
      detail: { onto_version_id: main.headVersionId!, conflicts: conflicts.length, kept_from_main: conflicts.filter((c) => resolutions[c.id] === 'main').length },
    });
    // A proposal under review is for the diff it was given: if that changed, it starts again.
    const open = await ontologyProposalRepo.openForBranch(db, branch.id);
    if (open && open.status !== 'draft') await renewIfChanged(db, actor, ctx.correlationId, open, moved);
    return { rebased: true, branch: branchView(moved, main.headVersionId), version: versionToView(result.version, moved), conflicts: [] };
  });
}

/**
 * The write that carries a branch's change onto another version: the head's entry, where it
 * stands there; or, for an element the branch retired, the base's entry, retired.
 */
function writeOf(c: ChangeView, base: Content, head: Content): Write {
  if (c.operation === 'retire') {
    return { kind: c.kind, entry: findById(base, c.kind, c.id)!, operation: 'retire', changeClass: c.changeClass, lifecycle: 'retired' };
  }
  const entry = findById(head, c.kind, c.id)!;
  return {
    kind: c.kind, entry, operation: c.operation, changeClass: c.changeClass,
    lifecycle: entry.status === 'deprecated' ? 'deprecated' : 'active',
  };
}

// ----------------------------------------------------------------------------- impact

const EFFECT: Record<ChangeClass, ImpactView['elements'][number]['effect']> = {
  additive: 'unaffected', compatible: 'results_may_differ', breaking: 'will_fail',
};

/**
 * Dependants of each changed element, from the dependency index (spec 25.6). An object
 * type's dependants include those recorded against its properties. Counted, not named.
 */
export async function computeImpact(db: Queryable, changes: ChangeView[], base: Content, head: Content, againstVersionId: string): Promise<ImpactView> {
  const refs = new Map<string, string>(); // element or property identity id -> changed element id
  for (const c of changes) {
    refs.set(c.id, c.id);
    if (c.kind === 'object_type') {
      for (const content of [base, head]) {
        for (const p of findById(content, 'object_type', c.id)?.properties ?? []) refs.set(p.identityId, c.id);
      }
    }
  }
  const rows = await ontologyDependencyRepo.liveForElements(db, [...refs.keys()]);
  // Each dependant counts once per changed element, and once overall at the worst effect on it.
  const perElement = new Map<string, Set<string>>();
  const kindOf = new Map<string, string>();
  const worst = new Map<string, ChangeClass>();
  const classOf = new Map(changes.map((c) => [c.id, c.changeClass]));
  const rank: Record<ChangeClass, number> = { additive: 0, compatible: 1, breaking: 2 };
  for (const r of rows) {
    const element = refs.get(r.elementRef)!;
    if (!perElement.has(element)) perElement.set(element, new Set());
    perElement.get(element)!.add(r.dependantRef);
    kindOf.set(r.dependantRef, r.dependantKind);
    const cls = classOf.get(element)!;
    const was = worst.get(r.dependantRef);
    if (was === undefined || rank[cls] > rank[was]) worst.set(r.dependantRef, cls);
  }
  const byKind: Record<string, number> = {};
  for (const kind of kindOf.values()) byKind[kind] = (byKind[kind] ?? 0) + 1;
  const byEffect = { unaffected: 0, results_may_differ: 0, will_fail: 0 };
  for (const cls of worst.values()) byEffect[EFFECT[cls]] += 1;
  const elements = changes.map((c) => ({ kind: c.kind, id: c.id, effect: EFFECT[c.changeClass], dependants: perElement.get(c.id)?.size ?? 0 }));
  return { againstVersionId, total: worst.size, byEffect, byKind, elements };
}

/** The part of an impact that must not move between review and merge. */
const impactSubstance = (i: ImpactView | null): string => canonicalJson(i === null ? null : { ...i, againstVersionId: null });

// ----------------------------------------------------------------------------- proposals

interface StoredChanges {
  changes: ChangeView[];
  decisions: DecisionView[];
  /** A rollback proposal: the main version whose content it restores (spec 25.8). */
  rollbackTo?: string | undefined;
}

const storedOf = (p: OntologyProposal): StoredChanges => {
  const raw = p.changes as unknown as Partial<StoredChanges>;
  return { changes: raw.changes ?? [], decisions: raw.decisions ?? [], ...(raw.rollbackTo === undefined ? {} : { rollbackTo: raw.rollbackTo }) };
};

export async function proposalView(db: Queryable, p: OntologyProposal): Promise<ProposalView> {
  const stored = storedOf(p);
  // A proposal's approvals are for its diff: a changed diff opens a new proposal (above).
  const approvals = await proposalApprovalRepo.listForProposal(db, p.id);
  const confirmed = approvals.some((a) => a.permission === 'ontology.confirm');
  const managed = approvals.some((a) => a.permission === 'ontology.manage');
  return {
    id: p.id, branchId: p.branchId, title: p.title, description: p.description, origin: p.origin as ProposalView['origin'],
    status: p.status as ProposalView['status'], highestChangeClass: p.highestChangeClass as ChangeClass,
    authorMembershipId: p.authorMembershipId, authorServicePrincipalId: p.authorServicePrincipalId,
    changes: stored.changes, decisions: stored.decisions, impact: (p.impact as ImpactView | null) ?? null, impactComputedAt: p.impactComputedAt,
    approvals: approvals.map((a) => ({ membershipId: a.membershipId, permission: a.permission as ProposalView['approvals'][number]['permission'], approvedAt: a.approvedAt })),
    requires: { confirm: !confirmed, manage: p.highestChangeClass === 'breaking' && !managed },
    submittedAt: p.submittedAt, decidedAt: p.decidedAt, mergedBy: p.mergedBy, mergedAt: p.mergedAt, createdAt: p.createdAt,
  };
}

const authorOf = (actor: Acting) => ({
  authorMembershipId: actor.membershipId ?? null, authorServicePrincipalId: actor.membershipId === undefined ? actor.servicePrincipalId! : null,
});

/** Opens a proposal for review with the branch's current diff and impact. */
export async function openProposal(db: Queryable, actor: Acting, correlationId: string, branch: OntologyBranch, input: {
  title: string; description: string | null; origin: ProposalView['origin']; decisions?: DecisionView[]; author?: Acting;
  rollbackTo?: string | undefined;
}): Promise<OntologyProposal> {
  const { base, head, changes } = await branchDiff(db, actor.organisationId, branch);
  const now = new Date().toISOString();
  const decisions = input.decisions ?? [];
  const highestClass = highest(changes.map((c) => c.changeClass)) ?? 'additive';
  const main = (await ontologyBranchRepo.findMain(db))!;
  const impact = await computeImpact(db, changes, base, head, main.headVersionId!);
  const proposal = await ontologyProposalRepo.insert(db, {
    id: uuidv7(), organisationId: actor.organisationId, branchId: branch.id, title: input.title, description: input.description,
    origin: input.origin, changes: { changes, decisions, ...(input.rollbackTo === undefined ? {} : { rollbackTo: input.rollbackTo }) } as never,
    highestChangeClass: highestClass, impact: impact as never,
    impactComputedAt: now, status: 'in_review', ...authorOf(input.author ?? actor), submittedAt: now,
  });
  const resource = { type: 'ontology_proposal', id: proposal.id };
  await recordEvent(db, actor, correlationId, {
    event: input.origin === 'derivation' ? 'proposal_created' : 'ontology_proposal_submitted', resource,
    detail: { branch_id: branch.id, changes: changes.length, decisions: decisions.length, highest_change_class: highestClass },
  });
  await recordEvent(db, actor, correlationId, {
    event: 'ontology_impact_computed', resource, detail: { dependants: impact.total, will_fail: impact.byEffect['will_fail'] ?? 0 },
  });
  return proposal;
}

/** Withdraws a proposal whose diff or impact moved, and opens a fresh one in its place. */
async function renewIfChanged(db: Queryable, actor: Acting, correlationId: string, proposal: OntologyProposal, branch: OntologyBranch): Promise<OntologyProposal | undefined> {
  const { base, head, changes } = await branchDiff(db, actor.organisationId, branch);
  const main = (await ontologyBranchRepo.findMain(db))!;
  const impact = await computeImpact(db, changes, base, head, main.headVersionId!);
  const stored = storedOf(proposal);
  if (canonicalJson(stored.changes) === canonicalJson(changes) && impactSubstance(proposal.impact as ImpactView | null) === impactSubstance(impact)) {
    return undefined;
  }
  await ontologyProposalRepo.update(db, proposal.id, { status: 'withdrawn', decidedAt: new Date().toISOString(), rowVersion: proposal.rowVersion + 1 });
  return openProposal(db, actor, correlationId, branch, {
    title: proposal.title, description: proposal.description, origin: proposal.origin as ProposalView['origin'], decisions: stored.decisions,
    rollbackTo: stored.rollbackTo,
    author: { organisationId: actor.organisationId, membershipId: proposal.authorMembershipId ?? undefined,
      servicePrincipalId: proposal.authorServicePrincipalId ?? undefined },
  });
}

export async function submitProposal(deps: OntologyDeps, ctx: Context, branchId: string, input: { title: string; description?: string | undefined })
  : Promise<ProposalView> {
  const actor = acting(ctx);
  await demand(deps, ctx, 'ontology.propose');
  const mayManage = await allowed(deps, ctx, 'ontology.manage');
  return inTransaction(pool(deps), ctx.request, async (db) => {
    const branch = await lockOwnBranch(deps, ctx, db, actor, branchId, mayManage);
    if (await ontologyProposalRepo.openForBranch(db, branch.id)) {
      throw new AppError('conflict', 'the branch already has a proposal under way', { code: 'ontology.proposal_exists' });
    }
    const { changes } = await branchDiff(db, actor.organisationId, branch);
    if (changes.length === 0) throw new AppError('validation', 'the branch changes nothing', { code: 'ontology.nothing_to_propose' });
    const proposal = await openProposal(db, actor, ctx.correlationId, branch, {
      title: input.title, description: input.description ?? null, origin: actor.membershipId === undefined ? 'ai_fde' : 'person',
    });
    return proposalView(db, proposal);
  });
}

export async function getProposal(deps: OntologyDeps, ctx: Context, proposalId: string): Promise<ProposalView> {
  await demandView(deps, ctx);
  return inTransaction(pool(deps), ctx.request, async (db) => {
    const p = await ontologyProposalRepo.findById(db, proposalId);
    if (!p) throw new AppError('not_found', 'no such proposal', { code: 'ontology.proposal_not_found' });
    return proposalView(db, p);
  }, { readOnly: true });
}

export async function listProposals(deps: OntologyDeps, ctx: Context, openOnly: boolean, limit: number): Promise<ProposalView[]> {
  await demandView(deps, ctx);
  return inTransaction(pool(deps), ctx.request, async (db) =>
    Promise.all((await ontologyProposalRepo.list(db, openOnly, limit)).map((p) => proposalView(db, p))), { readOnly: true });
}

async function lockProposal(db: Queryable, proposalId: string): Promise<OntologyProposal> {
  const p = await ontologyProposalRepo.lock(db, proposalId);
  if (!p) throw new AppError('not_found', 'no such proposal', { code: 'ontology.proposal_not_found' });
  return p;
}

/** Records one person's approval with the permission used (spec 25.4). The author never approves. */
export async function recordApproval(db: Queryable, actor: Acting & { membershipId: string }, correlationId: string, p: OntologyProposal,
  permission: 'ontology.confirm' | 'ontology.manage'): Promise<OntologyProposal> {
  if (p.authorMembershipId === actor.membershipId) {
    throw new AppError('forbidden', 'the author of a proposal does not approve it', { code: 'ontology.author_cannot_approve' });
  }
  try {
    await proposalApprovalRepo.insert(db, { id: uuidv7(), organisationId: actor.organisationId, proposalId: p.id, membershipId: actor.membershipId, permission });
  } catch (error) {
    const mapped = isAppError(error) ? error : fromDatabaseError(error);
    if (mapped.category === 'conflict') throw new AppError('conflict', 'you have approved this proposal already', { code: 'ontology.already_approved' });
    throw mapped;
  }
  const view = await proposalView(db, p);
  const status = !view.requires.confirm && !view.requires.manage ? 'approved' : p.status;
  const updated = status === p.status ? p
    : (await ontologyProposalRepo.update(db, p.id, { status, decidedAt: new Date().toISOString(), rowVersion: p.rowVersion + 1 }))!;
  await recordEvent(db, actor, correlationId, {
    event: 'ontology_proposal_approved', resource: { type: 'ontology_proposal', id: p.id }, detail: { permission, status },
  });
  return updated;
}

export async function approveProposal(deps: OntologyDeps, ctx: Context, proposalId: string, permission: 'ontology.confirm' | 'ontology.manage'): Promise<ProposalView> {
  const actor = person(ctx, 'approving a proposal');
  await demand(deps, ctx, permission);
  return inTransaction(pool(deps), ctx.request, async (db) => {
    const p = await lockProposal(db, proposalId);
    if (p.status !== 'in_review' && p.status !== 'approved') {
      throw new AppError('conflict', `the proposal is ${p.status}`, { code: 'ontology.proposal_not_open' });
    }
    if (p.origin === 'derivation' && storedOf(p).decisions.some((d) => d.status === 'undecided')) {
      throw new AppError('conflict', 'a derivation proposal is approved by deciding its decisions', { code: 'ontology.decisions_pending' });
    }
    return proposalView(db, await recordApproval(db, actor, ctx.correlationId, p, permission));
  });
}

export async function rejectProposal(deps: OntologyDeps, ctx: Context, proposalId: string): Promise<ProposalView> {
  const actor = person(ctx, 'rejecting a proposal');
  await demand(deps, ctx, 'ontology.confirm');
  return inTransaction(pool(deps), ctx.request, async (db) => {
    const p = await lockProposal(db, proposalId);
    if (p.status !== 'in_review' && p.status !== 'approved' && p.status !== 'draft') {
      throw new AppError('conflict', `the proposal is ${p.status}`, { code: 'ontology.proposal_not_open' });
    }
    const updated = (await ontologyProposalRepo.update(db, p.id, { status: 'rejected', decidedAt: new Date().toISOString(), rowVersion: p.rowVersion + 1 }))!;
    await recordEvent(db, actor, ctx.correlationId, { event: 'ontology_proposal_rejected', resource: { type: 'ontology_proposal', id: p.id } });
    return proposalView(db, updated);
  });
}

export async function withdrawProposal(deps: OntologyDeps, ctx: Context, proposalId: string): Promise<ProposalView> {
  const actor = acting(ctx);
  const mayManage = await allowed(deps, ctx, 'ontology.manage');
  return inTransaction(pool(deps), ctx.request, async (db) => {
    const p = await lockProposal(db, proposalId);
    const isAuthor = (actor.membershipId !== undefined && p.authorMembershipId === actor.membershipId)
      || (actor.servicePrincipalId !== undefined && p.authorServicePrincipalId === actor.servicePrincipalId);
    if (!isAuthor && !mayManage) throw new AppError('forbidden', 'only the author withdraws a proposal', { code: 'ontology.not_author' });
    if (p.status !== 'in_review' && p.status !== 'approved' && p.status !== 'draft') {
      throw new AppError('conflict', `the proposal is ${p.status}`, { code: 'ontology.proposal_not_open' });
    }
    const updated = (await ontologyProposalRepo.update(db, p.id, { status: 'withdrawn', decidedAt: new Date().toISOString(), rowVersion: p.rowVersion + 1 }))!;
    return proposalView(db, updated);
  });
}

// ----------------------------------------------------------------------------- merge

export async function mergeProposal(deps: OntologyDeps, ctx: Context, proposalId: string): Promise<{ proposal: ProposalView; version: VersionView }> {
  const actor = person(ctx, 'merging');
  await demand(deps, ctx, 'ontology.merge');
  const outcome = await inTransaction(pool(deps), ctx.request, async (db) => {
    const p = await lockProposal(db, proposalId);
    if (p.status !== 'approved') {
      throw new AppError('conflict', p.status === 'merged' ? 'the proposal is merged already' : 'the proposal is not approved',
        { code: p.status === 'merged' ? 'ontology.proposal_merged' : 'ontology.proposal_not_approved' });
    }
    const branch = (await ontologyBranchRepo.lock(db, p.branchId))!;
    const main = (await ontologyBranchRepo.lock(db, (await ontologyBranchRepo.findMain(db))!.id))!;
    if (branch.status !== 'open') throw new AppError('conflict', 'the branch is closed', { code: 'ontology.branch_closed' });
    if (branch.baseVersionId !== main.headVersionId) {
      throw new AppError('conflict', 'main has moved: rebase the branch before merging', { code: 'ontology.rebase_required' });
    }
    // Impact runs again against the dependency index as it stands now (spec 25.6).
    const renewed = await renewIfChanged(db, actor, ctx.correlationId, p, branch);
    if (renewed) {
      await recordEvent(db, actor, ctx.correlationId, {
        event: 'ontology_merge_refused_impact_changed', resource: { type: 'ontology_proposal', id: p.id }, detail: { renewed_proposal_id: renewed.id },
      });
      return { refused: renewed.id } as const;
    }
    const { base, head, changes } = await branchDiff(db, actor.organisationId, branch);
    const mainContent = await readContent(db, actor.organisationId, main.headVersionId!);
    const writes: Write[] = changes.map((c) => writeOf(c, base, head));
    const approvals = (await proposalView(db, p)).approvals;
    const confirmer = approvals.find((a) => a.permission === 'ontology.confirm')!.membershipId;
    // A rollback's merge is the rollback (spec 25.8): a new main version, never a rewrite.
    const rollbackTo = storedOf(p).rollbackTo;
    const result = await commit(db, {
      organisationId: actor.organisationId, branch: main, parentVersionId: main.headVersionId!, parentContent: mainContent,
      kind: rollbackTo === undefined ? 'merge' : 'rollback', actor, writes, mergedFromProposalId: p.id, confirmer,
      ...(rollbackTo === undefined ? {} : { rolledBackToVersionId: rollbackTo }),
    });
    const now = new Date().toISOString();
    await ontologyBranchRepo.update(db, branch.id, { status: 'merged', closedAt: now, rowVersion: branch.rowVersion + 1 });
    const merged = (await ontologyProposalRepo.update(db, p.id, {
      status: 'merged', mergedBy: actor.membershipId, mergedAt: now, decidedAt: now, rowVersion: p.rowVersion + 1,
    }))!;
    const impact = p.impact as ImpactView | null;
    await recordEvent(db, actor, ctx.correlationId, {
      event: 'ontology_proposal_merged', resource: { type: 'ontology_proposal', id: p.id },
      // The elements it changed, up to a hundred (references only): what a later reader, such as the AI FDE's reversal rate (54.1), matches.
      detail: { version_id: result.version.id, highest_change_class: p.highestChangeClass, will_fail: impact?.byEffect['will_fail'] ?? 0, changes: changes.length,
        element_ids: changes.slice(0, 100).map((c) => c.id) },
    });
    if (rollbackTo !== undefined) {
      await recordEvent(db, actor, ctx.correlationId, {
        event: 'ontology_rolled_back', resource: { type: 'ontology_version', id: result.version.id },
        detail: { to_version_id: rollbackTo, proposal_id: p.id, restored: changes.filter((c) => c.operation !== 'retire').length,
          retired: changes.filter((c) => c.operation === 'retire').length },
      });
    } else {
      for (const c of changes.filter((x) => x.operation === 'create')) {
        if (c.kind === 'object_type') await recordEvent(db, actor, ctx.correlationId, { event: 'object_type_confirmed', resource: { type: 'object_type', id: c.id } });
        if (c.kind === 'link_type') await recordEvent(db, actor, ctx.correlationId, { event: 'link_type_confirmed', resource: { type: 'link_type', id: c.id } });
      }
    }
    return { proposal: await proposalView(db, merged), version: versionToView(result.version, main) } as const;
  });
  if ('refused' in outcome) {
    throw new AppError('conflict', 'the impact changed since review; the proposal is back in review', {
      code: 'ontology.merge_refused_impact_changed', details: { proposalId: outcome.refused },
    });
  }
  // Main changed: what changed is embedded again (decision 2026-11-15), after the merge and
  // apart from it; a ranking embeds anything still stale before it reads.
  void refreshEmbeddings(deps, actor.organisationId, ctx.correlationId).catch((error: unknown) => {
    deps.logger.failure('description embeddings could not be refreshed after a merge; the next ranking refreshes them', error, {
      event: 'ontology.embeddings_refresh_failed', organisationId: actor.organisationId,
    });
  });
  return outcome;
}
