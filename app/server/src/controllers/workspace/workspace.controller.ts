// The workspace's endpoints: contracts to the services, nothing more.

import type { recordWorkspaceInteraction } from '../../contracts/workspace/interaction.contract.ts';
import * as interactions from '../../services/workspace/interaction.service.ts';

import type {
  addFavourite, followResource, getPreferences, listFollows, readBriefing, readRail, unfollowResource, listFavourites, listTerminologySkins, markHomeSeen, removeFavourite, setTerminologySkin,
  supersedeTerminologySkin, updatePreferences,
} from '../../contracts/workspace/shell.contract.ts';
import type {
  getSharingPolicy, listShares, revokeShare, setOrganisationSharingPolicy, setScopeSharingPolicy, shareView,
} from '../../contracts/workspace/sharing.contract.ts';
import type { listInheritedViews, reviewInheritedView, transferViews } from '../../contracts/workspace/transfer.contract.ts';
import type {
  archiveView, copyView, favouriteView, getDashboard, listViews, moveTile, openView, renameView, runView, saveView, unfavouriteView,
} from '../../contracts/workspace/view.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import type { WorkspaceDeps } from '../../services/workspace/deps.service.ts';
import * as sharing from '../../services/workspace/sharing.service.ts';
import * as workbooks from '../../services/workspace/workbooks.service.ts';
import type * as wb from '../../contracts/workspace/workbook.contract.ts';
import type * as rp from '../../contracts/workspace/report.contract.ts';
import type * as pr from '../../contracts/workspace/process.contract.ts';
import type * as pl from '../../contracts/workspace/pipeline.contract.ts';
import type * as ag from '../../contracts/workspace/aiAgent.contract.ts';
import type * as nbc from '../../contracts/workspace/notebook.contract.ts';
import type * as anc from '../../contracts/workspace/analysis.contract.ts';
import type * as mlc from '../../contracts/workspace/mlModel.contract.ts';
import * as ml from '../../services/workspace/mlModels.service.ts';
import * as notebooks from '../../services/workspace/notebooks.service.ts';
import * as analyses from '../../services/workspace/analyses.service.ts';
import * as aiAgents from '../../services/workspace/aiAgents.service.ts';
import * as pipelines from '../../services/workspace/pipelines.service.ts';
import * as processes from '../../services/workspace/processes.service.ts';
import * as reports from '../../services/workspace/reports.service.ts';
import { getExport } from '../../contracts/files/file.contract.ts';
import * as shell from '../../services/workspace/shell.service.ts';
import * as transfers from '../../services/workspace/transfer.service.ts';
import * as views from '../../services/workspace/views.service.ts';
import { briefing } from '../../services/workspace/briefing.service.ts';
import * as follows from '../../services/workspace/follows.service.ts';

