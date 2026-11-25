// App branches (D229): a line of work on an app beside main, so several changes can be built at
// once without one waiting on another's review. A branch is opened from the published version
// by an editor, may be bound to an ontology branch (its drafts then validate against that
// branch's ontology, for an app built on a change still in review), holds one draft of its own
// and never goes to review itself: it is merged into main as main's next draft, by a three-way
// merge of the definitions' structure (appMerge.service.ts), each conflict decided by a person,
// and that draft then takes main's review like any other. A branch bound to an ontology branch
// merges only once that branch has merged. Abandoning keeps the record.

import type { AppBranchView, AppVersionView } from '../../contracts/studio/app.contract.ts';
import { getActiveVersion } from '../../contracts/ontology/manifest.contract.ts';
import { getBranch } from '../../contracts/ontology/proposal.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { AppBranch } from '../../models/workspace/appBranch.model.ts';
import type { AppVersion } from '../../models/workspace/appVersion.model.ts';
import { appBranchRepo, appRepo, appVersionRepo } from '../../repos/workspace/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { accessTo, check, insertDraft, markingsOf, versionView } from './apps.service.ts';
import { compareDefinitions, mergeDefinitions, type Change, type Conflict } from './appMerge.service.ts';
import { appNotFound, member, recordEvent, type Context, type Member, type StudioDeps } from './deps.service.ts';

const stale = () => new AppError('conflict', 'the branch changed since you read it', { code: 'studio.branch_stale' });
const branchNotFound = () => new AppError('not_found', 'no such branch', { code: 'studio.branch_not_found' });

export function branchView(b: AppBranch, numbers: { base: number | null; draft: number | null; merged: number | null }): AppBranchView {
  return {
    id: b.id, appId: b.appId, name: b.name, status: b.status, ontologyBranchId: b.ontologyBranchId, baseVersion: numbers.base, draftVersion: numbers.draft,
    mergedVersion: numbers.merged, createdBy: b.createdBy, createdAt: b.createdAt, closedAt: b.closedAt, lockVersion: b.lockVersion,
  };
}

/** The app, for one who may edit it: owner or an edit share. */
async function editable(deps: StudioDeps, me: Member, appId: string) {
  const app = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const found = await appRepo.findById(db, appId);
    if (!found || found.archivedAt !== null || found.kind !== 'app') return undefined;
    const held = await accessTo(db, found, me.membershipId);
    return held === 'owner' || held === 'edit' ? found : undefined;
  }, { readOnly: true });
  if (app === undefined) throw appNotFound();
  return app;
}

async function numbered(db: Parameters<typeof appVersionRepo.findById>[0], b: AppBranch): Promise<AppBranchView> {
  const at = async (id: string | null) => (id === null ? null : (await appVersionRepo.findById(db, id))?.version ?? null);
  const draft = await appVersionRepo.branchDraft(db, b.id);
  return branchView(b, { base: await at(b.baseVersionId), draft: draft?.version ?? null, merged: await at(b.mergedVersionId) });
}

/** The ontology a branch's draft validates against: its ontology branch's while that is open, otherwise main's. */
async function ontologyFor(deps: StudioDeps, ctx: Context, ontologyBranchId: string | null): Promise<{ branchId?: string; status: 'open' | 'merged' | 'abandoned' | 'main'; sequence: number }> {
  const options = { request: ctx.request, correlationId: ctx.correlationId };
  if (ontologyBranchId !== null) {
    const branch = await deps.services.call(getBranch, { params: { branchId: ontologyBranchId } }, options);
    if (branch.status === 'open') {
      const head = await deps.services.call(getActiveVersion, { query: { branchId: ontologyBranchId } }, options);
      return { branchId: ontologyBranchId, status: 'open', sequence: head.sequence };
    }
    const main = await deps.services.call(getActiveVersion, { query: {} }, options);
    return { status: branch.status, sequence: main.sequence };
  }
  const main = await deps.services.call(getActiveVersion, { query: {} }, options);
  return { status: 'main', sequence: main.sequence };
}

export async function listBranches(deps: StudioDeps, ctx: Context, appId: string): Promise<{ branches: AppBranchView[] }> {
  const me = member(ctx);
  await editable(deps, me, appId);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const rows = await appBranchRepo.listForApp(db, appId);
    const branches: AppBranchView[] = [];
    for (const b of rows) branches.push(await numbered(db, b));
    return { branches };
  }, { readOnly: true });
}

