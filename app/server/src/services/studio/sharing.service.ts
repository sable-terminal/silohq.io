// Sharing and publishing apps (spec 35.8). Sharing is the saved-view model (37.4): the
// owner shares, within their effective sharing policy (workspace's helpers), and a share a
// later, stricter policy forbids stops granting access without being rewritten. edit makes
// a co-editor and goes to named members only. Publishing to a scope needs app.publish there
// and a published version, and is refused under explicit_only and disabled policies; it
// survives the owner's removal. An app's visibility is derived: published while a live
// publication exists, shared while a live permitted share does, private otherwise.

import type { appPublicationView, appShareView } from '../../contracts/studio/app.contract.ts';
import type { AppAccess } from '../../contracts/studio/app.contract.ts';
import type { ShareGrantee } from '../../contracts/workspace/sharing.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { App } from '../../models/workspace/app.model.ts';
import type { AppPublication } from '../../models/workspace/appPublication.model.ts';
import type { AppShare } from '../../models/workspace/appShare.model.ts';
import { membershipRepo, scopeRepo } from '../../repos/iam/index.repo.ts';
import { appPublicationRepo, appRepo, appShareRepo } from '../../repos/workspace/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { effectivePolicy, permitted, type EffectivePolicy } from '../workspace/sharing.service.ts';
import type { z } from 'zod';
import { accessTo } from './apps.service.ts';
import { allowed, appNotFound, demand, member, recordEvent, type Context, type StudioDeps } from './deps.service.ts';

type ShareView = z.infer<typeof appShareView>;
type PublicationView = z.infer<typeof appPublicationView>;

const granteeOf = (share: AppShare): ShareGrantee =>
  share.membershipId !== null ? { kind: 'membership', membershipId: share.membershipId }
    : share.scopeId !== null ? { kind: 'scope', scopeId: share.scopeId } : { kind: 'organisation' };

function stateOf(share: AppShare): Exclude<ShareView['state'], 'forbidden_by_policy'> {
  if (share.revokedAt !== null) return 'revoked';
  if (share.suspendedAt !== null) return 'suspended';
  if (share.expiresAt !== null && Date.parse(share.expiresAt) <= Date.now()) return 'expired';
  return 'live';
}

async function shareView(db: Queryable, share: AppShare, ownerId: string, policy: EffectivePolicy): Promise<ShareView> {
  let state: ShareView['state'] = stateOf(share);
  if (state === 'live' && !await permitted(db, ownerId, granteeOf(share), policy)) state = 'forbidden_by_policy';
  return {
    id: share.id, appId: share.appId, grantee: granteeOf(share), access: share.access, sharedBy: share.sharedBy, sharedAt: share.sharedAt,
    expiresAt: share.expiresAt, revokedAt: share.revokedAt, suspendedAt: share.suspendedAt, state,
  };
}

const publicationView = (p: AppPublication): PublicationView => ({
  id: p.id, appId: p.appId, appVersionId: p.appVersionId, scopeId: p.scopeId, mobileEnabled: p.mobileEnabled, publishedBy: p.publishedBy,
  publishedAt: p.publishedAt, withdrawnAt: p.withdrawnAt,
});

async function refreshVisibility(db: Queryable, app: App): Promise<void> {
  let visibility: App['visibility'] = 'private';
  if ((await appPublicationRepo.liveForApp(db, app.id)).length > 0) visibility = 'published';
  else {
    const policy = await effectivePolicy(db, app.organisationId, app.ownerMembershipId);
    for (const share of await appShareRepo.listForApp(db, app.id)) {
      if (stateOf(share) === 'live' && await permitted(db, app.ownerMembershipId, granteeOf(share), policy)) visibility = 'shared';
    }
  }
  if (visibility !== app.visibility) await appRepo.update(db, app.id, { visibility });
}

async function ownApp(db: Queryable, appId: string, membershipId: string): Promise<App> {
  const app = await appRepo.findForUpdate(db, appId);
  if (!app || app.kind !== 'app' || app.ownerMembershipId !== membershipId) throw appNotFound();
  return app;
}

