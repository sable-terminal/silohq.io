// Studio apps (spec 35): creation, drafts validated on every save, review and publication,
// rollback, archive, and what a member holds on an app.
//
// Access: the owner; a co-editor (an edit share, named members only); a member a share
// reaches (view, run, copy), while the owner's sharing policy still permits it (the
// saved-view model, workspace's policy helpers); or a member in the subtree of a live scope
// publication. An archived app is its owner's only, and opens for no one.
//
// Versions: one in progress at a time (draft, review or returned). Saving edits the open
// draft under its lock, or opens a new one after a return or a publication. Submitting
// writes the version's references (app_references) while it is still a draft, then freezes
// it for review. Approval revalidates, supersedes the published version, advances every
// live publication to the new one and writes the version's lineage (spec 59.3).

import type { AppAccess, AppVersionView, AppView } from '../../contracts/studio/app.contract.ts';
import { APP_SCHEMA_VERSION, type AppDefinition, type AppDefinitionInput } from '../../contracts/studio/definition.contract.ts';
import type { OntologyManifest } from '../../contracts/ontology/manifest.contract.ts';
import { getActionType } from '../../contracts/actions/actionType.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { App } from '../../models/workspace/app.model.ts';
import type { AppVersion } from '../../models/workspace/appVersion.model.ts';
import { resourceMarkingRepo } from '../../repos/gov/index.repo.ts';
import { objectTypeMarkingRepo } from '../../repos/iam/index.repo.ts';
import { appPublicationRepo, appReferenceRepo, appRepo, appShareRepo, appVersionRepo, objectViewLayoutRepo } from '../../repos/workspace/index.repo.ts';
import { sha256 } from '../../utils/crypto.util.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { writeLineage } from '../lineage/writer.service.ts';
import { layoutFindings, layoutTypeOf } from './layoutRules.service.ts';
import { effectivePolicy, permitted } from '../workspace/sharing.service.ts';
import {
  actionFacts, appNotFound, demand, mainManifest, manifestAt, member, recordEvent, type Context, type Member, type StudioDeps,
} from './deps.service.ts';
import { instantiate, type Bindings, type TemplateName } from './templates.service.ts';
import { validate, type Validated } from './validator.service.ts';
import * as releases from './releases.service.ts';

export type Held = 'owner' | AppAccess | 'published';
const ACCESS_ORDER: readonly AppAccess[] = ['view', 'run', 'copy', 'edit'];
const stale = () => new AppError('conflict', 'the version changed since you read it', { code: 'studio.version_stale' });

const granteeOf = (share: { membershipId: string | null; scopeId: string | null }) =>
  share.membershipId !== null ? { kind: 'membership' as const, membershipId: share.membershipId }
    : share.scopeId !== null ? { kind: 'scope' as const, scopeId: share.scopeId } : { kind: 'organisation' as const };

/** What a member holds on an app now, or undefined. */
export async function accessTo(db: Queryable, app: App, membershipId: string): Promise<Held | undefined> {
  if (app.ownerMembershipId === membershipId) return 'owner';
  if (app.archivedAt !== null) return undefined;
  let best: AppAccess | undefined;
  const shares = await appShareRepo.liveReaching(db, app.id, membershipId);
  if (shares.length > 0) {
    const policy = await effectivePolicy(db, app.organisationId, app.ownerMembershipId);
    for (const share of shares) {
      if (!await permitted(db, app.ownerMembershipId, granteeOf(share), policy)) continue;
      const held = share.access as AppAccess;
      if (best === undefined || ACCESS_ORDER.indexOf(held) > ACCESS_ORDER.indexOf(best)) best = held;
    }
  }
  if (best !== undefined) return best;
  return await appPublicationRepo.reachesMember(db, app.id, membershipId) ? 'published' : undefined;
}

const canEdit = (held: Held | undefined): boolean => held === 'owner' || held === 'edit';