export function workspaceController(deps: WorkspaceDeps) {
  return {
    // Machine learning models (D240).
    createMlModel: { handle: (input, ctx) => ml.create(deps, ctx, input.body), resultRef: (out) => out.id, replay: (ref, ctx) => ml.get(deps, ctx, ref!) } satisfies RouteHandlers<typeof mlc.createMlModel>,
    listMlModels: { handle: (input, ctx) => ml.list(deps, ctx, input.query.filter, input.query.limit) } satisfies RouteHandlers<typeof mlc.listMlModels>,
    getMlModel: { handle: (input, ctx) => ml.get(deps, ctx, input.params.mlModelId) } satisfies RouteHandlers<typeof mlc.getMlModel>,
    saveMlModel: { handle: (input, ctx) => ml.save(deps, ctx, input.params.mlModelId, input.body) } satisfies RouteHandlers<typeof mlc.saveMlModel>,
    trainMlModel: {
      handle: (input, ctx) => ml.train(deps, ctx, input.params.mlModelId), resultRef: (out) => `${out.modelId}.${out.id}`,
      // A retry: the version the first request trained, as it stands.
      replay: async (ref, ctx) => { const [modelId, versionId] = ref!.split('.'); return (await ml.versions(deps, ctx, modelId!)).versions.find((v) => v.id === versionId)!; },
    } satisfies RouteHandlers<typeof mlc.trainMlModel>,
    listMlModelVersions: { handle: (input, ctx) => ml.versions(deps, ctx, input.params.mlModelId) } satisfies RouteHandlers<typeof mlc.listMlModelVersions>,
    getMlModelVersion: { handle: (input, ctx) => ml.version(deps, ctx, input.params.mlModelId, input.params.versionId) } satisfies RouteHandlers<typeof mlc.getMlModelVersion>,
    publishMlModelVersion: { handle: (input, ctx) => ml.publish(deps, ctx, input.params.mlModelId, input.params.versionId) } satisfies RouteHandlers<typeof mlc.publishMlModelVersion>,
    predictMlModel: { handle: async (input, ctx) => { const { task: _t, ...out } = await ml.predict(deps, ctx, input.params.mlModelId, input.body); return out; } } satisfies RouteHandlers<typeof mlc.predictMlModel>,
    archiveMlModel: { handle: (input, ctx) => ml.archive(deps, ctx, input.params.mlModelId) } satisfies RouteHandlers<typeof mlc.archiveMlModel>,
    shareMlModel: { handle: (input, ctx) => ml.share(deps, ctx, input.params.mlModelId, input.body) } satisfies RouteHandlers<typeof mlc.shareMlModel>,
    revokeMlModelShare: { handle: (input, ctx) => ml.revoke(deps, ctx, input.params.mlModelId, input.params.shareId) } satisfies RouteHandlers<typeof mlc.revokeMlModelShare>,
    listMlModelShares: { handle: (input, ctx) => ml.shares(deps, ctx, input.params.mlModelId) } satisfies RouteHandlers<typeof mlc.listMlModelShares>,
    // Notebooks (D239).
    createNotebook: { handle: (input, ctx) => notebooks.create(deps, ctx, input.body.name), resultRef: (out) => out.id, replay: (ref, ctx) => notebooks.get(deps, ctx, ref!) } satisfies RouteHandlers<typeof nbc.createNotebook>,
    listNotebooks: { handle: (input, ctx) => notebooks.list(deps, ctx, input.query.filter, input.query.limit) } satisfies RouteHandlers<typeof nbc.listNotebooks>,
    getNotebook: { handle: (input, ctx) => notebooks.get(deps, ctx, input.params.notebookId) } satisfies RouteHandlers<typeof nbc.getNotebook>,
    saveNotebook: { handle: (input, ctx) => notebooks.save(deps, ctx, input.params.notebookId, input.body) } satisfies RouteHandlers<typeof nbc.saveNotebook>,
    askNotebookQuestion: {
      handle: (input, ctx) => notebooks.ask(deps, ctx, input.params.notebookId, input.body),
      // A retry answers with the notebook as it stands: the question is compiled and charged once (compile's key).
      resultRef: (out) => (out.outcome === 'plan' ? out.notebook.id : ''),
      replay: async (ref, ctx) => (ref === '' ? { outcome: 'refusal' as const, reason: 'retry', narrowing: 'ask again' } : { outcome: 'plan' as const, notebook: await notebooks.get(deps, ctx, ref!), tokensCharged: 0 }),
    } satisfies RouteHandlers<typeof nbc.askNotebookQuestion>,
    runNotebook: { handle: (input, ctx) => notebooks.run(deps, ctx, input.params.notebookId, input.body.document) } satisfies RouteHandlers<typeof nbc.runNotebook>,
    copyNotebook: {
      handle: (input, ctx) => notebooks.copy(deps, ctx, input.params.notebookId, input.body.name), resultRef: (out) => out.id, replay: (ref, ctx) => notebooks.get(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof nbc.copyNotebook>,
    archiveNotebook: { handle: (input, ctx) => notebooks.archive(deps, ctx, input.params.notebookId) } satisfies RouteHandlers<typeof nbc.archiveNotebook>,
    shareNotebook: { handle: (input, ctx) => notebooks.share(deps, ctx, input.params.notebookId, input.body) } satisfies RouteHandlers<typeof nbc.shareNotebook>,
    revokeNotebookShare: { handle: (input, ctx) => notebooks.revoke(deps, ctx, input.params.notebookId, input.params.shareId) } satisfies RouteHandlers<typeof nbc.revokeNotebookShare>,
    listNotebookShares: { handle: (input, ctx) => notebooks.shares(deps, ctx, input.params.notebookId) } satisfies RouteHandlers<typeof nbc.listNotebookShares>,
    exportNotebook: {
      handle: (input, ctx) => notebooks.exportNotebook(deps, ctx, input.params.notebookId, input.body.folderId),
      resultRef: (out) => out.file.id,
      replay: async (ref, ctx) => ({ file: await deps.services.call(getExport, { params: { fileId: ref! } }, { request: ctx.request, correlationId: ctx.correlationId }) }),
    } satisfies RouteHandlers<typeof nbc.exportNotebook>,
    // AI agents (D236).
    createAiAgent: { handle: (input, ctx) => aiAgents.create(deps, ctx, input.body), resultRef: (out) => out.id, replay: (ref, ctx) => aiAgents.get(deps, ctx, ref!) } satisfies RouteHandlers<typeof ag.createAiAgent>,
    listAiAgents: { handle: (input, ctx) => aiAgents.list(deps, ctx, input.query.filter, input.query.limit) } satisfies RouteHandlers<typeof ag.listAiAgents>,
    getAiAgent: { handle: (input, ctx) => aiAgents.get(deps, ctx, input.params.aiAgentId) } satisfies RouteHandlers<typeof ag.getAiAgent>,
    saveAiAgent: { handle: (input, ctx) => aiAgents.save(deps, ctx, input.params.aiAgentId, input.body) } satisfies RouteHandlers<typeof ag.saveAiAgent>,
    copyAiAgent: {
      handle: (input, ctx) => aiAgents.copy(deps, ctx, input.params.aiAgentId, input.body.name), resultRef: (out) => out.id, replay: (ref, ctx) => aiAgents.get(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof ag.copyAiAgent>,
    archiveAiAgent: { handle: (input, ctx) => aiAgents.archive(deps, ctx, input.params.aiAgentId) } satisfies RouteHandlers<typeof ag.archiveAiAgent>,
    shareAiAgent: { handle: (input, ctx) => aiAgents.share(deps, ctx, input.params.aiAgentId, input.body) } satisfies RouteHandlers<typeof ag.shareAiAgent>,
    revokeAiAgentShare: { handle: (input, ctx) => aiAgents.revoke(deps, ctx, input.params.aiAgentId, input.params.shareId) } satisfies RouteHandlers<typeof ag.revokeAiAgentShare>,
    listAiAgentShares: { handle: (input, ctx) => aiAgents.shares(deps, ctx, input.params.aiAgentId) } satisfies RouteHandlers<typeof ag.listAiAgentShares>,
    // Data pipelines (D235).
    createPipeline: { handle: (input, ctx) => pipelines.create(deps, ctx, input.body), resultRef: (out) => out.id, replay: (ref, ctx) => pipelines.get(deps, ctx, ref!) } satisfies RouteHandlers<typeof pl.createPipeline>,
    listPipelines: { handle: (input, ctx) => pipelines.list(deps, ctx, input.query.archived, input.query.limit) } satisfies RouteHandlers<typeof pl.listPipelines>,
    getPipeline: { handle: (input, ctx) => pipelines.get(deps, ctx, input.params.pipelineId) } satisfies RouteHandlers<typeof pl.getPipeline>,
    savePipeline: { handle: (input, ctx) => pipelines.save(deps, ctx, input.params.pipelineId, input.body) } satisfies RouteHandlers<typeof pl.savePipeline>,
    previewPipeline: { handle: (input, ctx) => pipelines.preview(deps, ctx, input.params.pipelineId, input.body.document) } satisfies RouteHandlers<typeof pl.previewPipeline>,
    runPipeline: {
      handle: (input, ctx) => pipelines.run(deps, ctx, input.params.pipelineId), resultRef: (out) => `${out.pipelineId}.${out.id}`,
      // A retry: the run the first request started, as it stands now.
      replay: async (ref, ctx) => { const [pipelineId, runId] = ref!.split('.'); return (await pipelines.runs(deps, ctx, pipelineId!)).runs.find((r) => r.id === runId)!; },
    } satisfies RouteHandlers<typeof pl.runPipeline>,
    listPipelineRuns: { handle: (input, ctx) => pipelines.runs(deps, ctx, input.params.pipelineId) } satisfies RouteHandlers<typeof pl.listPipelineRuns>,
    getPipelineRun: { handle: (input, ctx) => pipelines.readRun(deps, ctx, input.params.runId) } satisfies RouteHandlers<typeof pl.getPipelineRun>,
    archivePipeline: { handle: (input, ctx) => pipelines.archive(deps, ctx, input.params.pipelineId) } satisfies RouteHandlers<typeof pl.archivePipeline>,
    // Pipeline schedules (D241).
    setPipelineSchedule: { handle: (input, ctx) => pipelines.setSchedule(deps, ctx, input.params.pipelineId, input.body) } satisfies RouteHandlers<typeof pl.setPipelineSchedule>,
    removePipelineSchedule: { handle: (input, ctx) => pipelines.removeSchedule(deps, ctx, input.params.pipelineId) } satisfies RouteHandlers<typeof pl.removePipelineSchedule>,
    resumePipelineSchedule: { handle: (input, ctx) => pipelines.resumeSchedule(deps, ctx, input.params.pipelineId) } satisfies RouteHandlers<typeof pl.resumePipelineSchedule>,
    // Process analyses (D234).
    createProcess: { handle: (input, ctx) => processes.create(deps, ctx, input.body), resultRef: (out) => out.id, replay: (ref, ctx) => processes.get(deps, ctx, ref!) } satisfies RouteHandlers<typeof pr.createProcess>,
    listProcesses: { handle: (input, ctx) => processes.list(deps, ctx, input.query.filter, input.query.limit) } satisfies RouteHandlers<typeof pr.listProcesses>,
    getProcess: { handle: (input, ctx) => processes.get(deps, ctx, input.params.processId) } satisfies RouteHandlers<typeof pr.getProcess>,
    saveProcess: { handle: (input, ctx) => processes.save(deps, ctx, input.params.processId, input.body) } satisfies RouteHandlers<typeof pr.saveProcess>,
    readProcessAnalysis: { handle: (input, ctx) => processes.analysis(deps, ctx, input.params.processId) } satisfies RouteHandlers<typeof pr.readProcessAnalysis>,
    copyProcess: { handle: (input, ctx) => processes.copy(deps, ctx, input.params.processId, input.body.name), resultRef: (out) => out.id, replay: (ref, ctx) => processes.get(deps, ctx, ref!) } satisfies RouteHandlers<typeof pr.copyProcess>,
    archiveProcess: { handle: (input, ctx) => processes.archive(deps, ctx, input.params.processId) } satisfies RouteHandlers<typeof pr.archiveProcess>,
    shareProcess: { handle: (input, ctx) => processes.share(deps, ctx, input.params.processId, input.body) } satisfies RouteHandlers<typeof pr.shareProcess>,
    revokeProcessShare: { handle: (input, ctx) => processes.revoke(deps, ctx, input.params.processId, input.params.shareId) } satisfies RouteHandlers<typeof pr.revokeProcessShare>,
    listProcessShares: { handle: (input, ctx) => processes.shares(deps, ctx, input.params.processId) } satisfies RouteHandlers<typeof pr.listProcessShares>,
    exportProcess: {
      handle: (input, ctx) => processes.exportProcess(deps, ctx, input.params.processId, input.body.folderId),
      resultRef: (out) => out.file.id,
      replay: async (ref, ctx) => ({ file: await deps.services.call(getExport, { params: { fileId: ref! } }, { request: ctx.request, correlationId: ctx.correlationId }) }),
    } satisfies RouteHandlers<typeof pr.exportProcess>,
    // Reports (D233).
    createReport: { handle: (input, ctx) => reports.create(deps, ctx, input.body.name), resultRef: (out) => out.id, replay: (ref, ctx) => reports.get(deps, ctx, ref!) } satisfies RouteHandlers<typeof rp.createReport>,
    listReports: { handle: (input, ctx) => reports.list(deps, ctx, input.query.filter, input.query.limit) } satisfies RouteHandlers<typeof rp.listReports>,
    getReport: { handle: (input, ctx) => reports.get(deps, ctx, input.params.reportId) } satisfies RouteHandlers<typeof rp.getReport>,
    saveReport: { handle: (input, ctx) => reports.save(deps, ctx, input.params.reportId, input.body) } satisfies RouteHandlers<typeof rp.saveReport>,
    readReportBlocks: { handle: (input, ctx) => reports.blocks(deps, ctx, input.params.reportId) } satisfies RouteHandlers<typeof rp.readReportBlocks>,
    copyReport: { handle: (input, ctx) => reports.copy(deps, ctx, input.params.reportId, input.body.name), resultRef: (out) => out.id, replay: (ref, ctx) => reports.get(deps, ctx, ref!) } satisfies RouteHandlers<typeof rp.copyReport>,
    archiveReport: { handle: (input, ctx) => reports.archive(deps, ctx, input.params.reportId) } satisfies RouteHandlers<typeof rp.archiveReport>,
    shareReport: { handle: (input, ctx) => reports.share(deps, ctx, input.params.reportId, input.body) } satisfies RouteHandlers<typeof rp.shareReport>,
    revokeReportShare: { handle: (input, ctx) => reports.revoke(deps, ctx, input.params.reportId, input.params.shareId) } satisfies RouteHandlers<typeof rp.revokeReportShare>,
    listReportShares: { handle: (input, ctx) => reports.shares(deps, ctx, input.params.reportId) } satisfies RouteHandlers<typeof rp.listReportShares>,
    exportReport: {
      handle: (input, ctx) => reports.exportReport(deps, ctx, input.params.reportId, input.body.folderId),
      resultRef: (out) => out.file.id,
      replay: async (ref, ctx) => ({ file: await deps.services.call(getExport, { params: { fileId: ref! } }, { request: ctx.request, correlationId: ctx.correlationId }) }),
    } satisfies RouteHandlers<typeof rp.exportReport>,
    // Workbooks (D232).
    createWorkbook: {
      handle: (input, ctx) => workbooks.create(deps, ctx, input.body.name),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => workbooks.get(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof wb.createWorkbook>,
    listWorkbooks: { handle: (input, ctx) => workbooks.list(deps, ctx, input.query.filter, input.query.limit) } satisfies RouteHandlers<typeof wb.listWorkbooks>,
    getWorkbook: { handle: (input, ctx) => workbooks.get(deps, ctx, input.params.workbookId) } satisfies RouteHandlers<typeof wb.getWorkbook>,
    saveWorkbook: { handle: (input, ctx) => workbooks.save(deps, ctx, input.params.workbookId, input.body) } satisfies RouteHandlers<typeof wb.saveWorkbook>,
    readWorkbookRanges: { handle: (input, ctx) => workbooks.readRanges(deps, ctx, input.params.workbookId) } satisfies RouteHandlers<typeof wb.readWorkbookRanges>,
    copyWorkbook: {
      handle: (input, ctx) => workbooks.copy(deps, ctx, input.params.workbookId, input.body.name),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => workbooks.get(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof wb.copyWorkbook>,
    archiveWorkbook: { handle: (input, ctx) => workbooks.archive(deps, ctx, input.params.workbookId) } satisfies RouteHandlers<typeof wb.archiveWorkbook>,
    shareWorkbook: { handle: (input, ctx) => workbooks.share(deps, ctx, input.params.workbookId, input.body) } satisfies RouteHandlers<typeof wb.shareWorkbook>,
    revokeWorkbookShare: { handle: (input, ctx) => workbooks.revoke(deps, ctx, input.params.workbookId, input.params.shareId) } satisfies RouteHandlers<typeof wb.revokeWorkbookShare>,
    listWorkbookShares: { handle: (input, ctx) => workbooks.shares(deps, ctx, input.params.workbookId) } satisfies RouteHandlers<typeof wb.listWorkbookShares>,
    exportWorkbook: {
      handle: (input, ctx) => workbooks.exportWorkbook(deps, ctx, input.params.workbookId, input.body.folderId),
      resultRef: (out) => out.file.id,
      // A retry: the file the first request made, as its maker sees it now.
      replay: async (ref, ctx) => ({ file: await deps.services.call(getExport, { params: { fileId: ref! } }, { request: ctx.request, correlationId: ctx.correlationId }) }),
    } satisfies RouteHandlers<typeof wb.exportWorkbook>,
    recordWorkspaceInteraction: { handle: (input, ctx) => interactions.recordInteraction(deps, ctx, input.body) } satisfies RouteHandlers<typeof recordWorkspaceInteraction>,
    saveView: {
      handle: (input, ctx) => views.save(deps, ctx, input.body),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => views.read(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof saveView>,
    listViews: { handle: async (input, ctx) => ({ views: await views.list(deps, ctx, input.query) }) } satisfies RouteHandlers<typeof listViews>,
    openView: { handle: (input, ctx) => views.open(deps, ctx, input.params.viewId) } satisfies RouteHandlers<typeof openView>,
    renameView: {
      handle: (input, ctx) => views.rename(deps, ctx, input.params.viewId, input.body.name, input.body.lockVersion),
    } satisfies RouteHandlers<typeof renameView>,
    archiveView: { handle: (input, ctx) => views.archive(deps, ctx, input.params.viewId) } satisfies RouteHandlers<typeof archiveView>,
    favouriteView: {
      handle: (input, ctx) => views.favourite(deps, ctx, input.params.viewId, input.body.grid),
    } satisfies RouteHandlers<typeof favouriteView>,
    unfavouriteView: { handle: (input, ctx) => views.unfavourite(deps, ctx, input.params.viewId) } satisfies RouteHandlers<typeof unfavouriteView>,
    runView: { handle: (input, ctx) => views.run(deps, ctx, input.params.viewId) } satisfies RouteHandlers<typeof runView>,
    // Analysis over object sets (37.8).
    createAnalysis: { handle: (input, ctx) => analyses.create(deps, ctx, input.body) } satisfies RouteHandlers<typeof anc.createAnalysis>,
    createAnalysisFromTurn: { handle: (input, ctx) => analyses.fromTurn(deps, ctx, input.body) } satisfies RouteHandlers<typeof anc.createAnalysisFromTurn>,
    readAnalysis: { handle: (input, ctx) => analyses.read(deps, ctx, input.params.manifestId, input.query.analysisId) } satisfies RouteHandlers<typeof anc.readAnalysis>,
    runAnalysis: { handle: (input, ctx) => analyses.run(deps, ctx, input.params.manifestId, input.body) } satisfies RouteHandlers<typeof anc.runAnalysis>,
    copyView: {
      handle: (input, ctx) => views.copy(deps, ctx, input.params.viewId, input.body.name),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => views.read(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof copyView>,
    getDashboard: { handle: async (_input, ctx) => ({ tiles: await views.dashboard(deps, ctx) }) } satisfies RouteHandlers<typeof getDashboard>,
    moveTile: { handle: (input, ctx) => views.moveTile(deps, ctx, input.params.tileId, input.body.grid) } satisfies RouteHandlers<typeof moveTile>,

    shareView: { handle: (input, ctx) => sharing.share(deps, ctx, input.params.viewId, input.body) } satisfies RouteHandlers<typeof shareView>,
    revokeShare: {
      handle: (input, ctx) => sharing.revoke(deps, ctx, input.params.viewId, input.params.shareId),
    } satisfies RouteHandlers<typeof revokeShare>,
    listShares: {
      handle: async (input, ctx) => ({ shares: await sharing.list(deps, ctx, input.params.viewId) }),
    } satisfies RouteHandlers<typeof listShares>,
    getSharingPolicy: { handle: (_input, ctx) => sharing.readPolicy(deps, ctx) } satisfies RouteHandlers<typeof getSharingPolicy>,
    setOrganisationSharingPolicy: {
      handle: (input, ctx) => sharing.setOrganisationPolicy(deps, ctx, input.body),
    } satisfies RouteHandlers<typeof setOrganisationSharingPolicy>,
    setScopeSharingPolicy: {
      handle: (input, ctx) => sharing.setScopePolicy(deps, ctx, input.params.scopeId, input.body.viewSharingPolicy),
    } satisfies RouteHandlers<typeof setScopeSharingPolicy>,

    transferViews: {
      handle: (input, ctx) => transfers.transfer(deps, ctx, input.body.membershipId, input.body.reason),
    } satisfies RouteHandlers<typeof transferViews>,
    listInheritedViews: {
      handle: async (_input, ctx) => ({ inherited: await transfers.inherited(deps, ctx) }),
    } satisfies RouteHandlers<typeof listInheritedViews>,
    reviewInheritedView: {
      handle: (input, ctx) => transfers.review(deps, ctx, input.params.flagId, input.body.decision),
    } satisfies RouteHandlers<typeof reviewInheritedView>,

    getPreferences: { handle: (_input, ctx) => shell.preferences(deps, ctx) } satisfies RouteHandlers<typeof getPreferences>,
    readRail: { handle: (_input, ctx) => shell.rail(deps, ctx) } satisfies RouteHandlers<typeof readRail>,
    readBriefing: { handle: ({ query }, ctx) => briefing(deps, ctx, query.since) } satisfies RouteHandlers<typeof readBriefing>,
    followResource: { handle: ({ body }, ctx) => follows.follow(deps, ctx, body) } satisfies RouteHandlers<typeof followResource>,
    unfollowResource: { handle: ({ params }, ctx) => follows.unfollow(deps, ctx, params.followId) } satisfies RouteHandlers<typeof unfollowResource>,
    listFollows: { handle: async (_input, ctx) => ({ follows: await follows.follows(deps, ctx) }) } satisfies RouteHandlers<typeof listFollows>,
    updatePreferences: { handle: (input, ctx) => shell.updatePreferences(deps, ctx, input.body) } satisfies RouteHandlers<typeof updatePreferences>,
    markHomeSeen: { handle: (_input, ctx) => shell.markHomeSeen(deps, ctx) } satisfies RouteHandlers<typeof markHomeSeen>,
    listFavourites: {
      handle: async (_input, ctx) => ({ favourites: await shell.favourites(deps, ctx) }),
    } satisfies RouteHandlers<typeof listFavourites>,
    addFavourite: { handle: (input, ctx) => shell.addFavourite(deps, ctx, input.body.target) } satisfies RouteHandlers<typeof addFavourite>,
    removeFavourite: {
      handle: (input, ctx) => shell.removeFavourite(deps, ctx, input.params.favouriteId),
    } satisfies RouteHandlers<typeof removeFavourite>,
    listTerminologySkins: {
      handle: async (_input, ctx) => ({ skins: await shell.skins(deps, ctx) }),
    } satisfies RouteHandlers<typeof listTerminologySkins>,
    setTerminologySkin: { handle: (input, ctx) => shell.setSkin(deps, ctx, input.body) } satisfies RouteHandlers<typeof setTerminologySkin>,
    supersedeTerminologySkin: {
      handle: (input, ctx) => shell.supersedeSkin(deps, ctx, input.params.skinId),
    } satisfies RouteHandlers<typeof supersedeTerminologySkin>,
  };
}
