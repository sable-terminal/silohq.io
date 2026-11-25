// Sharing saved views and the policies that limit it (spec 37.4, 37.11).
//
// The owner's effective policy is the strictest of the organisation's ceiling and of every
// scope policy set on a scope containing one of the owner's active scopes. Strictness runs
// open, scope_only, explicit_only, disabled. Under it:
// - open: any member, any scope; the whole organisation only where org-wide sharing is
//   permitted;
// - scope_only: a member who sits in a scope with the owner, or a scope the owner sits in
//   (or one within it); never the organisation;
// - explicit_only: named members only;
// - disabled: nothing.
// The same test runs when a share is written and whenever access is resolved, so a share a
// later, stricter policy forbids stops granting access without being rewritten, and its
// owner sees it as forbidden (the admin's intent stays visible in audit).
//
// Access levels: view, run, copy, each including the ones before it.

import type { ShareGrantee, SharingPolicy, ViewShareView } from '../../contracts/workspace/sharing.contract.ts';
import type { ViewAccess } from '../../contracts/workspace/view.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { SavedView } from '../../models/workspace/savedView.model.ts';
import type { ViewShare } from '../../models/workspace/viewShare.model.ts';
import { membershipRepo, organisationRepo, scopeRepo } from '../../repos/iam/index.repo.ts';
import { savedViewRepo, scopeSharingPolicyRepo, viewShareRepo, viewTransferFlagRepo } from '../../repos/workspace/index.repo.ts';
import { compiledManifestRepo } from '../../repos/ontology/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { demand, member, recordEvent, viewNotFound, type Context, type WorkspaceDeps } from './deps.service.ts';

const STRICTNESS: readonly SharingPolicy[] = ['open', 'scope_only', 'explicit_only', 'disabled'];
export const stricter = (a: SharingPolicy, b: SharingPolicy): SharingPolicy => (STRICTNESS.indexOf(a) >= STRICTNESS.indexOf(b) ? a : b);
const ACCESS_ORDER: readonly ViewAccess[] = ['view', 'run', 'copy'];
export const atLeast = (held: ViewAccess, needed: ViewAccess): boolean => ACCESS_ORDER.indexOf(held) >= ACCESS_ORDER.indexOf(needed);

export interface EffectivePolicy {
  viewSharingPolicy: SharingPolicy;
  orgWideSharingPermitted: boolean;
}

/** A member's effective policy, as the owner of the views they share. */
export async function effectivePolicy(db: Queryable, organisationId: string, ownerId: string): Promise<EffectivePolicy> {
  const organisation = (await organisationRepo.findById(db, organisationId))!;
  let policy = organisation.viewSharingPolicy as SharingPolicy;
  for (const scoped of await scopeSharingPolicyRepo.bindingMember(db, ownerId)) policy = stricter(policy, scoped.viewSharingPolicy as SharingPolicy);
  return { viewSharingPolicy: policy, orgWideSharingPermitted: organisation.orgWideSharingPermitted && policy === 'open' };
}

export function granteeOf(share: ViewShare): ShareGrantee {
  if (share.membershipId !== null) return { kind: 'membership', membershipId: share.membershipId };
  if (share.scopeId !== null) return { kind: 'scope', scopeId: share.scopeId };
  return { kind: 'organisation' };
}

/** Whether the owner's effective policy permits a share to this grantee. */
export async function permitted(db: Queryable, ownerId: string, grantee: ShareGrantee, policy: EffectivePolicy): Promise<boolean> {
  switch (policy.viewSharingPolicy) {
    case 'disabled': return false;
    case 'explicit_only': return grantee.kind === 'membership';
    case 'scope_only':
      if (grantee.kind === 'membership') return viewShareRepo.shareAScope(db, ownerId, grantee.membershipId);
      if (grantee.kind === 'scope') return viewShareRepo.scopeWithinMember(db, ownerId, grantee.scopeId);
      return false;
    case 'open': return grantee.kind !== 'organisation' || policy.orgWideSharingPermitted;
  }
}

/**
 * What a member holds on a view: owner, the best live share that reaches them and that the
 * owner's current policy still permits, or nothing. Archived views are their owner's only.
 */