export function versionView(v: AppVersion): AppVersionView {
  return {
    id: v.id, appId: v.appId, version: v.version, state: v.state, definition: v.definition as Record<string, never>, schemaVersion: v.schemaVersion,
    ontologyVersion: Number(v.ontologyVersion), markings: v.markings, findings: v.validationFindings as AppVersionView['findings'],
    rolledBackFromVersion: v.rolledBackFromVersion, branchId: v.branchId, authoredBy: v.authoredBy, reviewedBy: v.reviewedBy, createdAt: v.createdAt,
    reviewedAt: v.reviewedAt, publishedAt: v.publishedAt, lockVersion: v.lockVersion,
  };
}

export function appView(app: App, held: Held, inProgress: AppVersion | undefined): AppView {
  return {
    id: app.id, name: app.name, description: app.description, kind: app.kind, visibility: app.visibility, ownerMembershipId: app.ownerMembershipId,
    currentVersionId: app.currentVersionId, generatedBy: app.generatedBy, requireFullClearance: app.requireFullClearance, archivedAt: app.archivedAt,
    createdAt: app.createdAt, updatedAt: app.updatedAt, lockVersion: app.lockVersion, access: held,
    draft: inProgress !== undefined && canEdit(held) && inProgress.state !== 'published' && inProgress.state !== 'superseded'
      ? { version: inProgress.version, state: inProgress.state, findings: (inProgress.validationFindings as unknown[]).length } : null,
  };
}

/** The validator over a definition as written, with the manifest it binds and the Action types it names. */
export async function check(deps: StudioDeps, ctx: Context, raw: Record<string, unknown>, ontologyBranchId?: string): Promise<Validated & { manifest: OntologyManifest | undefined }> {
  const sequence = typeof raw['ontologyVersion'] === 'number' && Number.isInteger(raw['ontologyVersion']) ? raw['ontologyVersion'] : undefined;
  const manifest = sequence === undefined ? undefined : await manifestAt(deps, ctx, sequence, ontologyBranchId);
  const actions = Array.isArray(raw['actions']) ? (raw['actions'] as unknown[]).filter((a): a is string => typeof a === 'string') : [];
  const facts = await actionFacts(deps, ctx, actions.filter((a) => /^[0-9a-f-]{36}$/.test(a)));
  return { ...validate(raw, manifest, facts), manifest };
}

/** The union of the direct markings on every element the version references (35.6). */
export async function markingsOf(db: Queryable, references: Validated['references']): Promise<string[]> {
  const ids = (kind: keyof Validated['references']) => [...references[kind].keys()];
  const marks = [
    ...await objectTypeMarkingRepo.markingsFor(db, ids('objectType')),
    ...await resourceMarkingRepo.markingsFor(db, 'property', ids('property')),
    ...await resourceMarkingRepo.markingsFor(db, 'link_type', ids('linkType')),
    ...await resourceMarkingRepo.markingsFor(db, 'action_type', ids('actionType')),
    ...await resourceMarkingRepo.markingsFor(db, 'function', ids('function')),
  ];
  return [...new Set(marks.map((m) => m.markingId))].sort();
}

async function writeReferences(db: Queryable, organisationId: string, versionId: string, references: Validated['references']): Promise<void> {
  const columns: Record<keyof Validated['references'], 'objectTypeId' | 'propertyId' | 'linkTypeId' | 'actionTypeId' | 'functionId'> = {
    objectType: 'objectTypeId', property: 'propertyId', linkType: 'linkTypeId', actionType: 'actionTypeId', function: 'functionId',
  };
  for (const [kind, column] of Object.entries(columns) as [keyof Validated['references'], typeof columns[keyof typeof columns]][]) {
    for (const [elementId, widgets] of references[kind]) {
      await appReferenceRepo.insert(db, {
        id: uuidv7(), organisationId, appVersionId: versionId, objectTypeId: null, propertyId: null, linkTypeId: null, actionTypeId: null,
        functionId: null, [column]: elementId, widgetIds: [...widgets].sort(),
      });
    }
  }
}