/** A branch from the published version, with a draft of its own. */
export async function openBranch(deps: StudioDeps, ctx: Context, appId: string, input: { name: string; ontologyBranchId?: string | undefined })
  : Promise<{ branch: AppBranchView; draft: AppVersionView }> {
  const me = member(ctx);
  const app = await editable(deps, me, appId);
  if (app.currentVersionId === null) throw new AppError('conflict', 'a branch is opened from a published version: publish the app first', { code: 'studio.branch_needs_published' });
  let ontology: Awaited<ReturnType<typeof ontologyFor>>;
  try {
    ontology = await ontologyFor(deps, ctx, input.ontologyBranchId ?? null);
  } catch (error) {
    if (isAppError(error) && error.category === 'not_found') throw new AppError('not_found', 'no such ontology branch', { code: 'studio.ontology_branch_not_found' });
    throw error;
  }
  if (input.ontologyBranchId !== undefined && ontology.status !== 'open') {
    throw new AppError('conflict', 'an app branch binds only to an open ontology branch', { code: 'studio.ontology_branch_closed' });
  }
  const base = await inTransaction(deps.databases.pool('control'), me.request, (db) => appVersionRepo.findById(db, app.currentVersionId!), { readOnly: true });
  const definition = { ...(base!.definition as Record<string, unknown>), ontologyVersion: ontology.sequence };
  const checked = await check(deps, ctx, definition, ontology.branchId);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    if (await appBranchRepo.openNamed(db, appId, input.name)) {
      throw new AppError('conflict', 'an open branch of this app already has that name', { code: 'studio.branch_name_taken' });
    }
    const branch = await appBranchRepo.insert(db, {
      id: uuidv7(), organisationId: me.organisationId, appId, name: input.name, baseVersionId: base!.id, ontologyBranchId: input.ontologyBranchId ?? null,
      status: 'open', createdBy: me.membershipId,
    });
    const draft = await insertDraft(db, {
      id: uuidv7(), organisationId: me.organisationId, appId, version: await appVersionRepo.nextVersion(db, appId), state: 'draft', branchId: branch.id,
      definition: definition as never, schemaVersion: base!.schemaVersion, ontologyVersion: String(ontology.sequence),
      markings: await markingsOf(db, checked.references), validationFindings: checked.findings as never, authoredBy: me.membershipId,
    });
    await recordEvent(db, me, ctx.correlationId, {
      event: 'app_branch_opened', resource: { type: 'app', id: appId },
      detail: { branch_id: branch.id, name: input.name, base_version: base!.version, ontology_branch_id: input.ontologyBranchId ?? null },
    });
    return { branch: await numbered(db, branch), draft: versionView(draft) };
  });
}

async function liveBranch(db: Parameters<typeof appBranchRepo.findForUpdate>[0], appId: string, branchId: string, lockVersion?: number): Promise<AppBranch> {
  const branch = await appBranchRepo.findForUpdate(db, branchId);
  if (!branch || branch.appId !== appId) throw branchNotFound();
  if (branch.status !== 'open') throw new AppError('conflict', `the branch is ${branch.status}`, { code: 'studio.branch_closed' });
  if (lockVersion !== undefined && branch.lockVersion !== lockVersion) throw stale();
  return branch;
}

/** The branch's draft saved: validated against its ontology branch while that is open, otherwise main's. */
export async function saveBranchDraft(deps: StudioDeps, ctx: Context, appId: string, branchId: string, definition: Record<string, unknown>, lockVersion: number)
  : Promise<AppVersionView> {
  const me = member(ctx);
  await editable(deps, me, appId);
  const branch = await inTransaction(deps.databases.pool('control'), me.request, (db) => appBranchRepo.findById(db, branchId), { readOnly: true });
  if (!branch || branch.appId !== appId) throw branchNotFound();
  const ontology = await ontologyFor(deps, ctx, branch.ontologyBranchId);
  const checked = await check(deps, ctx, definition, ontology.branchId);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    await liveBranch(db, appId, branchId);
    const draft = (await appVersionRepo.branchDraft(db, branchId))!;
    if (draft.lockVersion !== lockVersion) throw new AppError('conflict', 'the draft changed since you read it', { code: 'studio.version_stale' });
    const row = (await appVersionRepo.update(db, draft.id, {
      definition: definition as never, ontologyVersion: String(typeof definition['ontologyVersion'] === 'number' ? definition['ontologyVersion'] : ontology.sequence),
      markings: await markingsOf(db, checked.references), validationFindings: checked.findings as never, lockVersion: draft.lockVersion + 1,
    }))!;
    await recordEvent(db, me, ctx.correlationId, {
      event: 'app_draft_saved', resource: { type: 'app', id: appId }, detail: { version: row.version, findings: checked.findings.length, branch_id: branchId },
    });
    return versionView(row);
  });
}

