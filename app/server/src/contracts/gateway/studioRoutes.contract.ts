// Studio in the product (spec 35): building, reviewing, sharing, publishing and opening apps.
//
// A member's own apps, and apps shared or published to them, need no permission of their
// own (ownership, a share or a publication is the authority): those are ownRecords routes,
// and studio decides access per app for the membership the gateway puts in the context.
// Creating and copying need app.create, sharing app.share, review and rollback app.publish
// (at the scope named, where one is), publishing to a scope app.publish there; studio
// decides again.

import * as transfer from '../studio/transfer.contract.ts';
import * as ap from '../studio/app.contract.ts';
import * as ly from '../studio/layout.contract.ts';
import { definePublicRoute, type PublicRoute } from './publicRoute.contract.ts';

const publish = { permission: 'app.publish' };

// Apps inherited from a removed member (37.7): the receiving admin's own review queue.
export const listInheritedApps = definePublicRoute({
    name: 'listInheritedApps', method: 'GET', path: '/studio/inherited-apps', session: 'complete', ownRecords: true,
    response: transfer.listInheritedApps.response, forwards: transfer.listInheritedApps, call: () => ({}), reply: (output) => output,
  });

export const reviewInheritedApp = definePublicRoute({
    name: 'reviewInheritedApp', method: 'POST', path: '/studio/inherited-apps/:flagId/review', session: 'complete', ownRecords: true,
    params: transfer.reviewInheritedApp.params, body: transfer.reviewInheritedApp.body, response: transfer.reviewInheritedApp.response,
    forwards: transfer.reviewInheritedApp, call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

// Object view layouts (34.6): a custom layout's draft (app.create), and the layout a type opens with (ontology.view).
export const createObjectViewLayout = definePublicRoute({
    name: 'createObjectViewLayout', method: 'POST', path: '/studio/object-view-layouts', session: 'complete', permission: { permission: 'app.create' },
    body: ly.createObjectViewLayout.body, response: ly.createObjectViewLayout.response, status: 201, forwards: ly.createObjectViewLayout,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const listObjectViewLayouts = definePublicRoute({
    name: 'listObjectViewLayouts', method: 'GET', path: '/studio/object-view-layouts', session: 'complete', permission: { permission: 'ontology.view' },
    response: ly.listObjectViewLayouts.response, forwards: ly.listObjectViewLayouts,
    call: () => ({}), reply: (output) => output,
  });

export const getObjectViewLayout = definePublicRoute({
    name: 'getObjectViewLayout', method: 'GET', path: '/studio/object-view-layouts/:objectTypeId', session: 'complete', permission: { permission: 'ontology.view' },
    params: ly.getObjectViewLayout.params, response: ly.getObjectViewLayout.response, forwards: ly.getObjectViewLayout,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const previewApp = definePublicRoute({
    name: 'previewApp', reads: true, method: 'POST', path: '/studio/app-previews', session: 'complete', permission: { permission: 'app.create' },
    body: ap.previewApp.body, response: ap.previewApp.response, forwards: ap.previewApp,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const createApp = definePublicRoute({
    name: 'createApp', method: 'POST', path: '/studio/apps', session: 'complete', permission: { permission: 'app.create' },
    body: ap.createApp.body, response: ap.createApp.response, status: 201, forwards: ap.createApp,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const listApps = definePublicRoute({
    name: 'listApps', method: 'GET', path: '/studio/apps', session: 'complete', ownRecords: true,
    query: ap.listApps.query, response: ap.listApps.response, forwards: ap.listApps, call: (input) => ({ query: input.query }), reply: (output) => output,
  });

export const getApp = definePublicRoute({
    name: 'getApp', method: 'GET', path: '/studio/apps/:appId', session: 'complete', ownRecords: true,
    params: ap.getApp.params, response: ap.getApp.response, forwards: ap.getApp, call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const getAppVersion = definePublicRoute({
    name: 'getAppVersion', method: 'GET', path: '/studio/apps/:appId/versions/:version', session: 'complete', ownRecords: true,
    params: ap.getAppVersion.params, response: ap.getAppVersion.response, forwards: ap.getAppVersion,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const saveAppDraft = definePublicRoute({
    name: 'saveAppDraft', method: 'PUT', path: '/studio/apps/:appId/draft', session: 'complete', ownRecords: true,
    params: ap.saveDraft.params, body: ap.saveDraft.body, response: ap.saveDraft.response, forwards: ap.saveDraft,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const submitAppForReview = definePublicRoute({
    name: 'submitAppForReview', method: 'POST', path: '/studio/apps/:appId/versions/:version/submit', session: 'complete', ownRecords: true,
    params: ap.submitForReview.params, body: ap.submitForReview.body, response: ap.submitForReview.response, forwards: ap.submitForReview,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const approveAppVersion = definePublicRoute({
    name: 'approveAppVersion', method: 'POST', path: '/studio/apps/:appId/versions/:version/approve', session: 'complete',
    permission: { permission: 'app.publish', scopeId: (input) => input.body.scopeId },
    params: ap.approveVersion.params, body: ap.approveVersion.body, response: ap.approveVersion.response, forwards: ap.approveVersion,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const returnAppVersion = definePublicRoute({
    name: 'returnAppVersion', method: 'POST', path: '/studio/apps/:appId/versions/:version/return', session: 'complete', permission: publish,
    params: ap.returnVersion.params, body: ap.returnVersion.body, response: ap.returnVersion.response, forwards: ap.returnVersion,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const rollbackApp = definePublicRoute({
    name: 'rollbackApp', method: 'POST', path: '/studio/apps/:appId/rollbacks', session: 'complete', permission: publish,
    params: ap.rollbackApp.params, body: ap.rollbackApp.body, response: ap.rollbackApp.response, status: 201, forwards: ap.rollbackApp,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const archiveApp = definePublicRoute({
    name: 'archiveApp', method: 'POST', path: '/studio/apps/:appId/archive', session: 'complete', ownRecords: true,
    params: ap.archiveApp.params, response: ap.archiveApp.response, forwards: ap.archiveApp, call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const copyApp = definePublicRoute({
    name: 'copyApp', method: 'POST', path: '/studio/apps/:appId/copies', session: 'complete', permission: { permission: 'app.create' },
    params: ap.copyApp.params, body: ap.copyApp.body, response: ap.copyApp.response, status: 201, forwards: ap.copyApp,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const openApp = definePublicRoute({
    name: 'openApp', method: 'GET', path: '/studio/apps/:appId/open', session: 'complete', ownRecords: true,
    params: ap.openApp.params, query: ap.openApp.query, response: ap.openApp.response, forwards: ap.openApp,
    call: (input) => ({ params: input.params, query: input.query }), reply: (output) => output,
  });

export const runAppVariable = definePublicRoute({
    name: 'runAppVariable', reads: true, method: 'POST', path: '/studio/apps/:appId/variables/:variable/runs', session: 'complete', ownRecords: true,
    params: ap.runAppVariable.params, body: ap.runAppVariable.body, response: ap.runAppVariable.response, forwards: ap.runAppVariable,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const evaluateAppExpressions = definePublicRoute({
    name: 'evaluateAppExpressions', reads: true, method: 'POST', path: '/studio/apps/:appId/expressions', session: 'complete', ownRecords: true,
    params: ap.evaluateAppExpressions.params, body: ap.evaluateAppExpressions.body, response: ap.evaluateAppExpressions.response, forwards: ap.evaluateAppExpressions,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const shareApp = definePublicRoute({
    name: 'shareApp', method: 'PUT', path: '/studio/apps/:appId/shares', session: 'complete', permission: { permission: 'app.share' },
    params: ap.shareApp.params, body: ap.shareApp.body, response: ap.shareApp.response, forwards: ap.shareApp,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const revokeAppShare = definePublicRoute({
    name: 'revokeAppShare', method: 'POST', path: '/studio/apps/:appId/shares/:shareId/revoke', session: 'complete', ownRecords: true,
    params: ap.revokeAppShare.params, response: ap.revokeAppShare.response, forwards: ap.revokeAppShare,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const listAppShares = definePublicRoute({
    name: 'listAppShares', method: 'GET', path: '/studio/apps/:appId/shares', session: 'complete', ownRecords: true,
    params: ap.listAppShares.params, response: ap.listAppShares.response, forwards: ap.listAppShares,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const publishAppToScope = definePublicRoute({
    name: 'publishAppToScope', method: 'POST', path: '/studio/apps/:appId/publications', session: 'complete',
    permission: { permission: 'app.publish', scopeId: (input) => input.body.scopeId },
    params: ap.publishToScope.params, body: ap.publishToScope.body, response: ap.publishToScope.response, status: 201, forwards: ap.publishToScope,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

export const listAppPublications = definePublicRoute({
    name: 'listAppPublications', method: 'GET', path: '/studio/apps/:appId/publications', session: 'complete', ownRecords: true,
    params: ap.listPublications.params, response: ap.listPublications.response, forwards: ap.listPublications,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const withdrawAppPublication = definePublicRoute({
    name: 'withdrawAppPublication', method: 'POST', path: '/studio/apps/:appId/publications/:publicationId/withdraw', session: 'complete',
    ownRecords: true, params: ap.withdrawPublication.params, response: ap.withdrawPublication.response, forwards: ap.withdrawPublication,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });

export const listAppTemplates = definePublicRoute({
    name: 'listAppTemplates', method: 'GET', path: '/studio/templates', session: 'complete', permission: { permission: 'app.create' },
    response: ap.listTemplates.response, forwards: ap.listTemplates, call: () => ({}), reply: (output) => output,
  });

// App branches (D229): an editor's (owner or edit share); studio checks the access.
export const listAppBranches = definePublicRoute({
    name: 'listAppBranches', method: 'GET', path: '/studio/apps/:appId/branches', session: 'complete', ownRecords: true,
    params: ap.listAppBranches.params, response: ap.listAppBranches.response, forwards: ap.listAppBranches,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });
export const openAppBranch = definePublicRoute({
    name: 'openAppBranch', method: 'POST', path: '/studio/apps/:appId/branches', session: 'complete', ownRecords: true,
    params: ap.openAppBranch.params, body: ap.openAppBranch.body, response: ap.openAppBranch.response, status: 201, forwards: ap.openAppBranch,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });
export const saveAppBranchDraft = definePublicRoute({
    name: 'saveAppBranchDraft', method: 'PUT', path: '/studio/apps/:appId/branches/:branchId/draft', session: 'complete', ownRecords: true,
    params: ap.saveAppBranchDraft.params, body: ap.saveAppBranchDraft.body, response: ap.saveAppBranchDraft.response, forwards: ap.saveAppBranchDraft,
    maxBodyBytes: 1024 * 1024,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });
export const compareAppVersions = definePublicRoute({
    name: 'compareAppVersions', method: 'GET', path: '/studio/apps/:appId/comparisons', session: 'complete', ownRecords: true,
    params: ap.compareAppVersions.params, query: ap.compareAppVersions.query, response: ap.compareAppVersions.response, forwards: ap.compareAppVersions,
    call: (input) => ({ params: input.params, query: input.query }), reply: (output) => output,
  });
export const mergeAppBranch = definePublicRoute({
    name: 'mergeAppBranch', method: 'POST', path: '/studio/apps/:appId/branches/:branchId/merge', session: 'complete', ownRecords: true,
    params: ap.mergeAppBranch.params, body: ap.mergeAppBranch.body, response: ap.mergeAppBranch.response, forwards: ap.mergeAppBranch,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });
export const abandonAppBranch = definePublicRoute({
    name: 'abandonAppBranch', method: 'POST', path: '/studio/apps/:appId/branches/:branchId/abandon', session: 'complete', ownRecords: true,
    params: ap.abandonAppBranch.params, body: ap.abandonAppBranch.body, response: ap.abandonAppBranch.response, forwards: ap.abandonAppBranch,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

// Staged releases (D230): read by the app's editors and holders of app.publish; released and rolled back under app.publish.
export const listAppReleases = definePublicRoute({
    name: 'listAppReleases', method: 'GET', path: '/studio/apps/:appId/releases', session: 'complete', ownRecords: true,
    params: ap.listAppReleases.params, response: ap.listAppReleases.response, forwards: ap.listAppReleases,
    call: (input) => ({ params: input.params }), reply: (output) => output,
  });
export const promoteAppRelease = definePublicRoute({
    name: 'promoteAppRelease', method: 'POST', path: '/studio/apps/:appId/releases/:releaseId/promote', session: 'complete', permission: publish,
    params: ap.promoteAppRelease.params, body: ap.promoteAppRelease.body, response: ap.promoteAppRelease.response, forwards: ap.promoteAppRelease,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });
export const rollBackAppRelease = definePublicRoute({
    name: 'rollBackAppRelease', method: 'POST', path: '/studio/apps/:appId/releases/:releaseId/roll-back', session: 'complete', permission: publish,
    params: ap.rollBackAppRelease.params, body: ap.rollBackAppRelease.body, response: ap.rollBackAppRelease.response, forwards: ap.rollBackAppRelease,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });

// App packages (D231): exported into Files (file.export, decided by Files) by an editor; imported under app.create.
export const exportAppPackage = definePublicRoute({
    name: 'exportAppPackage', method: 'POST', path: '/studio/apps/:appId/packages', session: 'complete', permission: { permission: 'file.export' },
    params: ap.exportAppPackage.params, body: ap.exportAppPackage.body, response: ap.exportAppPackage.response, status: 201, forwards: ap.exportAppPackage,
    call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
  });
export const importAppPackage = definePublicRoute({
    name: 'importAppPackage', method: 'POST', path: '/studio/app-packages', session: 'complete', ownRecords: true,
    body: ap.importAppPackage.body, response: ap.importAppPackage.response, status: 201, forwards: ap.importAppPackage, maxBodyBytes: 2 * 1024 * 1024,
    call: (input) => ({ body: input.body }), reply: (output) => output,
  });

export const STUDIO_ROUTES: readonly PublicRoute[] = [
  listInheritedApps,
  reviewInheritedApp,
  createObjectViewLayout,
  listObjectViewLayouts,
  getObjectViewLayout,
  previewApp,
  createApp,
  listApps,
  getApp,
  getAppVersion,
  saveAppDraft,
  submitAppForReview,
  approveAppVersion,
  returnAppVersion,
  rollbackApp,
  listAppBranches, openAppBranch, saveAppBranchDraft, compareAppVersions, mergeAppBranch, abandonAppBranch,
  listAppReleases, promoteAppRelease, rollBackAppRelease,
  exportAppPackage, importAppPackage,
  archiveApp,
  copyApp,
  openApp, runAppVariable, evaluateAppExpressions,
  shareApp,
  revokeAppShare,
  listAppShares,
  publishAppToScope,
  listAppPublications,
  withdrawAppPublication,
  listAppTemplates,
];