export const skeleton = (name: string, manifest: OntologyManifest): AppDefinitionInput => ({
  schemaVersion: APP_SCHEMA_VERSION, ontologyVersion: manifest.version.sequence, variables: {},
  pages: [{ id: 'home', title: name.slice(0, 120), widgets: [] }], events: [], functions: [], actions: [],
});

async function loadApp(deps: StudioDeps, me: Member, appId: string): Promise<{ app: App; held: Held }> {
  const found = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const app = await appRepo.findById(db, appId);
    if (!app) return undefined;
    const held = await accessTo(db, app, me.membershipId);
    return held === undefined ? undefined : { app, held };
  }, { readOnly: true });
  if (found === undefined) throw appNotFound();
  return found;
}

/** The type a layout app is for: its first version's object variable (34.6). */
export async function layoutTypeOfApp(db: Queryable, organisationId: string, appId: string): Promise<string | undefined> {
  const first = await appVersionRepo.findByAppIdAndVersion(db, { organisationId, appId, version: 1 });
  return first === undefined ? undefined : layoutTypeOf(first.definition as Record<string, unknown>);
}

// ----------------------------------------------------------------------------- create, read, list

export interface CreateInput {
  name: string;
  description?: string | undefined;
  requireFullClearance: boolean;
  template?: { name: TemplateName; bindings: Bindings } | undefined;
  generatedBy?: 'ai_fde' | undefined;
}

/**
 * A new draft, main's or a branch's: an app version's lineage is written when it is published
 * (approve, below), as its references are then frozen; a draft has none yet.
 */
export function insertDraft(db: Queryable, row: Parameters<typeof appVersionRepo.insert>[1]): Promise<AppVersion> {
  return appVersionRepo.insert(db, row);
}

export async function insertApp(deps: StudioDeps, ctx: Context, me: Member, input: CreateInput & {
  definition: Record<string, unknown>; copiedFrom?: string; kind?: App['kind']; layoutFor?: string;
}): Promise<{ app: AppView; draft: AppVersionView }> {
  const checked = await check(deps, ctx, input.definition);
  const findings = [...checked.findings, ...(input.layoutFor === undefined ? [] : layoutFindings(input.definition, input.layoutFor))];
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const app = await appRepo.insert(db, {
      id: uuidv7(), organisationId: me.organisationId, ownerMembershipId: me.membershipId, name: input.name, description: input.description ?? null,
      kind: input.kind ?? 'app', requireFullClearance: input.requireFullClearance, generatedBy: input.generatedBy ?? null,
    });
    const draft = await appVersionRepo.insert(db, {
      id: uuidv7(), organisationId: me.organisationId, appId: app.id, version: 1, state: 'draft', definition: input.definition as never,
      schemaVersion: APP_SCHEMA_VERSION, ontologyVersion: String(checked.manifest?.version.sequence ?? input.definition['ontologyVersion'] ?? 0),
      markings: await markingsOf(db, checked.references), validationFindings: findings as never, authoredBy: me.membershipId,
    });
    await recordEvent(db, me, ctx.correlationId, {
      event: 'app_created', resource: { type: 'app', id: app.id },
      detail: { template: input.template?.name ?? null, copied_from: input.copiedFrom ?? null, findings: findings.length, kind: app.kind },
    });
    if (input.generatedBy === 'ai_fde') {
      await recordEvent(db, me, ctx.correlationId, {
        event: 'app_generated_by_fde', resource: { type: 'app', id: app.id }, detail: { template: input.template?.name ?? null, accepted_by: me.membershipId },
      });
    }
    return { app: appView(app, 'owner', draft), draft: versionView(draft) };
  });
}

export async function create(deps: StudioDeps, ctx: Context, input: CreateInput): Promise<{ app: AppView; draft: AppVersionView }> {
  const me = member(ctx);
  if (input.generatedBy !== undefined && ctx.caller !== 'fde-orchestrator') {
    throw new AppError('forbidden', 'only an accepted AI FDE proposal is marked as generated', { code: 'studio.generated_by_fde_only' });
  }
  await demand(deps, ctx, { permission: 'app.create' });
  const manifest = await mainManifest(deps, ctx);
  const definition = input.template === undefined ? skeleton(input.name, manifest) : instantiate(input.template.name, input.template.bindings, manifest);
  return insertApp(deps, ctx, me, { ...input, definition: definition as Record<string, unknown> });
}