export async function share(deps: StudioDeps, ctx: Context, appId: string, input: { grantee: ShareGrantee; access: AppAccess; expiresAt?: string | undefined })
  : Promise<ShareView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'app.share' });
  if (input.access === 'edit' && input.grantee.kind !== 'membership') {
    // Open decision 35.13: this release grants edit to named members only.
    throw new AppError('validation', 'edit access is shared with named members only', { code: 'studio.edit_to_member_only' });
  }
  if (input.expiresAt !== undefined && Date.parse(input.expiresAt) <= Date.now()) {
    throw new AppError('validation', 'a share expires in the future', { code: 'studio.share_expiry_past' });
  }
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const app = await ownApp(db, appId, me.membershipId);
    if (app.archivedAt !== null) throw new AppError('conflict', 'an archived app is not shared', { code: 'studio.app_archived' });
    const grantee = input.grantee;
    if (grantee.kind === 'membership') {
      if (grantee.membershipId === me.membershipId) throw new AppError('validation', 'an app is not shared with its owner', { code: 'studio.share_self' });
      const target = await membershipRepo.findById(db, grantee.membershipId);
      if (!target || target.status !== 'active') throw new AppError('validation', 'share with an active member of this organisation', { code: 'studio.share_grantee_unknown' });
    } else if (grantee.kind === 'scope') {
      const scope = await scopeRepo.findById(db, grantee.scopeId);
      if (!scope || scope.archivedAt !== null) throw new AppError('validation', 'no such scope', { code: 'studio.share_grantee_unknown' });
    }
    const policy = await effectivePolicy(db, me.organisationId, me.membershipId);
    if (!await permitted(db, me.membershipId, grantee, policy)) {
      throw new AppError('forbidden', `the sharing policy (${policy.viewSharingPolicy}) does not allow this share`, {
        code: 'studio.share_forbidden', details: { policy: policy.viewSharingPolicy },
      });
    }
    const now = new Date().toISOString();
    const existing = await appShareRepo.findForGrantee(db, app.id, {
      ...(grantee.kind === 'membership' ? { membershipId: grantee.membershipId } : {}),
      ...(grantee.kind === 'scope' ? { scopeId: grantee.scopeId } : {}),
      ...(grantee.kind === 'organisation' ? { organisation: true as const } : {}),
    });
    const row = existing
      ? (await appShareRepo.update(db, existing.id, {
        access: input.access, expiresAt: input.expiresAt ?? null, revokedAt: null, suspendedAt: null, sharedBy: me.membershipId, sharedAt: now,
      }))!
      : await appShareRepo.insert(db, {
        id: uuidv7(), organisationId: me.organisationId, appId: app.id, membershipId: grantee.kind === 'membership' ? grantee.membershipId : null,
        scopeId: grantee.kind === 'scope' ? grantee.scopeId : null, organisationWide: grantee.kind === 'organisation' ? true : null,
        access: input.access, sharedBy: me.membershipId, sharedAt: now, expiresAt: input.expiresAt ?? null,
      });
    await refreshVisibility(db, app);
    await recordEvent(db, me, ctx.correlationId, {
      event: 'app_shared', resource: { type: 'app', id: app.id },
      subjectMembershipId: grantee.kind === 'membership' ? grantee.membershipId : null, scopeId: grantee.kind === 'scope' ? grantee.scopeId : null,
      detail: { share_id: row.id, grantee: grantee.kind, access: input.access, expires: input.expiresAt !== undefined },
    });
    return shareView(db, row, me.membershipId, policy);
  });
}

export async function revoke(deps: StudioDeps, ctx: Context, appId: string, shareId: string): Promise<ShareView> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const app = await ownApp(db, appId, me.membershipId);
    const found = await appShareRepo.findById(db, shareId);
    if (!found || found.appId !== app.id) throw new AppError('not_found', 'no such share', { code: 'studio.share_not_found' });
    const row = found.revokedAt !== null ? found : (await appShareRepo.update(db, found.id, { revokedAt: new Date().toISOString() }))!;
    if (found.revokedAt === null) {
      await refreshVisibility(db, app);
      await recordEvent(db, me, ctx.correlationId, {
        event: 'app_share_revoked', resource: { type: 'app', id: app.id }, subjectMembershipId: found.membershipId, scopeId: found.scopeId,
        detail: { share_id: found.id },
      });
    }
    return shareView(db, row, me.membershipId, await effectivePolicy(db, me.organisationId, me.membershipId));
  });
}

export async function list(deps: StudioDeps, ctx: Context, appId: string): Promise<ShareView[]> {
  const me = member(ctx);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const app = await appRepo.findById(db, appId);
    if (!app || app.kind !== 'app' || app.ownerMembershipId !== me.membershipId) throw appNotFound();
    const policy = await effectivePolicy(db, me.organisationId, me.membershipId);
    const out: ShareView[] = [];
    for (const row of await appShareRepo.listForApp(db, app.id)) out.push(await shareView(db, row, me.membershipId, policy));
    return out;
  }, { readOnly: true });
}