/** What changed from one version to another, element by element. */
export async function compareVersions(deps: StudioDeps, ctx: Context, appId: string, from: number, to: number): Promise<{ changes: Change[] }> {
  const me = member(ctx);
  await editable(deps, me, appId);
  const [a, b] = await inTransaction(deps.databases.pool('control'), me.request, async (db) => [
    await appVersionRepo.findByAppIdAndVersion(db, { organisationId: me.organisationId, appId, version: from }),
    await appVersionRepo.findByAppIdAndVersion(db, { organisationId: me.organisationId, appId, version: to }),
  ], { readOnly: true });
  if (!a || !b) throw new AppError('not_found', 'no such version', { code: 'studio.version_not_found' });
  return { changes: compareDefinitions(a.definition as Record<string, unknown>, b.definition as Record<string, unknown>) };
}

/**
 * The branch merged into main as main's next draft: its changes and main's since the branch was
 * opened, by structure; the conflicts returned until each is decided. Main must have no draft
 * or version in review of its own, and a bound ontology branch must have merged.
 */
export async function mergeBranch(deps: StudioDeps, ctx: Context, appId: string, branchId: string,
  input: { lockVersion: number; decisions: { path: string; take: 'main' | 'branch' }[] })
  : Promise<{ outcome: 'conflicts'; conflicts: Conflict[] } | { outcome: 'merged'; branch: AppBranchView; draft: AppVersionView }> {
  const me = member(ctx);
  const app = await editable(deps, me, appId);
  const read = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const branch = await appBranchRepo.findById(db, branchId);
    if (!branch || branch.appId !== appId) throw branchNotFound();
    return {
      branch, base: branch.baseVersionId === null ? undefined : await appVersionRepo.findById(db, branch.baseVersionId),
      main: app.currentVersionId === null ? undefined : await appVersionRepo.findById(db, app.currentVersionId), draft: await appVersionRepo.branchDraft(db, branchId),
    };
  }, { readOnly: true });
  if (read.branch.status !== 'open') throw new AppError('conflict', `the branch is ${read.branch.status}`, { code: 'studio.branch_closed' });
  const ontology = await ontologyFor(deps, ctx, read.branch.ontologyBranchId);
  if (ontology.status === 'open') throw new AppError('conflict', 'its ontology branch has not merged yet: merge that first', { code: 'studio.ontology_branch_open' });
  if (ontology.status === 'abandoned') throw new AppError('conflict', 'its ontology branch was abandoned, so what it builds on will not exist', { code: 'studio.ontology_branch_abandoned' });
  const [base, main, draft] = [read.base!, read.main!, read.draft!];
  const { merged, conflicts } = mergeDefinitions(base.definition as Record<string, unknown>, main.definition as Record<string, unknown>,
    draft.definition as Record<string, unknown>, new Map(input.decisions.map((d) => [d.path, d.take])));
  if (conflicts.length > 0) return { outcome: 'conflicts', conflicts };
  merged['ontologyVersion'] = ontology.sequence;
  const checked = await check(deps, ctx, merged);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const branch = await liveBranch(db, appId, branchId, input.lockVersion);
    await appRepo.findForUpdate(db, appId);
    const open = await appVersionRepo.inProgress(db, appId);
    if (open !== undefined && open.state !== 'returned') {
      throw new AppError('conflict', `main has a version ${open.state === 'review' ? 'in review' : 'in draft'}: publish, return or finish it first`, { code: 'studio.main_in_progress' });
    }
    const row: AppVersion = await insertDraft(db, {
      id: uuidv7(), organisationId: me.organisationId, appId, version: await appVersionRepo.nextVersion(db, appId), state: 'draft',
      definition: merged as never, schemaVersion: draft.schemaVersion, ontologyVersion: String(ontology.sequence),
      markings: await markingsOf(db, checked.references), validationFindings: checked.findings as never, authoredBy: me.membershipId,
    });
    const closed = (await appBranchRepo.update(db, branchId, {
      status: 'merged', mergedVersionId: row.id, closedAt: new Date().toISOString(), closedBy: me.membershipId, lockVersion: branch.lockVersion + 1,
    }))!;
    await recordEvent(db, me, ctx.correlationId, {
      event: 'app_branch_merged', resource: { type: 'app', id: appId },
      detail: { branch_id: branchId, version: row.version, decided: input.decisions.length, findings: checked.findings.length },
    });
    return { outcome: 'merged' as const, branch: await numbered(db, closed), draft: versionView(row) };
  });
}

export async function abandonBranch(deps: StudioDeps, ctx: Context, appId: string, branchId: string, lockVersion: number): Promise<AppBranchView> {
  const me = member(ctx);
  await editable(deps, me, appId);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const branch = await liveBranch(db, appId, branchId, lockVersion);
    const closed = (await appBranchRepo.update(db, branchId, {
      status: 'abandoned', closedAt: new Date().toISOString(), closedBy: me.membershipId, lockVersion: branch.lockVersion + 1,
    }))!;
    await recordEvent(db, me, ctx.correlationId, { event: 'app_branch_abandoned', resource: { type: 'app', id: appId }, detail: { branch_id: branchId } });
    return numbered(db, closed);
  });
}
