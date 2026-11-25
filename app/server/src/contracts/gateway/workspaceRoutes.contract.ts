// The workspace in the product (spec 33, 37): saved views, sharing, the dashboard,
// inherited views, preferences, favourites and terminology skins.
//
// Most routes reach only what the member holds: their own views, a view shared with them,
// their dashboard, their preferences. No permission covers those (ownership is the
// authority, spec 37.12), so they are ownRecords routes and the workspace service decides
// access per view, under the sharing policy, for the membership the gateway puts in the
// context. Saving needs query.compile; policies and skins need their permissions; the
// service decides again (organisation-wide where the spec says).

import * as sh from '../workspace/sharing.contract.ts';
import * as sl from '../workspace/shell.contract.ts';
import * as tr from '../workspace/transfer.contract.ts';
import * as vw from '../workspace/view.contract.ts';
import * as ia from '../workspace/interaction.contract.ts';
import * as wb from '../workspace/workbook.contract.ts';
import * as rp from '../workspace/report.contract.ts';
import * as pr from '../workspace/process.contract.ts';
import * as pl from '../workspace/pipeline.contract.ts';
import * as ag from '../workspace/aiAgent.contract.ts';
import * as nbc from '../workspace/notebook.contract.ts';
import * as mlc from '../workspace/mlModel.contract.ts';
import * as anc from '../workspace/analysis.contract.ts';
import { definePublicRoute } from './publicRoute.contract.ts';