export async function read(deps: StudioDeps, ctx: Context, appId: string): Promise<{ app: AppView; versions: Omit<AppVersionView, 'definition'>[] }> {
  const me = member(ctx);
  const { app, held } = await loadApp(deps, me, appId);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const versions = await appVersionRepo.listForApp(db, app.id);
    // Only those who may edit see drafts and history; everyone else sees what is published.
    const shown = canEdit(held) ? versions : versions.filter((v) => v.id === app.currentVersionId);
    return {
      app: appView(app, held, versions.find((v) => v.branchId === null && ['draft', 'review', 'returned'].includes(v.state))),
      versions: shown.map((v) => { const { definition: _d, ...rest } = versionView(v); return rest; }),
    };
  }, { readOnly: true });
}

export async function readVersion(deps: StudioDeps, ctx: Context, appId: string, version: number): Promise<AppVersionView> {
  const me = member(ctx);
  const { app, held } = await loadApp(deps, me, appId);
  const row = await inTransaction(deps.databases.pool('control'), me.request, (db) => appVersionRepo.findByAppIdAndVersion(db, {
    organisationId: me.organisationId, appId, version,
  }), { readOnly: true });
  if (!row || (!canEdit(held) && row.id !== app.currentVersionId)) throw new AppError('not_found', 'no such version', { code: 'studio.version_not_found' });
  return versionView(row);
}

export async function list(deps: StudioDeps, ctx: Context, filter: 'mine' | 'shared' | 'published' | 'archived', limit: number): Promise<AppView[]> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const rows = filter === 'mine' || filter === 'archived'
      ? await appRepo.listOwned(db, me.membershipId, filter === 'archived', limit)
      : await appRepo.findMany(db, filter === 'shared' ? await appShareRepo.appsReaching(db, me.membershipId) : await appPublicationRepo.appsReaching(db, me.membershipId), limit);
    const out: AppView[] = [];
    for (const app of rows) {
      const held = await accessTo(db, app, me.membershipId);
      if (held === undefined || (filter !== 'mine' && filter !== 'archived' && held === 'owner')) continue;
      out.push(appView(app, held, canEdit(held) ? await appVersionRepo.inProgress(db, app.id) : undefined));
    }
    return out;
  }, { readOnly: true });
}

// ----------------------------------------------------------------------------- the lifecycle

export async function saveDraft(deps: StudioDeps, ctx: Context, appId: string, definition: Record<string, unknown>, lockVersion: number | undefined)
  : Promise<AppVersionView> {
  const me = member(ctx);
  const { held, app: loadedApp } = await loadApp(deps, me, appId);
  if (!canEdit(held)) throw appNotFound();
  const checked = await check(deps, ctx, definition);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const app = (await appRepo.findForUpdate(db, appId))!;
    if (app.archivedAt !== null) throw new AppError('conflict', 'an archived app is not edited', { code: 'studio.app_archived' });
    // A layout stays a layout of the type it was created for (34.6).
    const layoutFor = loadedApp.kind === 'object_view_layout' ? await layoutTypeOfApp(db, me.organisationId, appId) : undefined;
    const findings = [...checked.findings, ...(layoutFor === undefined ? [] : layoutFindings(definition, layoutFor))];
    const open = await appVersionRepo.inProgress(db, appId);
    if (open?.state === 'review') throw new AppError('conflict', 'a version is in review: return or publish it first', { code: 'studio.version_in_review' });
    const fields = {
      definition: definition as never, schemaVersion: typeof definition['schemaVersion'] === 'string' ? definition['schemaVersion'] : APP_SCHEMA_VERSION,
      ontologyVersion: String(checked.manifest?.version.sequence ?? (typeof definition['ontologyVersion'] === 'number' ? definition['ontologyVersion'] : 0)),
      markings: await markingsOf(db, checked.references), validationFindings: findings as never,
    };
    let row: AppVersion;
    if (open?.state === 'draft') {
      if (lockVersion !== open.lockVersion) throw stale();
      row = (await appVersionRepo.update(db, open.id, { ...fields, lockVersion: open.lockVersion + 1 }))!;
    } else {
      if (lockVersion !== undefined) throw stale();
      row = await appVersionRepo.insert(db, {
        id: uuidv7(), organisationId: me.organisationId, appId, version: await appVersionRepo.nextVersion(db, appId), state: 'draft',
        authoredBy: me.membershipId, ...fields,
      });
    }
    await appRepo.update(db, appId, { lockVersion: app.lockVersion + 1 });
    await recordEvent(db, me, ctx.correlationId, {
      event: 'app_draft_saved', resource: { type: 'app', id: appId }, detail: { version: row.version, findings: findings.length },
    });
    return versionView(row);
  });
}

