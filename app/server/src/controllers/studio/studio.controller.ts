// studio's endpoints: contracts to the services, nothing more.

import type {
  approveVersion, archiveApp, copyApp, createApp, getApp, getAppVersion, listApps, listAppShares, listTemplates, openApp, previewApp, publishToScope, runAppVariable, evaluateAppExpressions,
  returnVersion, revokeAppShare, rollbackApp, saveDraft, shareApp, submitForReview, withdrawPublication, listPublications,
  abandonAppBranch, compareAppVersions, listAppBranches, mergeAppBranch, openAppBranch, saveAppBranchDraft,
  listAppReleases, promoteAppRelease, rollBackAppRelease, exportAppPackage, importAppPackage,
} from '../../contracts/studio/app.contract.ts';
import * as packages from '../../services/studio/packages.service.ts';
import { getExport } from '../../contracts/files/file.contract.ts';
import * as releases from '../../services/studio/releases.service.ts';
import * as branches from '../../services/studio/branches.service.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import * as apps from '../../services/studio/apps.service.ts';
import type { StudioDeps } from '../../services/studio/deps.service.ts';
import type { createObjectViewLayout, getObjectViewLayout, listObjectViewLayouts } from '../../contracts/studio/layout.contract.ts';
import * as layouts from '../../services/studio/layouts.service.ts';
import * as runtime from '../../services/studio/runtime.service.ts';
import type { listInheritedApps, reviewInheritedApp, transferApps } from '../../contracts/studio/transfer.contract.ts';
import * as transfers from '../../services/studio/transfer.service.ts';
import * as sharing from '../../services/studio/sharing.service.ts';
import { TEMPLATE_CATALOGUE } from '../../services/studio/templates.service.ts';