/** Publishing a reviewed version to a scope subtree (35.8): app.publish at the scope. */
export async function publish(deps: StudioDeps, ctx: Context, appId: string, scopeId: string, mobileEnabled: boolean): Promise<PublicationView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'app.publish', scopeId });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const app = await appRepo.findForUpdate(db, appId);
    if (!app || app.kind !== 'app' || app.archivedAt !== null) throw appNotFound();
    if (app.currentVersionId === null) throw new AppError('conflict', 'only a reviewed, published version is published to a scope', { code: 'studio.not_published' });
    const scope = await scopeRepo.findById(db, scopeId);
    if (!scope || scope.archivedAt !== null) throw new AppError('validation', 'no such scope', { code: 'studio.scope_unknown' });
    const policy = await effectivePolicy(db, me.organisationId, app.ownerMembershipId);
    if (policy.viewSharingPolicy === 'explicit_only' || policy.viewSharingPolicy === 'disabled') {
      throw new AppError('forbidden', `scope publication is not permitted under the ${policy.viewSharingPolicy} sharing policy`, {
        code: 'studio.publication_forbidden', details: { policy: policy.viewSharingPolicy },
      });
    }
    const existing = await appPublicationRepo.findLive(db, app.id, scopeId);
    const row = existing
      ? (await appPublicationRepo.update(db, existing.id, { appVersionId: app.currentVersionId, mobileEnabled, publishedBy: me.membershipId }))!
      : await appPublicationRepo.insert(db, {
        id: uuidv7(), organisationId: me.organisationId, appId: app.id, appVersionId: app.currentVersionId, scopeId, mobileEnabled,
        publishedBy: me.membershipId,
      });
    await refreshVisibility(db, app);
    await recordEvent(db, me, ctx.correlationId, {
      event: 'app_published_to_scope', resource: { type: 'app', id: app.id }, scopeId, detail: { publication_id: row.id, mobile: mobileEnabled },
    });
    return publicationView(row);
  });
}

/** By whoever published it, or app.manage at the scope. */
/** An app's live publications: all of them for an editor; otherwise those the caller may withdraw. */
export async function listPublications(deps: StudioDeps, ctx: Context, appId: string): Promise<PublicationView[]> {
  const me = member(ctx);
  const { held, live } = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const app = await appRepo.findById(db, appId);
    if (!app || app.kind !== 'app') throw appNotFound();
    return { held: await accessTo(db, app, me.membershipId), live: await appPublicationRepo.liveForApp(db, app.id) };
  }, { readOnly: true });
  if (held === 'owner' || held === 'edit') return live.map(publicationView);
  const mine: AppPublication[] = [];
  for (const p of live) {
    if (p.publishedBy === me.membershipId || await allowed(deps, ctx, { permission: 'app.manage', scopeId: p.scopeId })) mine.push(p);
  }
  if (held === undefined && mine.length === 0) throw appNotFound();
  return mine.map(publicationView);
}

export async function withdraw(deps: StudioDeps, ctx: Context, appId: string, publicationId: string): Promise<PublicationView> {
  const me = member(ctx);
  const found = await inTransaction(deps.databases.pool('control'), me.request, (db) => appPublicationRepo.findById(db, publicationId), { readOnly: true });
  if (!found || found.appId !== appId) throw new AppError('not_found', 'no such publication', { code: 'studio.publication_not_found' });
  if (found.publishedBy !== me.membershipId && !await allowed(deps, ctx, { permission: 'app.manage', scopeId: found.scopeId })) {
    throw new AppError('forbidden', 'you do not hold app.manage there', { code: 'studio.not_permitted', details: { permission: 'app.manage' } });
  }
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const app = (await appRepo.findForUpdate(db, appId))!;
    const row = found.withdrawnAt !== null ? found : (await appPublicationRepo.update(db, found.id, { withdrawnAt: new Date().toISOString() }))!;
    if (found.withdrawnAt === null) {
      await refreshVisibility(db, app);
      await recordEvent(db, me, ctx.correlationId, {
        event: 'app_publication_withdrawn', resource: { type: 'app', id: appId }, scopeId: found.scopeId, detail: { publication_id: found.id },
      });
    }
    return publicationView(row);
  });
}