export async function submit(deps: StudioDeps, ctx: Context, appId: string, version: number, lockVersion: number): Promise<AppVersionView> {
  const me = member(ctx);
  const { held } = await loadApp(deps, me, appId);
  if (!canEdit(held)) throw appNotFound();
  const current = await inTransaction(deps.databases.pool('control'), me.request, (db) => appVersionRepo.findByAppIdAndVersion(db, {
    organisationId: me.organisationId, appId, version,
  }), { readOnly: true });
  if (!current) throw new AppError('not_found', 'no such version', { code: 'studio.version_not_found' });
  // Validated again now: the ontology or an Action type may have moved since the save.
  const checked = await check(deps, ctx, current.definition as Record<string, unknown>);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const row = (await appVersionRepo.findForUpdate(db, appId, version))!;
    if (row.lockVersion !== lockVersion) throw stale();
    if (row.state !== 'draft') throw new AppError('conflict', 'only a draft is submitted', { code: 'studio.not_draft' });
    if (row.branchId !== null) throw new AppError('conflict', 'a branch\'s draft reaches review by merging into main', { code: 'studio.branch_draft_merges' });
    if (checked.findings.length > 0) {
      await appVersionRepo.update(db, row.id, { validationFindings: checked.findings as never, lockVersion: row.lockVersion + 1 });
      throw new AppError('validation', 'the draft has findings: fix them before review', { code: 'studio.draft_invalid', details: { findings: checked.findings.length } });
    }
    // References are written while the version is still a draft: they are frozen with it.
    await writeReferences(db, me.organisationId, row.id, checked.references);
    const frozen = (await appVersionRepo.update(db, row.id, {
      state: 'review', markings: await markingsOf(db, checked.references), validationFindings: [] as never, lockVersion: row.lockVersion + 1,
    }))!;
    await recordEvent(db, me, ctx.correlationId, { event: 'app_submitted_for_review', resource: { type: 'app', id: appId }, detail: { version } });
    return versionView(frozen);
  });
}

/** The version's lineage: the types, Action types and Functions it uses (spec 59.3). */
async function lineageOf(deps: StudioDeps, ctx: Context, definition: AppDefinition, manifest: OntologyManifest)
  : Promise<{ node: { kind: 'object_type_version' | 'action_type_version' | 'function_version'; refId: string; version: string }; relation: 'uses' }[]> {
  const inputs: { node: { kind: 'object_type_version' | 'action_type_version' | 'function_version'; refId: string; version: string }; relation: 'uses' }[] = [];
  const typeIds = new Set(Object.values(definition.variables).flatMap((v) => (v.kind === 'objectSet' || v.kind === 'selection' ? [v.objectTypeId] : [])));
  for (const id of typeIds) {
    const type = manifest.objectTypes.find((t) => t.id === id);
    if (type) inputs.push({ node: { kind: 'object_type_version', refId: id, version: type.typeVersionId }, relation: 'uses' });
  }
  for (const id of definition.functions) {
    const fn = manifest.functions.find((f) => f.id === id);
    if (fn) inputs.push({ node: { kind: 'function_version', refId: id, version: sha256(fn.version.expression).toString('hex') }, relation: 'uses' });
  }
  for (const id of definition.actions) {
    try {
      const type = await deps.services.call(getActionType, { params: { actionTypeId: id } }, { request: ctx.request, correlationId: ctx.correlationId });
      if (type.current) inputs.push({ node: { kind: 'action_type_version', refId: id, version: type.current.id }, relation: 'uses' });
    } catch (error) {
      if (!isAppError(error) || error.category !== 'not_found') throw error;
    }
  }
  return inputs;
}