export async function accessTo(db: Queryable, view: SavedView, membershipId: string): Promise<'owner' | ViewAccess | undefined> {
  if (view.ownerMembershipId === membershipId) return 'owner';
  if (view.archivedAt !== null) return undefined;
  const shares = await viewShareRepo.liveReaching(db, view.id, membershipId);
  if (shares.length === 0) return undefined;
  const policy = await effectivePolicy(db, view.organisationId, view.ownerMembershipId);
  let best: ViewAccess | undefined;
  for (const share of shares) {
    if (!await permitted(db, view.ownerMembershipId, granteeOf(share), policy)) continue;
    const access = share.access as ViewAccess;
    if (best === undefined || atLeast(access, best)) best = access;
  }
  return best;
}

/** Visibility is derived from the live shares the policy permits, never trusted alone (design: saved_views.visibility). */
export async function refreshVisibility(db: Queryable, view: SavedView): Promise<SavedView> {
  const policy = await effectivePolicy(db, view.organisationId, view.ownerMembershipId);
  let visibility: SavedView['visibility'] = 'private';
  for (const share of await viewShareRepo.listForView(db, view.id)) {
    if (stateOf(share) !== 'live' || !await permitted(db, view.ownerMembershipId, granteeOf(share), policy)) continue;
    visibility = share.organisationWide ? 'org_visible' : visibility === 'org_visible' ? visibility : 'shared';
  }
  if (visibility === view.visibility) return view;
  return (await savedViewRepo.update(db, view.id, { visibility }))!;
}

export function stateOf(share: ViewShare): Exclude<ViewShareView['state'], 'forbidden_by_policy'> {
  // Maintenance closes an expired share at its expiry (revoked_at = expires_at): still expired, not revoked.
  if (share.revokedAt !== null) return share.expiresAt !== null && share.revokedAt === share.expiresAt ? 'expired' : 'revoked';
  if (share.suspendedAt !== null) return 'suspended';
  if (share.expiresAt !== null && Date.parse(share.expiresAt) <= Date.now()) return 'expired';
  return 'live';
}

async function shareView(db: Queryable, share: ViewShare, ownerId: string, policy: EffectivePolicy): Promise<ViewShareView> {
  let state: ViewShareView['state'] = stateOf(share);
  if (state === 'live' && !await permitted(db, ownerId, granteeOf(share), policy)) state = 'forbidden_by_policy';
  return {
    id: share.id, viewId: share.savedViewId!, grantee: granteeOf(share), access: share.access, sharedBy: share.sharedBy, sharedAt: share.sharedAt,
    expiresAt: share.expiresAt, revokedAt: share.revokedAt, suspendedAt: share.suspendedAt, state,
  };
}

/** The owner's view, locked; anyone else gets not found. */
async function ownView(db: Queryable, viewId: string, membershipId: string): Promise<SavedView> {
  const view = await savedViewRepo.findForUpdate(db, viewId);
  if (!view || view.ownerMembershipId !== membershipId) throw viewNotFound();
  return view;
}

export interface ShareInput {
  grantee: ShareGrantee;
  access: ViewAccess;
  expiresAt?: string | undefined;
}

