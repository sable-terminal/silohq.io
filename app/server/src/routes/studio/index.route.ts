// studio (spec 35): app definitions as data, validated on every save and every publish
// against the bound ontology version; drafts, review by someone other than the author,
// publication, rollback and archive; sharing on the saved-view model and publication to
// scopes; structural templates; and opening an app under the viewer's own permissions.
// There is no custom code anywhere in an app.

import {
  abandonAppBranch, compareAppVersions, listAppBranches, mergeAppBranch, openAppBranch, saveAppBranchDraft,
  listAppReleases, promoteAppRelease, rollBackAppRelease, exportAppPackage, importAppPackage,
  approveVersion, archiveApp, copyApp, createApp, getApp, getAppVersion, listApps, listAppShares, listTemplates, openApp, previewApp, publishToScope, returnVersion, runAppVariable, evaluateAppExpressions, appChartSteps, revokeAppShare, rollbackApp, saveDraft, shareApp, submitForReview, withdrawPublication, listPublications,
} from '../../contracts/studio/app.contract.ts';
import { createObjectViewLayout, getObjectViewLayout, listObjectViewLayouts } from '../../contracts/studio/layout.contract.ts';
import { studioController } from '../../controllers/studio/studio.controller.ts';
import { listInheritedApps, reviewInheritedApp, transferApps } from '../../contracts/studio/transfer.contract.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';

export const service = defineService({
  name: 'studio',
  // redis-data: idempotency keys of the keyed operations.
  needs: { postgres: ['control'], redis: ['data'] },
  create(deps) {
    const c = studioController({ databases: deps.databases, services: deps.services, logger: deps.logger });
    return {
      routes: [
        route(transferApps, c.transferApps), route(listInheritedApps, c.listInheritedApps), route(reviewInheritedApp, c.reviewInheritedApp),
        route(createApp, c.createApp), route(listApps, c.listApps), route(getApp, c.getApp), route(getAppVersion, c.getAppVersion),
        route(saveDraft, c.saveDraft), route(submitForReview, c.submitForReview), route(approveVersion, c.approveVersion),
        route(listAppBranches, c.listAppBranches), route(openAppBranch, c.openAppBranch), route(saveAppBranchDraft, c.saveAppBranchDraft),
        route(compareAppVersions, c.compareAppVersions), route(mergeAppBranch, c.mergeAppBranch), route(abandonAppBranch, c.abandonAppBranch),
        route(exportAppPackage, c.exportAppPackage), route(importAppPackage, c.importAppPackage),
        route(listAppReleases, c.listAppReleases), route(promoteAppRelease, c.promoteAppRelease), route(rollBackAppRelease, c.rollBackAppRelease),
        route(returnVersion, c.returnVersion), route(rollbackApp, c.rollbackApp), route(archiveApp, c.archiveApp), route(copyApp, c.copyApp),
        route(openApp, c.openApp), route(runAppVariable, c.runAppVariable), route(evaluateAppExpressions, c.evaluateAppExpressions), route(appChartSteps, c.appChartSteps), route(shareApp, c.shareApp), route(revokeAppShare, c.revokeAppShare), route(listAppShares, c.listAppShares),
        route(publishToScope, c.publishToScope), route(withdrawPublication, c.withdrawPublication), route(listPublications, c.listPublications), route(listTemplates, c.listTemplates), route(previewApp, c.previewApp),
        route(createObjectViewLayout, c.createObjectViewLayout), route(getObjectViewLayout, c.getObjectViewLayout), route(listObjectViewLayouts, c.listObjectViewLayouts),
      ],
    };
  },
});