/** A reviewer holding app.publish approves; never the author. Revalidated, then published. */
export async function approve(deps: StudioDeps, ctx: Context, appId: string, version: number, lockVersion: number, scopeId: string | undefined,
  stages?: readonly { scopeIds: string[] }[] | undefined)
  : Promise<AppVersionView> {
  const me = member(ctx);
  await demand(deps, ctx, scopeId === undefined ? { permission: 'app.publish' } : { permission: 'app.publish', scopeId });
  if (stages !== undefined) await releases.checkStages(deps, ctx, stages);
  const { app } = await loadApp(deps, me, appId).catch(async (error) => {
    // A reviewer may have no share: app.publish is the authority to review (35.7).
    if (!isAppError(error) || error.category !== 'not_found') throw error;
    const found = await inTransaction(deps.databases.pool('control'), me.request, (db) => appRepo.findById(db, appId), { readOnly: true });
    if (!found || found.archivedAt !== null) throw appNotFound();
    return { app: found, held: 'view' as Held };
  });
  const current = await inTransaction(deps.databases.pool('control'), me.request, (db) => appVersionRepo.findByAppIdAndVersion(db, {
    organisationId: me.organisationId, appId, version,
  }), { readOnly: true });
  if (!current) throw new AppError('not_found', 'no such version', { code: 'studio.version_not_found' });
  if (current.authoredBy === me.membershipId) throw new AppError('forbidden', 'an author never reviews their own version', { code: 'studio.author_cannot_review' });
  const checked = await check(deps, ctx, current.definition as Record<string, unknown>);
  const layoutFor = app.kind === 'object_view_layout'
    ? await inTransaction(deps.databases.pool('control'), me.request, (db) => layoutTypeOfApp(db, me.organisationId, appId), { readOnly: true }) : undefined;
  if (layoutFor !== undefined) checked.findings.push(...layoutFindings(current.definition as Record<string, unknown>, layoutFor));
  if (checked.findings.length > 0 || checked.definition === undefined || checked.manifest === undefined) {
    throw new AppError('validation', 'the version no longer validates: return it', { code: 'studio.version_invalid', details: { findings: checked.findings.length } });
  }
  const inputs = await lineageOf(deps, ctx, checked.definition, checked.manifest);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const row = (await appVersionRepo.findForUpdate(db, appId, version))!;
    if (row.lockVersion !== lockVersion) throw stale();
    if (row.state !== 'review') throw new AppError('conflict', 'only a version in review is approved', { code: 'studio.not_in_review' });
    // One release rolls out at a time (D230); a staged one keeps everyone else on what they open now.
    await releases.assertNoRollout(db, appId);
    const general = stages === undefined ? undefined : await releases.generalVersionId(db, (await appRepo.findById(db, appId))!);
    if (stages !== undefined && (general === undefined || general === null)) {
      throw new AppError('validation', 'a first version is published to everyone: stages roll out a later one', { code: 'studio.release_needs_previous' });
    }
    const now = new Date().toISOString();
    const previous = await appVersionRepo.publishedForUpdate(db, appId);
    if (previous) await appVersionRepo.update(db, previous.id, { state: 'superseded', lockVersion: previous.lockVersion + 1 });
    const published = (await appVersionRepo.update(db, row.id, {
      state: 'published', reviewedBy: me.membershipId, reviewedAt: now, publishedAt: now, lockVersion: row.lockVersion + 1,
    }))!;
    const advanced = await appPublicationRepo.advance(db, appId, row.id);
    await appRepo.update(db, appId, { currentVersionId: row.id, lockVersion: app.lockVersion + 1 });
    if (stages !== undefined) await releases.startRelease(db, me, ctx.correlationId, { appId, toVersionId: row.id, fromVersionId: general!, stages });
    await writeLineage(db, { organisationId: me.organisationId, createdBy: { membershipId: row.authoredBy } }, {
      artefact: { kind: 'app_version', refId: appId, version: row.id }, inputs,
    });
    await recordEvent(db, me, ctx.correlationId, {
      event: 'app_version_published', resource: { type: 'app', id: appId }, subjectMembershipId: row.authoredBy, scopeId: scopeId ?? null,
      detail: { version, author: row.authoredBy, reviewer: me.membershipId, publications_advanced: advanced, markings: row.markings },
    });
    if (layoutFor !== undefined) {
      // The type's layout from now on (34.6): one active per type; the one before is superseded.
      const previousLayout = await objectViewLayoutRepo.activeFor(db, layoutFor, true);
      if (previousLayout) await objectViewLayoutRepo.update(db, previousLayout.id, { status: 'superseded' });
      const layout = await objectViewLayoutRepo.insert(db, {
        id: uuidv7(), organisationId: me.organisationId, objectTypeId: layoutFor, ontologyVersion: String(checked.manifest!.version.sequence),
        generated: false, appVersionId: row.id, status: 'active', createdBy: row.authoredBy,
      });
      await recordEvent(db, me, ctx.correlationId, {
        event: 'object_view_layout_published', resource: { type: 'object_view_layout', id: layout.id }, subjectMembershipId: row.authoredBy, scopeId: scopeId ?? null,
        detail: { object_type_id: layoutFor, app_id: appId, version, superseded: previousLayout?.id ?? null },
      });
    }
    return versionView(published);
  });
}