export function studioController(deps: StudioDeps) {
  /** A keyed create's replay: the app as created, with its first draft. */
  const replayCreated = async (ref: string | undefined, ctx: Parameters<RouteHandlers<typeof createApp>['handle']>[1]) => {
    const { app } = await apps.read(deps, ctx, ref!);
    return { app, draft: await apps.readVersion(deps, ctx, ref!, 1) };
  };
  return {
    transferApps: {
      handle: (input, ctx) => transfers.transferApps(deps, ctx, input.body.membershipId, input.body.reason),
    } satisfies RouteHandlers<typeof transferApps>,
    listInheritedApps: { handle: (_input, ctx) => transfers.inheritedApps(deps, ctx) } satisfies RouteHandlers<typeof listInheritedApps>,
    reviewInheritedApp: {
      handle: (input, ctx) => transfers.reviewInheritedApp(deps, ctx, input.params.flagId, input.body.decision),
    } satisfies RouteHandlers<typeof reviewInheritedApp>,
    createApp: {
      handle: (input, ctx) => apps.create(deps, ctx, input.body),
      resultRef: (out) => out.app.id,
      replay: replayCreated,
    } satisfies RouteHandlers<typeof createApp>,
    listApps: { handle: async (input, ctx) => ({ apps: await apps.list(deps, ctx, input.query.filter, input.query.limit) }) } satisfies RouteHandlers<typeof listApps>,
    getApp: { handle: (input, ctx) => apps.read(deps, ctx, input.params.appId) } satisfies RouteHandlers<typeof getApp>,
    getAppVersion: {
      handle: (input, ctx) => apps.readVersion(deps, ctx, input.params.appId, input.params.version),
    } satisfies RouteHandlers<typeof getAppVersion>,
    saveDraft: {
      handle: (input, ctx) => apps.saveDraft(deps, ctx, input.params.appId, input.body.definition, input.body.lockVersion),
    } satisfies RouteHandlers<typeof saveDraft>,
    submitForReview: {
      handle: (input, ctx) => apps.submit(deps, ctx, input.params.appId, input.params.version, input.body.lockVersion),
    } satisfies RouteHandlers<typeof submitForReview>,
    approveVersion: {
      handle: (input, ctx) => apps.approve(deps, ctx, input.params.appId, input.params.version, input.body.lockVersion, input.body.scopeId, input.body.stages),
    } satisfies RouteHandlers<typeof approveVersion>,
    returnVersion: {
      handle: (input, ctx) => apps.returnToAuthor(deps, ctx, input.params.appId, input.params.version, input.body.lockVersion),
    } satisfies RouteHandlers<typeof returnVersion>,
    rollbackApp: { handle: (input, ctx) => apps.rollback(deps, ctx, input.params.appId, input.body.toVersion) } satisfies RouteHandlers<typeof rollbackApp>,
    listAppBranches: { handle: (input, ctx) => branches.listBranches(deps, ctx, input.params.appId) } satisfies RouteHandlers<typeof listAppBranches>,
    openAppBranch: { handle: (input, ctx) => branches.openBranch(deps, ctx, input.params.appId, input.body) } satisfies RouteHandlers<typeof openAppBranch>,
    saveAppBranchDraft: {
      handle: (input, ctx) => branches.saveBranchDraft(deps, ctx, input.params.appId, input.params.branchId, input.body.definition, input.body.lockVersion),
    } satisfies RouteHandlers<typeof saveAppBranchDraft>,
    compareAppVersions: { handle: (input, ctx) => branches.compareVersions(deps, ctx, input.params.appId, input.query.from, input.query.to) } satisfies RouteHandlers<typeof compareAppVersions>,
    mergeAppBranch: { handle: (input, ctx) => branches.mergeBranch(deps, ctx, input.params.appId, input.params.branchId, input.body) as never } satisfies RouteHandlers<typeof mergeAppBranch>,
    exportAppPackage: {
      handle: (input, ctx) => packages.exportPackage(deps, ctx, input.params.appId, input.body),
      resultRef: (out) => `${out.file.id}.${out.references}.${out.unresolved}`,
      // A retry: the file the first request made, as its maker sees it now.
      async replay(ref, ctx) {
        const [fileId, references, unresolved] = (ref ?? '').split('.');
        const file = await deps.services.call(getExport, { params: { fileId: fileId! } }, { request: ctx.request, correlationId: ctx.correlationId });
        return { file, references: Number(references ?? 0), unresolved: Number(unresolved ?? 0) };
      },
    } satisfies RouteHandlers<typeof exportAppPackage>,
    importAppPackage: {
      handle: (input, ctx) => packages.importPackage(deps, ctx, input.body),
      resultRef: (out) => `${out.app.id}.${out.draft.version}.${out.mapped}`,
      // A retry: the app and draft the first made; what was not found is in the draft's findings.
      async replay(ref, ctx) {
        const [appId, version, mapped] = (ref ?? '').split('.');
        const { app } = await apps.read(deps, ctx, appId!);
        return { app, draft: await apps.readVersion(deps, ctx, appId!, Number(version)), mapped: Number(mapped ?? 0), unmapped: [] };
      },
    } satisfies RouteHandlers<typeof importAppPackage>,
    listAppReleases: { handle: (input, ctx) => releases.listReleases(deps, ctx, input.params.appId) } satisfies RouteHandlers<typeof listAppReleases>,
    promoteAppRelease: { handle: (input, ctx) => releases.promote(deps, ctx, input.params.appId, input.params.releaseId, input.body.lockVersion) } satisfies RouteHandlers<typeof promoteAppRelease>,
    rollBackAppRelease: { handle: (input, ctx) => releases.rollBack(deps, ctx, input.params.appId, input.params.releaseId, input.body.lockVersion) } satisfies RouteHandlers<typeof rollBackAppRelease>,
    abandonAppBranch: { handle: (input, ctx) => branches.abandonBranch(deps, ctx, input.params.appId, input.params.branchId, input.body.lockVersion) } satisfies RouteHandlers<typeof abandonAppBranch>,
    archiveApp: { handle: (input, ctx) => apps.archive(deps, ctx, input.params.appId) } satisfies RouteHandlers<typeof archiveApp>,
    copyApp: {
      handle: (input, ctx) => apps.copy(deps, ctx, input.params.appId, input.body.name),
      resultRef: (out) => out.app.id,
      replay: replayCreated,
    } satisfies RouteHandlers<typeof copyApp>,
    openApp: { handle: (input, ctx) => runtime.open(deps, ctx, input.params.appId, input.query.version) } satisfies RouteHandlers<typeof openApp>,
    runAppVariable: {
      handle: ({ params, body }, ctx) => runtime.runVariable(deps, ctx, params.appId, params.variable, { version: body.version, select: body.select, parameters: body.parameters }),
    } satisfies RouteHandlers<typeof runAppVariable>,
    evaluateAppExpressions: {
      handle: ({ params, body }, ctx) => runtime.evaluateExpressions(deps, ctx, params.appId, { version: body.version, values: body.values }),
    } satisfies RouteHandlers<typeof evaluateAppExpressions>,
    shareApp: { handle: (input, ctx) => sharing.share(deps, ctx, input.params.appId, input.body) } satisfies RouteHandlers<typeof shareApp>,
    revokeAppShare: {
      handle: (input, ctx) => sharing.revoke(deps, ctx, input.params.appId, input.params.shareId),
    } satisfies RouteHandlers<typeof revokeAppShare>,
    listAppShares: { handle: async (input, ctx) => ({ shares: await sharing.list(deps, ctx, input.params.appId) }) } satisfies RouteHandlers<typeof listAppShares>,
    publishToScope: {
      handle: (input, ctx) => sharing.publish(deps, ctx, input.params.appId, input.body.scopeId, input.body.mobileEnabled),
    } satisfies RouteHandlers<typeof publishToScope>,
    listPublications: {
      handle: async (input, ctx) => ({ publications: await sharing.listPublications(deps, ctx, input.params.appId) }),
    } satisfies RouteHandlers<typeof listPublications>,
    withdrawPublication: {
      handle: (input, ctx) => sharing.withdraw(deps, ctx, input.params.appId, input.params.publicationId),
    } satisfies RouteHandlers<typeof withdrawPublication>,
    previewApp: { handle: (input, ctx) => runtime.preview(deps, ctx, input.body) } satisfies RouteHandlers<typeof previewApp>,
    createObjectViewLayout: {
      handle: (input, ctx) => layouts.createLayout(deps, ctx, input.body),
      resultRef: (out) => out.app.id,
      replay: replayCreated,
    } satisfies RouteHandlers<typeof createObjectViewLayout>,
    listObjectViewLayouts: { handle: (_input, ctx) => layouts.listLayouts(deps, ctx) } satisfies RouteHandlers<typeof listObjectViewLayouts>,
    getObjectViewLayout: {
      handle: (input, ctx) => layouts.getLayout(deps, ctx, input.params.objectTypeId),
    } satisfies RouteHandlers<typeof getObjectViewLayout>,
    listTemplates: {
      handle: async () => ({ templates: TEMPLATE_CATALOGUE.map((t) => ({ name: t.name, description: t.description, requires: [...t.requires] })) }),
    } satisfies RouteHandlers<typeof listTemplates>,
  };
}
