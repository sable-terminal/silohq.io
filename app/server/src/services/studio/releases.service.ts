// Staged releases (D230): a version approved with stages reaches people scope by scope. It is
// published at approval like any version, and the app's latest release decides who opens it: a
// member of a released stage's scopes, or of a scope below one, opens the new version; everyone
// else the version before, until the last stage is released and the release completes. Rolled
// back, everyone opens the version before again, and the new one stays published for its editors,
// who always open the newest. One release rolls out at a time: a new version is not approved
// while one does. Releasing a stage needs app.publish in each of its scopes.

import type { AppReleaseView } from '../../contracts/studio/app.contract.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { App } from '../../models/workspace/app.model.ts';
import type { AppRelease } from '../../models/workspace/appRelease.model.ts';
import { appReleaseRepo, appReleaseStageRepo, appRepo, appVersionRepo } from '../../repos/workspace/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { accessTo, type Held } from './apps.service.ts';
import { appNotFound, demand, member, recordEvent, type Context, type Member, type StudioDeps } from './deps.service.ts';

const stale = () => new AppError('conflict', 'the release changed since you read it', { code: 'studio.release_stale' });

export async function releaseView(db: Queryable, r: AppRelease): Promise<AppReleaseView> {
  const number = async (id: string) => (await appVersionRepo.findById(db, id))?.version ?? 0;
  const stages = await appReleaseStageRepo.listForRelease(db, r.id);
  return {
    id: r.id, appId: r.appId, toVersion: await number(r.toVersionId), fromVersion: await number(r.fromVersionId), status: r.status,
    stages: stages.map((s) => ({ ordinal: s.ordinal, scopeIds: s.scopeIds, releasedAt: s.releasedAt, releasedBy: s.releasedBy })),
    startedBy: r.startedBy, startedAt: r.startedAt, closedAt: r.closedAt, lockVersion: r.lockVersion,
  };
}

/** The version a viewer opens when none is named: by the app's latest release, the current one otherwise. */
export async function servedVersionId(db: Queryable, app: App, membershipId: string, held: Held): Promise<string | null> {
  const release = await appReleaseRepo.latest(db, app.id);
  if (release === undefined || release.toVersionId !== app.currentVersionId || release.status === 'complete') return app.currentVersionId;
  if (held === 'owner' || held === 'edit') return release.toVersionId;
  if (release.status === 'rolled_back') return release.fromVersionId;
  return await appReleaseRepo.reaches(db, release.id, membershipId) ? release.toVersionId : release.fromVersionId;
}

/** What everyone outside a new release keeps: the version before, or what a rolled-back release left them on. */
export async function generalVersionId(db: Queryable, app: App): Promise<string | null> {
  const release = await appReleaseRepo.latest(db, app.id);
  if (release !== undefined && release.status === 'rolled_back' && release.toVersionId === app.currentVersionId) return release.fromVersionId;
  return app.currentVersionId;
}

/** Refuses an approval while a release rolls out. */
export async function assertNoRollout(db: Queryable, appId: string): Promise<void> {
  const release = await appReleaseRepo.latest(db, appId);
  if (release?.status === 'rolling_out') {
    throw new AppError('conflict', 'a release of this app is rolling out: complete it or roll it back first', { code: 'studio.release_in_progress' });
  }
}

/** The releaser holds app.publish in every scope of the stages named. */
export async function checkStages(deps: StudioDeps, ctx: Context, stages: readonly { scopeIds: string[] }[]): Promise<void> {
  for (const scopeId of new Set(stages.flatMap((s) => s.scopeIds))) await demand(deps, ctx, { permission: 'app.publish', scopeId });
}

/** A release begun inside the approval's transaction, its first stage released. */
export async function startRelease(db: Queryable, who: Member, correlationId: string, input: {
  appId: string; toVersionId: string; fromVersionId: string; stages: readonly { scopeIds: string[] }[];
}): Promise<AppRelease> {
  const now = new Date().toISOString();
  const release = await appReleaseRepo.insert(db, {
    id: uuidv7(), organisationId: who.organisationId, appId: input.appId, toVersionId: input.toVersionId, fromVersionId: input.fromVersionId,
    status: 'rolling_out', startedBy: who.membershipId,
  });
  for (const [i, stage] of input.stages.entries()) {
    await appReleaseStageRepo.insert(db, {
      id: uuidv7(), organisationId: who.organisationId, releaseId: release.id, ordinal: i + 1, scopeIds: [...new Set(stage.scopeIds)],
      releasedBy: i === 0 ? who.membershipId : null, releasedAt: i === 0 ? now : null,
    });
  }
  await recordEvent(db, who, correlationId, {
    event: 'app_release_started', resource: { type: 'app', id: input.appId },
    detail: { release_id: release.id, stages: input.stages.length, first_scopes: input.stages[0]!.scopeIds.length },
  });
  return release;
}