export async function returnToAuthor(deps: StudioDeps, ctx: Context, appId: string, version: number, lockVersion: number): Promise<AppVersionView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'app.publish' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const row = await appVersionRepo.findForUpdate(db, appId, version);
    if (!row) throw new AppError('not_found', 'no such version', { code: 'studio.version_not_found' });
    if (row.lockVersion !== lockVersion) throw stale();
    if (row.authoredBy === me.membershipId) throw new AppError('forbidden', 'an author never reviews their own version', { code: 'studio.author_cannot_review' });
    if (row.state !== 'review') throw new AppError('conflict', 'only a version in review is returned', { code: 'studio.not_in_review' });
    const returned = (await appVersionRepo.update(db, row.id, {
      state: 'returned', reviewedBy: me.membershipId, reviewedAt: new Date().toISOString(), lockVersion: row.lockVersion + 1,
    }))!;
    await recordEvent(db, me, ctx.correlationId, {
      event: 'app_version_returned', resource: { type: 'app', id: appId }, subjectMembershipId: row.authoredBy, detail: { version },
    });
    return versionView(returned);
  });
}

/** An earlier published definition, revalidated, put up for review as a new version (35.7). */
export async function rollback(deps: StudioDeps, ctx: Context, appId: string, toVersion: number): Promise<AppVersionView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'app.publish' });
  const { held } = await loadApp(deps, me, appId);
  if (!canEdit(held)) throw appNotFound();
  const source = await inTransaction(deps.databases.pool('control'), me.request, (db) => appVersionRepo.findByAppIdAndVersion(db, {
    organisationId: me.organisationId, appId, version: toVersion,
  }), { readOnly: true });
  if (!source || (source.state !== 'published' && source.state !== 'superseded')) {
    throw new AppError('validation', 'only a version that was published is rolled back to', { code: 'studio.rollback_source' });
  }
  const checked = await check(deps, ctx, source.definition as Record<string, unknown>);
  if (checked.findings.length > 0) {
    throw new AppError('validation', 'that version no longer validates, so it cannot be rolled back to', { code: 'studio.version_invalid', details: { findings: checked.findings.length } });
  }
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const app = (await appRepo.findForUpdate(db, appId))!;
    const open = await appVersionRepo.inProgress(db, appId);
    if (open?.state === 'review') throw new AppError('conflict', 'a version is in review: return or publish it first', { code: 'studio.version_in_review' });
    const draft = await appVersionRepo.insert(db, {
      id: uuidv7(), organisationId: me.organisationId, appId, version: await appVersionRepo.nextVersion(db, appId), state: 'draft',
      definition: source.definition as never, schemaVersion: source.schemaVersion, ontologyVersion: source.ontologyVersion,
      markings: await markingsOf(db, checked.references), rolledBackFromVersion: toVersion, authoredBy: me.membershipId,
    });
    await writeReferences(db, me.organisationId, draft.id, checked.references);
    const review = (await appVersionRepo.update(db, draft.id, { state: 'review', lockVersion: draft.lockVersion + 1 }))!;
    await appRepo.update(db, appId, { lockVersion: app.lockVersion + 1 });
    await recordEvent(db, me, ctx.correlationId, {
      event: 'app_rolled_back', resource: { type: 'app', id: appId }, detail: { from_version: toVersion, version: review.version },
    });
    return versionView(review);
  });
}