export async function share(deps: WorkspaceDeps, ctx: Context, viewId: string, input: ShareInput): Promise<ViewShareView> {
  const me = member(ctx);
  if (input.expiresAt !== undefined && Date.parse(input.expiresAt) <= Date.now()) {
    throw new AppError('validation', 'a share expires in the future', { code: 'workspace.share_expiry_past' });
  }

  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const view = await ownView(db, viewId, me.membershipId);
    if (view.archivedAt !== null) throw new AppError('conflict', 'an archived view is not shared', { code: 'workspace.view_archived' });
    // A shared view always runs against main (spec 25.3): one compiled on an ontology branch is its author's alone.
    if (view.manifestId !== null && (await compiledManifestRepo.branchKindOf(db, view.manifestId) ?? 'main') !== 'main') {
      throw new AppError('conflict', 'a view compiled on an ontology branch is not shared: shared views run against main', { code: 'workspace.view_on_branch' });
    }
    // An inherited view is shared only by reviewing it (spec 37.7).
    if (view.transferredAt !== null && await viewTransferFlagRepo.findOpenForView(db, view.id)) {
      throw new AppError('conflict', 'review this inherited view before sharing it', { code: 'workspace.view_unreviewed' });
    }
    const grantee = input.grantee;
    if (grantee.kind === 'membership') {
      if (grantee.membershipId === me.membershipId) throw new AppError('validation', 'a view is not shared with its owner', { code: 'workspace.share_self' });
      const target = await membershipRepo.findById(db, grantee.membershipId);
      // Only active members of this organisation; sharing never adds anyone to it (spec 37.4).
      if (!target || target.status !== 'active') {
        throw new AppError('validation', 'share with an active member of this organisation', { code: 'workspace.share_grantee_unknown' });
      }
    } else if (grantee.kind === 'scope') {
      const scope = await scopeRepo.findById(db, grantee.scopeId);
      if (!scope || scope.archivedAt !== null) throw new AppError('validation', 'no such scope', { code: 'workspace.share_grantee_unknown' });
    }
    const policy = await effectivePolicy(db, me.organisationId, me.membershipId);
    if (!await permitted(db, me.membershipId, grantee, policy)) {
      throw new AppError('forbidden', `the sharing policy (${policy.viewSharingPolicy}) does not allow this share`, {
        code: 'workspace.share_forbidden', details: { policy: policy.viewSharingPolicy },
      });
    }
    const now = new Date().toISOString();
    const existing = await viewShareRepo.findForGrantee(db, view.id, {
      ...(grantee.kind === 'membership' ? { membershipId: grantee.membershipId } : {}),
      ...(grantee.kind === 'scope' ? { scopeId: grantee.scopeId } : {}),
      ...(grantee.kind === 'organisation' ? { organisation: true as const } : {}),
    });
    // Re-sharing updates rather than duplicating (unique per view and grantee).
    const row = existing
      ? (await viewShareRepo.update(db, existing.id, {
        access: input.access, expiresAt: input.expiresAt ?? null, revokedAt: null, suspendedAt: null, sharedBy: me.membershipId, sharedAt: now,
      }))!
      : await viewShareRepo.insert(db, {
        id: uuidv7(), organisationId: me.organisationId, savedViewId: view.id,
        membershipId: grantee.kind === 'membership' ? grantee.membershipId : null,
        scopeId: grantee.kind === 'scope' ? grantee.scopeId : null,
        organisationWide: grantee.kind === 'organisation' ? true : null,
        access: input.access, sharedBy: me.membershipId, sharedAt: now, expiresAt: input.expiresAt ?? null,
      });
    await refreshVisibility(db, view);
    await recordEvent(db, me, ctx.correlationId, {
      event: 'view_shared', resource: { type: 'view', id: view.id },
      subjectMembershipId: grantee.kind === 'membership' ? grantee.membershipId : null, scopeId: grantee.kind === 'scope' ? grantee.scopeId : null,
      detail: { share_id: row.id, grantee: grantee.kind, access: input.access, expires: input.expiresAt !== undefined },
    });
    return shareView(db, row, me.membershipId, policy);
  });
}

export async function revoke(deps: WorkspaceDeps, ctx: Context, viewId: string, shareId: string): Promise<ViewShareView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const view = await ownView(db, viewId, me.membershipId);
    const found = await viewShareRepo.findById(db, shareId);
    if (!found || found.savedViewId !== view.id) throw new AppError('not_found', 'no such share', { code: 'workspace.share_not_found' });
    const row = found.revokedAt !== null ? found : (await viewShareRepo.update(db, found.id, { revokedAt: new Date().toISOString() }))!;
    if (found.revokedAt === null) {
      await refreshVisibility(db, view);
      await recordEvent(db, me, ctx.correlationId, {
        event: 'view_share_revoked', resource: { type: 'view', id: view.id }, subjectMembershipId: found.membershipId,
        scopeId: found.scopeId, detail: { share_id: found.id },
      });
    }
    return shareView(db, row, me.membershipId, await effectivePolicy(db, me.organisationId, me.membershipId));
  });
}

export async function list(deps: WorkspaceDeps, ctx: Context, viewId: string): Promise<ViewShareView[]> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const view = await savedViewRepo.findById(db, viewId);
    if (!view || view.ownerMembershipId !== me.membershipId) throw viewNotFound();
    const policy = await effectivePolicy(db, me.organisationId, me.membershipId);
    const out: ViewShareView[] = [];
    for (const row of await viewShareRepo.listForView(db, view.id)) out.push(await shareView(db, row, me.membershipId, policy));
    return out;
  }, { readOnly: true });
}