// The member's own interactions, reported by the client (33.5, 37; D208): ownership is the authority.
export const recordWorkspaceInteraction = definePublicRoute({
  name: 'recordWorkspaceInteraction', reads: true, method: 'POST', path: '/workspace/interactions', session: 'complete', ownRecords: true,
  body: ia.recordWorkspaceInteraction.body, response: ia.recordWorkspaceInteraction.response, status: 201, forwards: ia.recordWorkspaceInteraction,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const saveWorkspaceView = definePublicRoute({
  name: 'saveWorkspaceView', method: 'POST', path: '/workspace/views', session: 'complete', permission: { permission: 'query.compile' },
  body: vw.saveView.body, response: vw.saveView.response, status: 201, forwards: vw.saveView,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const listWorkspaceViews = definePublicRoute({
  name: 'listWorkspaceViews', method: 'GET', path: '/workspace/views', session: 'complete', ownRecords: true,
  query: vw.listViews.query, response: vw.listViews.response, forwards: vw.listViews,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const openWorkspaceView = definePublicRoute({
  name: 'openWorkspaceView', method: 'GET', path: '/workspace/views/:viewId', session: 'complete', ownRecords: true,
  params: vw.openView.params, response: vw.openView.response, forwards: vw.openView,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const renameWorkspaceView = definePublicRoute({
  name: 'renameWorkspaceView', method: 'PATCH', path: '/workspace/views/:viewId', session: 'complete', ownRecords: true,
  params: vw.renameView.params, body: vw.renameView.body, response: vw.renameView.response, forwards: vw.renameView,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const archiveWorkspaceView = definePublicRoute({
  name: 'archiveWorkspaceView', method: 'POST', path: '/workspace/views/:viewId/archive', session: 'complete', ownRecords: true,
  params: vw.archiveView.params, response: vw.archiveView.response, forwards: vw.archiveView,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const favouriteWorkspaceView = definePublicRoute({
  name: 'favouriteWorkspaceView', method: 'PUT', path: '/workspace/views/:viewId/favourite', session: 'complete', ownRecords: true,
  params: vw.favouriteView.params, body: vw.favouriteView.body, response: vw.favouriteView.response, forwards: vw.favouriteView,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const unfavouriteWorkspaceView = definePublicRoute({
  name: 'unfavouriteWorkspaceView', method: 'DELETE', path: '/workspace/views/:viewId/favourite', session: 'complete', ownRecords: true,
  params: vw.unfavouriteView.params, response: vw.unfavouriteView.response, forwards: vw.unfavouriteView,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

// Analysis over object sets (37.8): built by hand from the types the reader may see, so ontology.view;
// the planner and executor decide what each step may read, as for any plan.
const analysisPermission = { permission: 'ontology.view' };

export const createWorkspaceAnalysis = definePublicRoute({
  name: 'createWorkspaceAnalysis', method: 'POST', path: '/workspace/analyses', session: 'complete', permission: analysisPermission,
  body: anc.createAnalysis.body, response: anc.createAnalysis.response, forwards: anc.createAnalysis,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const createWorkspaceAnalysisFromTurn = definePublicRoute({
  name: 'createWorkspaceAnalysisFromTurn', method: 'POST', path: '/workspace/analyses/from-turn', session: 'complete', permission: analysisPermission,
  body: anc.createAnalysisFromTurn.body, response: anc.createAnalysisFromTurn.response, forwards: anc.createAnalysisFromTurn,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

// Studio decides whether the viewer may run the app; the planner, what each step may read.
export const createWorkspaceAnalysisFromAppChart = definePublicRoute({
  name: 'createWorkspaceAnalysisFromAppChart', method: 'POST', path: '/workspace/analyses/from-app-chart', session: 'complete', permission: analysisPermission,
  body: anc.createAnalysisFromAppChart.body, response: anc.createAnalysisFromAppChart.response, forwards: anc.createAnalysisFromAppChart,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const readWorkspaceAnalysis = definePublicRoute({
  name: 'readWorkspaceAnalysis', method: 'GET', path: '/workspace/analyses/:manifestId', session: 'complete', permission: analysisPermission,
  params: anc.readAnalysis.params, query: anc.readAnalysis.query, response: anc.readAnalysis.response, forwards: anc.readAnalysis,
  call: (input) => ({ params: input.params, query: input.query }), reply: (output) => output,
});

export const runWorkspaceAnalysis = definePublicRoute({
  name: 'runWorkspaceAnalysis', reads: true, method: 'POST', path: '/workspace/analyses/:manifestId/runs', session: 'complete', permission: analysisPermission,
  params: anc.runAnalysis.params, body: anc.runAnalysis.body, response: anc.runAnalysis.response, forwards: anc.runAnalysis,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const runWorkspaceView = definePublicRoute({
  name: 'runWorkspaceView', reads: true, method: 'POST', path: '/workspace/views/:viewId/runs', session: 'complete', ownRecords: true,
  params: vw.runView.params, response: vw.runView.response, forwards: vw.runView,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const copyWorkspaceView = definePublicRoute({
  name: 'copyWorkspaceView', method: 'POST', path: '/workspace/views/:viewId/copies', session: 'complete',
  permission: { permission: 'query.compile' },
  params: vw.copyView.params, body: vw.copyView.body, response: vw.copyView.response, status: 201, forwards: vw.copyView,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const readDashboard = definePublicRoute({
  name: 'readDashboard', method: 'GET', path: '/workspace/dashboard', session: 'complete', ownRecords: true,
  response: vw.getDashboard.response, forwards: vw.getDashboard,
  call: () => ({}), reply: (output) => output,
});

export const moveDashboardTile = definePublicRoute({
  name: 'moveDashboardTile', method: 'PUT', path: '/workspace/dashboard/tiles/:tileId', session: 'complete', ownRecords: true,
  params: vw.moveTile.params, body: vw.moveTile.body, response: vw.moveTile.response, forwards: vw.moveTile,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const shareWorkspaceView = definePublicRoute({
  name: 'shareWorkspaceView', method: 'PUT', path: '/workspace/views/:viewId/shares', session: 'complete', ownRecords: true,
  params: sh.shareView.params, body: sh.shareView.body, response: sh.shareView.response, forwards: sh.shareView,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const revokeWorkspaceViewShare = definePublicRoute({
  name: 'revokeWorkspaceViewShare', method: 'POST', path: '/workspace/views/:viewId/shares/:shareId/revoke', session: 'complete',
  ownRecords: true,
  params: sh.revokeShare.params, response: sh.revokeShare.response, forwards: sh.revokeShare,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listWorkspaceViewShares = definePublicRoute({
  name: 'listWorkspaceViewShares', method: 'GET', path: '/workspace/views/:viewId/shares', session: 'complete', ownRecords: true,
  params: sh.listShares.params, response: sh.listShares.response, forwards: sh.listShares,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const readSharingPolicy = definePublicRoute({
  name: 'readSharingPolicy', method: 'GET', path: '/workspace/sharing-policy', session: 'complete', ownRecords: true,
  response: sh.getSharingPolicy.response, forwards: sh.getSharingPolicy,
  call: () => ({}), reply: (output) => output,
});

export const setOrganisationSharingPolicy = definePublicRoute({
  name: 'setOrganisationSharingPolicy', method: 'PUT', path: '/workspace/sharing-policy', session: 'complete',
  permission: { permission: 'org.sharing.manage' },
  body: sh.setOrganisationSharingPolicy.body, response: sh.setOrganisationSharingPolicy.response, forwards: sh.setOrganisationSharingPolicy,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const setScopeSharingPolicy = definePublicRoute({
  name: 'setScopeSharingPolicy', method: 'PUT', path: '/workspace/scopes/:scopeId/sharing-policy', session: 'complete',
  permission: { permission: 'scope.sharing.narrow', scopeId: (input) => input.params.scopeId },
  params: sh.setScopeSharingPolicy.params, body: sh.setScopeSharingPolicy.body, response: sh.setScopeSharingPolicy.response,
  forwards: sh.setScopeSharingPolicy,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const listInheritedViews = definePublicRoute({
  name: 'listInheritedViews', method: 'GET', path: '/workspace/inherited-views', session: 'complete', ownRecords: true,
  response: tr.listInheritedViews.response, forwards: tr.listInheritedViews,
  call: () => ({}), reply: (output) => output,
});

export const reviewInheritedView = definePublicRoute({
  name: 'reviewInheritedView', method: 'POST', path: '/workspace/inherited-views/:flagId/review', session: 'complete', ownRecords: true,
  params: tr.reviewInheritedView.params, body: tr.reviewInheritedView.body, response: tr.reviewInheritedView.response,
  forwards: tr.reviewInheritedView,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

/** The rail as this person may use it: each item available, or disabled with the permission class it needs (spec 33.3). */
export const readRail = definePublicRoute({
  name: 'readRail', method: 'GET', path: '/workspace/rail', session: 'complete', ownRecords: true,
  response: sl.readRail.response, forwards: sl.readRail,
  call: () => ({}), reply: (output) => output,
});

/** Home's briefing (spec 33.7): the person's own, read under their access. */
export const readBriefing = definePublicRoute({
  name: 'readBriefing', method: 'GET', path: '/workspace/briefing', session: 'complete', ownRecords: true,
  query: sl.readBriefing.query, response: sl.readBriefing.response, forwards: sl.readBriefing,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

/** Following another's Cron or object set (decision 2026-11-17): the person's own records; the target's own service decides they may see it. */
export const followResource = definePublicRoute({
  name: 'followResource', method: 'PUT', path: '/workspace/follows', session: 'complete', ownRecords: true,
  body: sl.followResource.body, response: sl.followResource.response, forwards: sl.followResource,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const unfollowResource = definePublicRoute({
  name: 'unfollowResource', method: 'DELETE', path: '/workspace/follows/:followId', session: 'complete', ownRecords: true,
  params: sl.unfollowResource.params, response: sl.unfollowResource.response, forwards: sl.unfollowResource,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listFollows = definePublicRoute({
  name: 'listFollows', method: 'GET', path: '/workspace/follows', session: 'complete', ownRecords: true,
  response: sl.listFollows.response, forwards: sl.listFollows, call: () => ({}), reply: (output) => output,
});

export const readPreferences = definePublicRoute({
  name: 'readPreferences', method: 'GET', path: '/workspace/preferences', session: 'complete', ownRecords: true,
  response: sl.getPreferences.response, forwards: sl.getPreferences,
  call: () => ({}), reply: (output) => output,
});

export const updatePreferences = definePublicRoute({
  name: 'updatePreferences', method: 'PATCH', path: '/workspace/preferences', session: 'complete', ownRecords: true,
  body: sl.updatePreferences.body, response: sl.updatePreferences.response, forwards: sl.updatePreferences,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const markHomeSeen = definePublicRoute({
  name: 'markHomeSeen', method: 'POST', path: '/workspace/preferences/home-seen', session: 'complete', ownRecords: true,
  response: sl.markHomeSeen.response, forwards: sl.markHomeSeen,
  call: () => ({}), reply: (output) => output,
});

export const listFavourites = definePublicRoute({
  name: 'listFavourites', method: 'GET', path: '/workspace/favourites', session: 'complete', ownRecords: true,
  response: sl.listFavourites.response, forwards: sl.listFavourites,
  call: () => ({}), reply: (output) => output,
});

export const addFavourite = definePublicRoute({
  name: 'addFavourite', method: 'POST', path: '/workspace/favourites', session: 'complete', ownRecords: true,
  body: sl.addFavourite.body, response: sl.addFavourite.response, status: 201, forwards: sl.addFavourite,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const removeFavourite = definePublicRoute({
  name: 'removeFavourite', method: 'DELETE', path: '/workspace/favourites/:favouriteId', session: 'complete', ownRecords: true,
  params: sl.removeFavourite.params, response: sl.removeFavourite.response, forwards: sl.removeFavourite,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listTerminologySkins = definePublicRoute({
  name: 'listTerminologySkins', method: 'GET', path: '/workspace/terminology-skins', session: 'complete',
  permission: { permission: 'ontology.view' },
  response: sl.listTerminologySkins.response, forwards: sl.listTerminologySkins,
  call: () => ({}), reply: (output) => output,
});

export const setTerminologySkin = definePublicRoute({
  name: 'setTerminologySkin', method: 'PUT', path: '/workspace/terminology-skins', session: 'complete',
  permission: { permission: 'org.terminology.manage' },
  body: sl.setTerminologySkin.body, response: sl.setTerminologySkin.response, forwards: sl.setTerminologySkin,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const supersedeTerminologySkin = definePublicRoute({
  name: 'supersedeTerminologySkin', method: 'POST', path: '/workspace/terminology-skins/:skinId/supersede', session: 'complete',
  permission: { permission: 'org.terminology.manage' },
  params: sl.supersedeTerminologySkin.params, response: sl.supersedeTerminologySkin.response, forwards: sl.supersedeTerminologySkin,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

// Workbooks (D232): the owner edits and shares (workbook.save); anyone a share reaches opens it with live data, read as them.
export const createWorkbook = definePublicRoute({
  name: 'createWorkbook', method: 'POST', path: '/workbooks', session: 'complete', permission: { permission: 'workbook.save' },
  params: wb.createWorkbook.params, body: wb.createWorkbook.body, response: wb.createWorkbook.response, status: 201, forwards: wb.createWorkbook,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const listWorkbooks = definePublicRoute({
  name: 'listWorkbooks', method: 'GET', path: '/workbooks', session: 'complete', ownRecords: true,
  query: wb.listWorkbooks.query, response: wb.listWorkbooks.response, forwards: wb.listWorkbooks,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});
export const getWorkbook = definePublicRoute({
  name: 'getWorkbook', method: 'GET', path: '/workbooks/:workbookId', session: 'complete', ownRecords: true,
  params: wb.getWorkbook.params, response: wb.getWorkbook.response, forwards: wb.getWorkbook,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const saveWorkbook = definePublicRoute({
  name: 'saveWorkbook', method: 'PUT', path: '/workbooks/:workbookId', session: 'complete', permission: { permission: 'workbook.save' },
  params: wb.saveWorkbook.params, body: wb.saveWorkbook.body, response: wb.saveWorkbook.response, maxBodyBytes: 4 * 1024 * 1024, forwards: wb.saveWorkbook,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const readWorkbookRanges = definePublicRoute({
  name: 'readWorkbookRanges', method: 'GET', path: '/workbooks/:workbookId/ranges', session: 'complete', ownRecords: true,
  params: wb.readWorkbookRanges.params, response: wb.readWorkbookRanges.response, forwards: wb.readWorkbookRanges,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const copyWorkbook = definePublicRoute({
  name: 'copyWorkbook', method: 'POST', path: '/workbooks/:workbookId/copies', session: 'complete', permission: { permission: 'workbook.save' },
  params: wb.copyWorkbook.params, body: wb.copyWorkbook.body, response: wb.copyWorkbook.response, status: 201, forwards: wb.copyWorkbook,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const archiveWorkbook = definePublicRoute({
  name: 'archiveWorkbook', method: 'POST', path: '/workbooks/:workbookId/archive', session: 'complete', ownRecords: true,
  params: wb.archiveWorkbook.params, response: wb.archiveWorkbook.response, forwards: wb.archiveWorkbook,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const shareWorkbook = definePublicRoute({
  name: 'shareWorkbook', method: 'POST', path: '/workbooks/:workbookId/shares', session: 'complete', permission: { permission: 'workbook.save' },
  params: wb.shareWorkbook.params, body: wb.shareWorkbook.body, response: wb.shareWorkbook.response, status: 201, forwards: wb.shareWorkbook,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const revokeWorkbookShare = definePublicRoute({
  name: 'revokeWorkbookShare', method: 'POST', path: '/workbooks/:workbookId/shares/:shareId/revoke', session: 'complete', ownRecords: true,
  params: wb.revokeWorkbookShare.params, response: wb.revokeWorkbookShare.response, forwards: wb.revokeWorkbookShare,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const listWorkbookShares = definePublicRoute({
  name: 'listWorkbookShares', method: 'GET', path: '/workbooks/:workbookId/shares', session: 'complete', ownRecords: true,
  params: wb.listWorkbookShares.params, response: wb.listWorkbookShares.response, forwards: wb.listWorkbookShares,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const exportWorkbook = definePublicRoute({
  name: 'exportWorkbook', method: 'POST', path: '/workbooks/:workbookId/exports', session: 'complete', permission: { permission: 'file.export' },
  params: wb.exportWorkbook.params, body: wb.exportWorkbook.body, response: wb.exportWorkbook.response, status: 201, forwards: wb.exportWorkbook,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

// Reports (D233): the owner edits and shares (report.save); anyone a share reaches opens it with its blocks read as them.
export const createReport = definePublicRoute({
  name: 'createReport', method: 'POST', path: '/reports', session: 'complete', permission: { permission: 'report.save' },
  body: rp.createReport.body, response: rp.createReport.response, status: 201, forwards: rp.createReport,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});
export const listReports = definePublicRoute({
  name: 'listReports', method: 'GET', path: '/reports', session: 'complete', ownRecords: true,
  query: rp.listReports.query, response: rp.listReports.response, forwards: rp.listReports,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});
export const getReport = definePublicRoute({
  name: 'getReport', method: 'GET', path: '/reports/:reportId', session: 'complete', ownRecords: true,
  params: rp.getReport.params, response: rp.getReport.response, forwards: rp.getReport,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const saveReport = definePublicRoute({
  name: 'saveReport', method: 'PUT', path: '/reports/:reportId', session: 'complete', permission: { permission: 'report.save' },
  params: rp.saveReport.params, body: rp.saveReport.body, response: rp.saveReport.response, maxBodyBytes: 2 * 1024 * 1024, forwards: rp.saveReport,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const readReportBlocks = definePublicRoute({
  name: 'readReportBlocks', method: 'GET', path: '/reports/:reportId/blocks', session: 'complete', ownRecords: true,
  params: rp.readReportBlocks.params, response: rp.readReportBlocks.response, forwards: rp.readReportBlocks,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const copyReport = definePublicRoute({
  name: 'copyReport', method: 'POST', path: '/reports/:reportId/copies', session: 'complete', permission: { permission: 'report.save' },
  params: rp.copyReport.params, body: rp.copyReport.body, response: rp.copyReport.response, status: 201, forwards: rp.copyReport,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const archiveReport = definePublicRoute({
  name: 'archiveReport', method: 'POST', path: '/reports/:reportId/archive', session: 'complete', ownRecords: true,
  params: rp.archiveReport.params, response: rp.archiveReport.response, forwards: rp.archiveReport,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const shareReport = definePublicRoute({
  name: 'shareReport', method: 'POST', path: '/reports/:reportId/shares', session: 'complete', permission: { permission: 'report.save' },
  params: rp.shareReport.params, body: rp.shareReport.body, response: rp.shareReport.response, status: 201, forwards: rp.shareReport,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const revokeReportShare = definePublicRoute({
  name: 'revokeReportShare', method: 'POST', path: '/reports/:reportId/shares/:shareId/revoke', session: 'complete', ownRecords: true,
  params: rp.revokeReportShare.params, response: rp.revokeReportShare.response, forwards: rp.revokeReportShare,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const listReportShares = definePublicRoute({
  name: 'listReportShares', method: 'GET', path: '/reports/:reportId/shares', session: 'complete', ownRecords: true,
  params: rp.listReportShares.params, response: rp.listReportShares.response, forwards: rp.listReportShares,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const exportReport = definePublicRoute({
  name: 'exportReport', method: 'POST', path: '/reports/:reportId/exports', session: 'complete', permission: { permission: 'file.export' },
  params: rp.exportReport.params, body: rp.exportReport.body, response: rp.exportReport.response, status: 201, forwards: rp.exportReport,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

// Process analyses (D234): the owner edits and shares (process.save); anyone a share reaches opens it, mined from what they may read.
export const createProcess = definePublicRoute({
  name: 'createProcess', method: 'POST', path: '/processes', session: 'complete', permission: { permission: 'process.save' },
  body: pr.createProcess.body, response: pr.createProcess.response, status: 201, forwards: pr.createProcess,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});
export const listProcesses = definePublicRoute({
  name: 'listProcesses', method: 'GET', path: '/processes', session: 'complete', ownRecords: true,
  query: pr.listProcesses.query, response: pr.listProcesses.response, forwards: pr.listProcesses,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});
export const getProcess = definePublicRoute({
  name: 'getProcess', method: 'GET', path: '/processes/:processId', session: 'complete', ownRecords: true,
  params: pr.getProcess.params, response: pr.getProcess.response, forwards: pr.getProcess,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const saveProcess = definePublicRoute({
  name: 'saveProcess', method: 'PUT', path: '/processes/:processId', session: 'complete', permission: { permission: 'process.save' },
  params: pr.saveProcess.params, body: pr.saveProcess.body, response: pr.saveProcess.response, forwards: pr.saveProcess,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const readProcessAnalysis = definePublicRoute({
  name: 'readProcessAnalysis', method: 'GET', path: '/processes/:processId/analysis', session: 'complete', ownRecords: true,
  params: pr.readProcessAnalysis.params, response: pr.readProcessAnalysis.response, forwards: pr.readProcessAnalysis,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const copyProcess = definePublicRoute({
  name: 'copyProcess', method: 'POST', path: '/processes/:processId/copies', session: 'complete', permission: { permission: 'process.save' },
  params: pr.copyProcess.params, body: pr.copyProcess.body, response: pr.copyProcess.response, status: 201, forwards: pr.copyProcess,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const archiveProcess = definePublicRoute({
  name: 'archiveProcess', method: 'POST', path: '/processes/:processId/archive', session: 'complete', ownRecords: true,
  params: pr.archiveProcess.params, response: pr.archiveProcess.response, forwards: pr.archiveProcess,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const shareProcess = definePublicRoute({
  name: 'shareProcess', method: 'POST', path: '/processes/:processId/shares', session: 'complete', permission: { permission: 'process.save' },
  params: pr.shareProcess.params, body: pr.shareProcess.body, response: pr.shareProcess.response, status: 201, forwards: pr.shareProcess,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const revokeProcessShare = definePublicRoute({
  name: 'revokeProcessShare', method: 'POST', path: '/processes/:processId/shares/:shareId/revoke', session: 'complete', ownRecords: true,
  params: pr.revokeProcessShare.params, response: pr.revokeProcessShare.response, forwards: pr.revokeProcessShare,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const listProcessShares = definePublicRoute({
  name: 'listProcessShares', method: 'GET', path: '/processes/:processId/shares', session: 'complete', ownRecords: true,
  params: pr.listProcessShares.params, response: pr.listProcessShares.response, forwards: pr.listProcessShares,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const exportProcess = definePublicRoute({
  name: 'exportProcess', method: 'POST', path: '/processes/:processId/exports', session: 'complete', permission: { permission: 'file.export' },
  params: pr.exportProcess.params, body: pr.exportProcess.body, response: pr.exportProcess.response, status: 201, forwards: pr.exportProcess,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

// Data pipelines (D235): the owner's alone; a run writes into an Import Silo as the person (silo.import, decided by siloes-import).
export const createPipeline = definePublicRoute({
  name: 'createPipeline', method: 'POST', path: '/pipelines', session: 'complete', permission: { permission: 'pipeline.save' },
  body: pl.createPipeline.body, response: pl.createPipeline.response, status: 201, forwards: pl.createPipeline,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});
export const listPipelines = definePublicRoute({
  name: 'listPipelines', method: 'GET', path: '/pipelines', session: 'complete', ownRecords: true,
  query: pl.listPipelines.query, response: pl.listPipelines.response, forwards: pl.listPipelines,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});
export const getPipeline = definePublicRoute({
  name: 'getPipeline', method: 'GET', path: '/pipelines/:pipelineId', session: 'complete', ownRecords: true,
  params: pl.getPipeline.params, response: pl.getPipeline.response, forwards: pl.getPipeline,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const savePipeline = definePublicRoute({
  name: 'savePipeline', method: 'PUT', path: '/pipelines/:pipelineId', session: 'complete', permission: { permission: 'pipeline.save' },
  params: pl.savePipeline.params, body: pl.savePipeline.body, response: pl.savePipeline.response, forwards: pl.savePipeline,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const previewPipeline = definePublicRoute({
  name: 'previewPipeline', reads: true, method: 'POST', path: '/pipelines/:pipelineId/previews', session: 'complete', ownRecords: true,
  params: pl.previewPipeline.params, body: pl.previewPipeline.body, response: pl.previewPipeline.response, forwards: pl.previewPipeline,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const runPipeline = definePublicRoute({
  name: 'runPipeline', method: 'POST', path: '/pipelines/:pipelineId/runs', session: 'complete', permission: { permission: 'pipeline.save' },
  params: pl.runPipeline.params, response: pl.runPipeline.response, status: 201, forwards: pl.runPipeline,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const listPipelineRuns = definePublicRoute({
  name: 'listPipelineRuns', method: 'GET', path: '/pipelines/:pipelineId/runs', session: 'complete', ownRecords: true,
  params: pl.listPipelineRuns.params, response: pl.listPipelineRuns.response, forwards: pl.listPipelineRuns,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const getPipelineRun = definePublicRoute({
  name: 'getPipelineRun', method: 'GET', path: '/pipeline-runs/:runId', session: 'complete', ownRecords: true,
  params: pl.getPipelineRun.params, response: pl.getPipelineRun.response, forwards: pl.getPipelineRun,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const archivePipeline = definePublicRoute({
  name: 'archivePipeline', method: 'POST', path: '/pipelines/:pipelineId/archive', session: 'complete', ownRecords: true,
  params: pl.archivePipeline.params, response: pl.archivePipeline.response, forwards: pl.archivePipeline,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

// AI agents (D236): the owner edits; shared to ask or to copy; asked in Ask threads made with them, under the asker's own access.
export const createAiAgent = definePublicRoute({
  name: 'createAiAgent', method: 'POST', path: '/ai-agents', session: 'complete', permission: { permission: 'ai_agent.save' },
  body: ag.createAiAgent.body, response: ag.createAiAgent.response, status: 201, forwards: ag.createAiAgent,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});
export const listAiAgents = definePublicRoute({
  name: 'listAiAgents', method: 'GET', path: '/ai-agents', session: 'complete', ownRecords: true,
  query: ag.listAiAgents.query, response: ag.listAiAgents.response, forwards: ag.listAiAgents,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});
export const getAiAgent = definePublicRoute({
  name: 'getAiAgent', method: 'GET', path: '/ai-agents/:aiAgentId', session: 'complete', ownRecords: true,
  params: ag.getAiAgent.params, response: ag.getAiAgent.response, forwards: ag.getAiAgent,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const saveAiAgent = definePublicRoute({
  name: 'saveAiAgent', method: 'PUT', path: '/ai-agents/:aiAgentId', session: 'complete', permission: { permission: 'ai_agent.save' },
  params: ag.saveAiAgent.params, body: ag.saveAiAgent.body, response: ag.saveAiAgent.response, forwards: ag.saveAiAgent,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const copyAiAgent = definePublicRoute({
  name: 'copyAiAgent', method: 'POST', path: '/ai-agents/:aiAgentId/copies', session: 'complete', permission: { permission: 'ai_agent.save' },
  params: ag.copyAiAgent.params, body: ag.copyAiAgent.body, response: ag.copyAiAgent.response, status: 201, forwards: ag.copyAiAgent,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const archiveAiAgent = definePublicRoute({
  name: 'archiveAiAgent', method: 'POST', path: '/ai-agents/:aiAgentId/archive', session: 'complete', ownRecords: true,
  params: ag.archiveAiAgent.params, response: ag.archiveAiAgent.response, forwards: ag.archiveAiAgent,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const shareAiAgent = definePublicRoute({
  name: 'shareAiAgent', method: 'POST', path: '/ai-agents/:aiAgentId/shares', session: 'complete', permission: { permission: 'ai_agent.save' },
  params: ag.shareAiAgent.params, body: ag.shareAiAgent.body, response: ag.shareAiAgent.response, status: 201, forwards: ag.shareAiAgent,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const revokeAiAgentShare = definePublicRoute({
  name: 'revokeAiAgentShare', method: 'POST', path: '/ai-agents/:aiAgentId/shares/:shareId/revoke', session: 'complete', ownRecords: true,
  params: ag.revokeAiAgentShare.params, response: ag.revokeAiAgentShare.response, forwards: ag.revokeAiAgentShare,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const listAiAgentShares = definePublicRoute({
  name: 'listAiAgentShares', method: 'GET', path: '/ai-agents/:aiAgentId/shares', session: 'complete', ownRecords: true,
  params: ag.listAiAgentShares.params, response: ag.listAiAgentShares.response, forwards: ag.listAiAgentShares,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

// Notebooks (D239): the owner edits and asks; run for whoever opens them, as them; shared to open or to copy.
export const createNotebook = definePublicRoute({
  name: 'createNotebook', method: 'POST', path: '/notebooks', session: 'complete', permission: { permission: 'notebook.save' },
  body: nbc.createNotebook.body, response: nbc.createNotebook.response, status: 201, forwards: nbc.createNotebook,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});
export const listNotebooks = definePublicRoute({
  name: 'listNotebooks', method: 'GET', path: '/notebooks', session: 'complete', ownRecords: true,
  query: nbc.listNotebooks.query, response: nbc.listNotebooks.response, forwards: nbc.listNotebooks,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});
export const getNotebook = definePublicRoute({
  name: 'getNotebook', method: 'GET', path: '/notebooks/:notebookId', session: 'complete', ownRecords: true,
  params: nbc.getNotebook.params, response: nbc.getNotebook.response, forwards: nbc.getNotebook,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const saveNotebook = definePublicRoute({
  name: 'saveNotebook', method: 'PUT', path: '/notebooks/:notebookId', session: 'complete', permission: { permission: 'notebook.save' },
  params: nbc.saveNotebook.params, body: nbc.saveNotebook.body, response: nbc.saveNotebook.response, forwards: nbc.saveNotebook,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const askNotebookQuestion = definePublicRoute({
  name: 'askNotebookQuestion', method: 'POST', path: '/notebooks/:notebookId/questions', session: 'complete', permission: { permission: 'query.compile' },
  params: nbc.askNotebookQuestion.params, body: nbc.askNotebookQuestion.body, response: nbc.askNotebookQuestion.response, status: 201, forwards: nbc.askNotebookQuestion,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const runNotebook = definePublicRoute({
  name: 'runNotebook', reads: true, method: 'POST', path: '/notebooks/:notebookId/runs', session: 'complete', ownRecords: true,
  params: nbc.runNotebook.params, body: nbc.runNotebook.body, response: nbc.runNotebook.response, status: 201, forwards: nbc.runNotebook,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const copyNotebook = definePublicRoute({
  name: 'copyNotebook', method: 'POST', path: '/notebooks/:notebookId/copies', session: 'complete', permission: { permission: 'notebook.save' },
  params: nbc.copyNotebook.params, body: nbc.copyNotebook.body, response: nbc.copyNotebook.response, status: 201, forwards: nbc.copyNotebook,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const archiveNotebook = definePublicRoute({
  name: 'archiveNotebook', method: 'POST', path: '/notebooks/:notebookId/archive', session: 'complete', ownRecords: true,
  params: nbc.archiveNotebook.params, response: nbc.archiveNotebook.response, forwards: nbc.archiveNotebook,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const shareNotebook = definePublicRoute({
  name: 'shareNotebook', method: 'POST', path: '/notebooks/:notebookId/shares', session: 'complete', permission: { permission: 'notebook.save' },
  params: nbc.shareNotebook.params, body: nbc.shareNotebook.body, response: nbc.shareNotebook.response, status: 201, forwards: nbc.shareNotebook,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const revokeNotebookShare = definePublicRoute({
  name: 'revokeNotebookShare', method: 'POST', path: '/notebooks/:notebookId/shares/:shareId/revoke', session: 'complete', ownRecords: true,
  params: nbc.revokeNotebookShare.params, response: nbc.revokeNotebookShare.response, forwards: nbc.revokeNotebookShare,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const listNotebookShares = definePublicRoute({
  name: 'listNotebookShares', method: 'GET', path: '/notebooks/:notebookId/shares', session: 'complete', ownRecords: true,
  params: nbc.listNotebookShares.params, response: nbc.listNotebookShares.response, forwards: nbc.listNotebookShares,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const exportNotebook = definePublicRoute({
  name: 'exportNotebook', method: 'POST', path: '/notebooks/:notebookId/exports', session: 'complete', permission: { permission: 'file.export' },
  params: nbc.exportNotebook.params, body: nbc.exportNotebook.body, response: nbc.exportNotebook.response, status: 201, forwards: nbc.exportNotebook,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

// Machine learning models (D240): trained and published by the owner; predicting for whoever asks, as them; shared to see and predict with.
export const createMlModel = definePublicRoute({
  name: 'createMlModel', method: 'POST', path: '/ml-models', session: 'complete', permission: { permission: 'model.save' },
  body: mlc.createMlModel.body, response: mlc.createMlModel.response, status: 201, forwards: mlc.createMlModel,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});
export const listMlModels = definePublicRoute({
  name: 'listMlModels', method: 'GET', path: '/ml-models', session: 'complete', ownRecords: true,
  query: mlc.listMlModels.query, response: mlc.listMlModels.response, forwards: mlc.listMlModels,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});
export const getMlModel = definePublicRoute({
  name: 'getMlModel', method: 'GET', path: '/ml-models/:mlModelId', session: 'complete', ownRecords: true,
  params: mlc.getMlModel.params, response: mlc.getMlModel.response, forwards: mlc.getMlModel,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const saveMlModel = definePublicRoute({
  name: 'saveMlModel', method: 'PUT', path: '/ml-models/:mlModelId', session: 'complete', permission: { permission: 'model.save' },
  params: mlc.saveMlModel.params, body: mlc.saveMlModel.body, response: mlc.saveMlModel.response, forwards: mlc.saveMlModel,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const trainMlModel = definePublicRoute({
  name: 'trainMlModel', method: 'POST', path: '/ml-models/:mlModelId/versions', session: 'complete', permission: { permission: 'model.save' },
  params: mlc.trainMlModel.params, response: mlc.trainMlModel.response, status: 201, forwards: mlc.trainMlModel,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const listMlModelVersions = definePublicRoute({
  name: 'listMlModelVersions', method: 'GET', path: '/ml-models/:mlModelId/versions', session: 'complete', ownRecords: true,
  params: mlc.listMlModelVersions.params, response: mlc.listMlModelVersions.response, forwards: mlc.listMlModelVersions,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const getMlModelVersion = definePublicRoute({
  name: 'getMlModelVersion', method: 'GET', path: '/ml-models/:mlModelId/versions/:versionId', session: 'complete', ownRecords: true,
  params: mlc.getMlModelVersion.params, response: mlc.getMlModelVersion.response, forwards: mlc.getMlModelVersion,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const publishMlModelVersion = definePublicRoute({
  name: 'publishMlModelVersion', method: 'POST', path: '/ml-models/:mlModelId/versions/:versionId/publication', session: 'complete', permission: { permission: 'model.save' },
  params: mlc.publishMlModelVersion.params, response: mlc.publishMlModelVersion.response, forwards: mlc.publishMlModelVersion,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const predictMlModel = definePublicRoute({
  name: 'predictMlModel', reads: true, method: 'POST', path: '/ml-models/:mlModelId/predictions', session: 'complete', ownRecords: true,
  params: mlc.predictMlModel.params, body: mlc.predictMlModel.body, response: mlc.predictMlModel.response, status: 201, forwards: mlc.predictMlModel,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const archiveMlModel = definePublicRoute({
  name: 'archiveMlModel', method: 'POST', path: '/ml-models/:mlModelId/archive', session: 'complete', ownRecords: true,
  params: mlc.archiveMlModel.params, response: mlc.archiveMlModel.response, forwards: mlc.archiveMlModel,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const shareMlModel = definePublicRoute({
  name: 'shareMlModel', method: 'POST', path: '/ml-models/:mlModelId/shares', session: 'complete', permission: { permission: 'model.save' },
  params: mlc.shareMlModel.params, body: mlc.shareMlModel.body, response: mlc.shareMlModel.response, status: 201, forwards: mlc.shareMlModel,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const revokeMlModelShare = definePublicRoute({
  name: 'revokeMlModelShare', method: 'POST', path: '/ml-models/:mlModelId/shares/:shareId/revoke', session: 'complete', ownRecords: true,
  params: mlc.revokeMlModelShare.params, response: mlc.revokeMlModelShare.response, forwards: mlc.revokeMlModelShare,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const listMlModelShares = definePublicRoute({
  name: 'listMlModelShares', method: 'GET', path: '/ml-models/:mlModelId/shares', session: 'complete', ownRecords: true,
  params: mlc.listMlModelShares.params, response: mlc.listMlModelShares.response, forwards: mlc.listMlModelShares,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

// Pipeline schedules (D241): the owner's; runs as the schedule's own principal, bounded by them.
export const setPipelineSchedule = definePublicRoute({
  name: 'setPipelineSchedule', method: 'PUT', path: '/pipelines/:pipelineId/schedule', session: 'complete', permission: { permission: 'pipeline.save' },
  params: pl.setPipelineSchedule.params, body: pl.setPipelineSchedule.body, response: pl.setPipelineSchedule.response, forwards: pl.setPipelineSchedule,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});
export const removePipelineSchedule = definePublicRoute({
  name: 'removePipelineSchedule', method: 'POST', path: '/pipelines/:pipelineId/schedule/removal', session: 'complete', ownRecords: true,
  params: pl.removePipelineSchedule.params, response: pl.removePipelineSchedule.response, forwards: pl.removePipelineSchedule,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});
export const resumePipelineSchedule = definePublicRoute({
  name: 'resumePipelineSchedule', method: 'POST', path: '/pipelines/:pipelineId/schedule/resumption', session: 'complete', permission: { permission: 'pipeline.save' },
  params: pl.resumePipelineSchedule.params, response: pl.resumePipelineSchedule.response, forwards: pl.resumePipelineSchedule,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const WORKSPACE_ROUTES = [
  recordWorkspaceInteraction,
  createWorkspaceAnalysis, createWorkspaceAnalysisFromTurn, createWorkspaceAnalysisFromAppChart, readWorkspaceAnalysis, runWorkspaceAnalysis,
  createWorkbook, listWorkbooks, getWorkbook, saveWorkbook, readWorkbookRanges, copyWorkbook, archiveWorkbook, shareWorkbook, revokeWorkbookShare,
  listWorkbookShares, exportWorkbook,
  createReport, listReports, getReport, saveReport, readReportBlocks, copyReport, archiveReport, shareReport, revokeReportShare, listReportShares, exportReport,
  createProcess, listProcesses, getProcess, saveProcess, readProcessAnalysis, copyProcess, archiveProcess, shareProcess, revokeProcessShare, listProcessShares,
  exportProcess,
  createPipeline, listPipelines, getPipeline, savePipeline, previewPipeline, runPipeline, listPipelineRuns, getPipelineRun, archivePipeline,
  setPipelineSchedule, removePipelineSchedule, resumePipelineSchedule,
  createAiAgent, listAiAgents, getAiAgent, saveAiAgent, copyAiAgent, archiveAiAgent, shareAiAgent, revokeAiAgentShare, listAiAgentShares,
  createNotebook, listNotebooks, getNotebook, saveNotebook, askNotebookQuestion, runNotebook, copyNotebook, archiveNotebook, shareNotebook,
  revokeNotebookShare, listNotebookShares, exportNotebook,
  createMlModel, listMlModels, getMlModel, saveMlModel, trainMlModel, listMlModelVersions, getMlModelVersion, publishMlModelVersion, predictMlModel,
  archiveMlModel, shareMlModel, revokeMlModelShare, listMlModelShares,
  readRail, readBriefing, followResource, unfollowResource, listFollows,
  saveWorkspaceView, listWorkspaceViews, openWorkspaceView, renameWorkspaceView, archiveWorkspaceView, favouriteWorkspaceView,
  unfavouriteWorkspaceView, runWorkspaceView, copyWorkspaceView, readDashboard, moveDashboardTile, shareWorkspaceView,
  revokeWorkspaceViewShare, listWorkspaceViewShares, readSharingPolicy, setOrganisationSharingPolicy, setScopeSharingPolicy,
  listInheritedViews, reviewInheritedView, readPreferences, updatePreferences, markHomeSeen, listFavourites, addFavourite,
  removeFavourite, listTerminologySkins, setTerminologySkin, supersedeTerminologySkin,
];