export async function archive(deps: StudioDeps, ctx: Context, appId: string): Promise<AppView> {
  const me = member(ctx);
  const found = await inTransaction(deps.databases.pool('control'), me.request, (db) => appRepo.findById(db, appId), { readOnly: true });
  if (!found) throw appNotFound();
  // The owner, or app.manage (35.13).
  if (found.ownerMembershipId !== me.membershipId) await demand(deps, ctx, { permission: 'app.manage' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const app = (await appRepo.findForUpdate(db, appId))!;
    if (app.archivedAt !== null) return appView(app, app.ownerMembershipId === me.membershipId ? 'owner' : 'view', undefined);
    const now = new Date().toISOString();
    const shares = await appShareRepo.revokeAll(db, appId, now);
    let withdrawn = 0;
    for (const publication of await appPublicationRepo.liveForApp(db, appId)) {
      await appPublicationRepo.update(db, publication.id, { withdrawnAt: now });
      withdrawn += 1;
    }
    // An archived layout is no longer the type's: the generated default returns (34.6).
    for (const layout of await objectViewLayoutRepo.activeForApp(db, appId)) await objectViewLayoutRepo.update(db, layout.id, { status: 'superseded' });
    const row = (await appRepo.update(db, appId, { archivedAt: now, visibility: 'private', lockVersion: app.lockVersion + 1 }))!;
    await recordEvent(db, me, ctx.correlationId, {
      event: 'app_archived', resource: { type: 'app', id: appId }, detail: { shares_revoked: shares, publications_withdrawn: withdrawn },
    });
    return appView(row, row.ownerMembershipId === me.membershipId ? 'owner' : 'view', undefined);
  });
}

export async function copy(deps: StudioDeps, ctx: Context, appId: string, name: string): Promise<{ app: AppView; draft: AppVersionView }> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'app.create' });
  const { app, held } = await loadApp(deps, me, appId);
  if (held !== 'owner' && held !== 'copy' && held !== 'edit') throw new AppError('forbidden', 'copying needs copy access', { code: 'studio.copy_not_shared' });
  const source = await inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    app.currentVersionId === null ? undefined : appVersionRepo.findById(db, app.currentVersionId), { readOnly: true });
  if (!source) throw new AppError('conflict', 'only a published app is copied', { code: 'studio.not_published' });
  return insertApp(deps, ctx, me, {
    name, description: app.description ?? undefined, requireFullClearance: app.requireFullClearance,
    definition: source.definition as Record<string, unknown>, copiedFrom: app.id,
  });
}