/** Releases are read by the app's editors and by holders of app.publish. */
async function readable(deps: StudioDeps, ctx: Context, appId: string): Promise<App> {
  const me = member(ctx);
  const found = await inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const app = await appRepo.findById(db, appId);
    if (!app || app.kind !== 'app') return undefined;
    const held = await accessTo(db, app, me.membershipId);
    return { app, editor: held === 'owner' || held === 'edit' };
  }, { readOnly: true });
  if (found === undefined) throw appNotFound();
  if (!found.editor) await demand(deps, ctx, { permission: 'app.publish' });
  return found.app;
}

export async function listReleases(deps: StudioDeps, ctx: Context, appId: string): Promise<{ releases: AppReleaseView[] }> {
  const me = member(ctx);
  await readable(deps, ctx, appId);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const releases: AppReleaseView[] = [];
    for (const r of await appReleaseRepo.listForApp(db, appId)) releases.push(await releaseView(db, r));
    return { releases };
  }, { readOnly: true });
}

async function rolling(db: Queryable, appId: string, releaseId: string, lockVersion: number): Promise<AppRelease> {
  const release = await appReleaseRepo.findForUpdate(db, releaseId);
  if (!release || release.appId !== appId) throw new AppError('not_found', 'no such release', { code: 'studio.release_not_found' });
  if (release.status !== 'rolling_out') throw new AppError('conflict', `the release is ${release.status === 'complete' ? 'complete' : 'rolled back'}`, { code: 'studio.release_closed' });
  if (release.lockVersion !== lockVersion) throw stale();
  return release;
}

export async function promote(deps: StudioDeps, ctx: Context, appId: string, releaseId: string, lockVersion: number): Promise<AppReleaseView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'app.publish' });
  const next = await inTransaction(deps.databases.pool('control'), me.request, async (db) =>
    (await appReleaseStageRepo.listForRelease(db, releaseId)).find((s) => s.releasedAt === null), { readOnly: true });
  if (next !== undefined) await checkStages(deps, ctx, [next]);
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const release = await rolling(db, appId, releaseId, lockVersion);
    const stages = await appReleaseStageRepo.listForRelease(db, releaseId);
    const pending = stages.find((s) => s.releasedAt === null);
    const now = new Date().toISOString();
    if (pending !== undefined) {
      await appReleaseStageRepo.update(db, pending.id, { releasedAt: now, releasedBy: me.membershipId });
      await recordEvent(db, me, ctx.correlationId, {
        event: 'app_release_stage_released', resource: { type: 'app', id: appId }, detail: { release_id: releaseId, ordinal: pending.ordinal, scopes: pending.scopeIds.length },
      });
    }
    const last = pending === undefined || !stages.some((s) => s.releasedAt === null && s.id !== pending.id);
    const updated = (await appReleaseRepo.update(db, releaseId, {
      ...(last ? { status: 'complete' as const, closedAt: now, closedBy: me.membershipId } : {}), lockVersion: release.lockVersion + 1,
    }))!;
    if (last) {
      await recordEvent(db, me, ctx.correlationId, { event: 'app_release_completed', resource: { type: 'app', id: appId }, detail: { release_id: releaseId, stages: stages.length } });
    }
    return releaseView(db, updated);
  });
}

export async function rollBack(deps: StudioDeps, ctx: Context, appId: string, releaseId: string, lockVersion: number): Promise<AppReleaseView> {
  const me = member(ctx);
  await demand(deps, ctx, { permission: 'app.publish' });
  return inTransaction(deps.databases.pool('control'), me.request, async (db) => {
    const release = await rolling(db, appId, releaseId, lockVersion);
    const updated = (await appReleaseRepo.update(db, releaseId, {
      status: 'rolled_back', closedAt: new Date().toISOString(), closedBy: me.membershipId, lockVersion: release.lockVersion + 1,
    }))!;
    const released = (await appReleaseStageRepo.listForRelease(db, releaseId)).filter((s) => s.releasedAt !== null).length;
    await recordEvent(db, me, ctx.correlationId, {
      event: 'app_release_rolled_back', resource: { type: 'app', id: appId }, detail: { release_id: releaseId, stages_released: released },
    });
    return releaseView(db, updated);
  });
}