// ----------------------------------------------------------------------------- policies

export interface SharingPolicyView {
  organisation: EffectivePolicy;
  scopes: { scopeId: string; viewSharingPolicy: SharingPolicy; setBy: string; setAt: string }[];
  effective: EffectivePolicy;
}

async function policyView(db: Queryable, organisationId: string, membershipId: string): Promise<SharingPolicyView> {
  const organisation = (await organisationRepo.findById(db, organisationId))!;
  return {
    organisation: { viewSharingPolicy: organisation.viewSharingPolicy as SharingPolicy, orgWideSharingPermitted: organisation.orgWideSharingPermitted },
    scopes: (await scopeSharingPolicyRepo.list(db)).map((p) => ({
      scopeId: p.scopeId, viewSharingPolicy: p.viewSharingPolicy as SharingPolicy, setBy: p.setBy, setAt: p.setAt,
    })),
    effective: await effectivePolicy(db, organisationId, membershipId),
  };
}

export async function readPolicy(deps: WorkspaceDeps, ctx: Context): Promise<SharingPolicyView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, (db) => policyView(db, me.organisationId, me.membershipId), { readOnly: true });
}

/** The organisation ceiling (org.sharing.manage, held organisation-wide by a super admin). */
export async function setOrganisationPolicy(deps: WorkspaceDeps, ctx: Context, input: EffectivePolicy): Promise<SharingPolicyView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'org.sharing.manage', organisationWide: true });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const before = (await organisationRepo.findById(db, me.organisationId))!;
    if (before.viewSharingPolicy !== input.viewSharingPolicy || before.orgWideSharingPermitted !== input.orgWideSharingPermitted) {
      await organisationRepo.update(db, me.organisationId, {
        viewSharingPolicy: input.viewSharingPolicy, orgWideSharingPermitted: input.orgWideSharingPermitted,
      });
      await recordEvent(db, me, ctx.correlationId, {
        event: 'sharing_policy_changed', resource: null,
        detail: { from: before.viewSharingPolicy, to: input.viewSharingPolicy, org_wide: input.orgWideSharingPermitted },
      });
    }
    return policyView(db, me.organisationId, me.membershipId);
  });
}

/** A scope subtree's stricter policy (scope.sharing.narrow at the scope): never looser than its parent's effective policy. */
export async function setScopePolicy(deps: WorkspaceDeps, ctx: Context, scopeId: string, policy: SharingPolicy): Promise<SharingPolicyView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'scope.sharing.narrow', scopeId });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const scope = await scopeRepo.findById(db, scopeId);
    if (!scope || scope.archivedAt !== null) throw new AppError('not_found', 'no such scope', { code: 'workspace.scope_not_found' });
    const organisation = (await organisationRepo.findById(db, me.organisationId))!;
    let parent = organisation.viewSharingPolicy as SharingPolicy;
    for (const above of await scopeSharingPolicyRepo.aboveScope(db, scopeId)) parent = stricter(parent, above.viewSharingPolicy as SharingPolicy);
    if (stricter(policy, parent) !== policy) {
      throw new AppError('validation', `a scope may only narrow sharing: its parent's effective policy is ${parent}`, {
        code: 'workspace.scope_policy_looser', details: { parent },
      });
    }
    const existing = await scopeSharingPolicyRepo.findByKey(db, { organisationId: me.organisationId, scopeId });
    if (existing) {
      await scopeSharingPolicyRepo.update(db, { organisationId: me.organisationId, scopeId }, {
        viewSharingPolicy: policy, setBy: me.membershipId, setAt: new Date().toISOString(),
      });
    } else {
      await scopeSharingPolicyRepo.insert(db, { organisationId: me.organisationId, scopeId, viewSharingPolicy: policy, setBy: me.membershipId });
    }
    await recordEvent(db, me, ctx.correlationId, {
      event: 'scope_sharing_narrowed', resource: null, scopeId, detail: { from: existing?.viewSharingPolicy ?? parent, to: policy },
    });
    return policyView(db, me.organisationId, me.membershipId);
  });
}
