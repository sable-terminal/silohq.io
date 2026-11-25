// workspace (spec 33, 37): the person's shell (preferences, Home marker, favourites), the
// organisation's terminology skins, and saved views: private by default, shared within the
// sharing policy, re-run under the opener's own access, favourited onto a dashboard, and
// transferred to the admin above a removed member.

import { recordWorkspaceInteraction } from '../../contracts/workspace/interaction.contract.ts';
import {
  addFavourite, followResource, getPreferences, listFollows, readBriefing, readRail, unfollowResource, listFavourites, listTerminologySkins, markHomeSeen, removeFavourite, setTerminologySkin,
  supersedeTerminologySkin, updatePreferences,
} from '../../contracts/workspace/shell.contract.ts';
import {
  getSharingPolicy, listShares, revokeShare, setOrganisationSharingPolicy, setScopeSharingPolicy, shareView,
} from '../../contracts/workspace/sharing.contract.ts';
import { listInheritedViews, reviewInheritedView, transferViews } from '../../contracts/workspace/transfer.contract.ts';
import {
  archiveView, copyView, favouriteView, getDashboard, listViews, moveTile, openView, renameView, runView, saveView, unfavouriteView,
} from '../../contracts/workspace/view.contract.ts';
import * as wb from '../../contracts/workspace/workbook.contract.ts';
import * as rp from '../../contracts/workspace/report.contract.ts';
import * as pr from '../../contracts/workspace/process.contract.ts';
import * as pl from '../../contracts/workspace/pipeline.contract.ts';
import * as ag from '../../contracts/workspace/aiAgent.contract.ts';
import * as nbc from '../../contracts/workspace/notebook.contract.ts';
import * as anc from '../../contracts/workspace/analysis.contract.ts';
import * as mlc from '../../contracts/workspace/mlModel.contract.ts';
import { workspaceController } from '../../controllers/workspace/workspace.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { pipelineDueWorker } from '../../workers/workspace/pipelineDue.worker.ts';
import { createContractEngine } from '../../services/workspace/contractEngine.service.ts';
import type { QueryEngine } from '../../services/workspace/queryEngine.service.ts';

export interface WorkspaceOptions {
  engine?: QueryEngine;
  /** The pipeline schedules' due sweep (D241); on by default. */
  sweep?: boolean;
  /** How often the sweep looks; default 15 seconds. */
  sweepTickMs?: number;
  now?: () => number;
}

export function createWorkspaceService(options: WorkspaceOptions = {}) {
  return defineService({
    name: 'workspace',
    // redis-data: idempotency keys of the keyed operations, and each view's last result reference.
    needs: { postgres: ['control'], redis: ['data'] },
    create(deps) {
      const workspace = {
        databases: deps.databases, services: deps.services, data: deps.redis.data!, logger: deps.logger,
        engine: options.engine ?? createContractEngine(deps.services),
      };
      const c = workspaceController(workspace);
      const workers = options.sweep === false ? []
        : [pipelineDueWorker(workspace, { tickMs: options.sweepTickMs ?? 15_000, batch: 20, concurrency: 2, now: options.now ?? Date.now })];
      return {
        workers,
        routes: [
          route(recordWorkspaceInteraction, c.recordWorkspaceInteraction),
          route(wb.createWorkbook, c.createWorkbook), route(wb.listWorkbooks, c.listWorkbooks), route(wb.getWorkbook, c.getWorkbook),
          route(wb.saveWorkbook, c.saveWorkbook), route(wb.readWorkbookRanges, c.readWorkbookRanges), route(wb.copyWorkbook, c.copyWorkbook),
          route(wb.archiveWorkbook, c.archiveWorkbook), route(wb.shareWorkbook, c.shareWorkbook), route(wb.revokeWorkbookShare, c.revokeWorkbookShare),
          route(wb.listWorkbookShares, c.listWorkbookShares), route(wb.exportWorkbook, c.exportWorkbook),
          route(rp.createReport, c.createReport), route(rp.listReports, c.listReports), route(rp.getReport, c.getReport), route(rp.saveReport, c.saveReport),
          route(rp.readReportBlocks, c.readReportBlocks), route(rp.copyReport, c.copyReport), route(rp.archiveReport, c.archiveReport), route(rp.shareReport, c.shareReport),
          route(rp.revokeReportShare, c.revokeReportShare), route(rp.listReportShares, c.listReportShares), route(rp.exportReport, c.exportReport),
          route(pr.createProcess, c.createProcess), route(pr.listProcesses, c.listProcesses), route(pr.getProcess, c.getProcess), route(pr.saveProcess, c.saveProcess),
          route(pr.readProcessAnalysis, c.readProcessAnalysis), route(pr.copyProcess, c.copyProcess), route(pr.archiveProcess, c.archiveProcess),
          route(pr.shareProcess, c.shareProcess), route(pr.revokeProcessShare, c.revokeProcessShare), route(pr.listProcessShares, c.listProcessShares),
          route(pr.exportProcess, c.exportProcess),
          route(pl.createPipeline, c.createPipeline), route(pl.listPipelines, c.listPipelines), route(pl.getPipeline, c.getPipeline), route(pl.savePipeline, c.savePipeline),
          route(pl.previewPipeline, c.previewPipeline), route(pl.runPipeline, c.runPipeline), route(pl.listPipelineRuns, c.listPipelineRuns), route(pl.getPipelineRun, c.getPipelineRun),
          route(pl.archivePipeline, c.archivePipeline),
          route(pl.setPipelineSchedule, c.setPipelineSchedule), route(pl.removePipelineSchedule, c.removePipelineSchedule), route(pl.resumePipelineSchedule, c.resumePipelineSchedule),
          route(ag.createAiAgent, c.createAiAgent), route(ag.listAiAgents, c.listAiAgents), route(ag.getAiAgent, c.getAiAgent), route(ag.saveAiAgent, c.saveAiAgent),
          route(ag.copyAiAgent, c.copyAiAgent), route(ag.archiveAiAgent, c.archiveAiAgent), route(ag.shareAiAgent, c.shareAiAgent),
          route(ag.revokeAiAgentShare, c.revokeAiAgentShare), route(ag.listAiAgentShares, c.listAiAgentShares),
          route(nbc.createNotebook, c.createNotebook), route(nbc.listNotebooks, c.listNotebooks), route(nbc.getNotebook, c.getNotebook), route(nbc.saveNotebook, c.saveNotebook),
          route(nbc.askNotebookQuestion, c.askNotebookQuestion), route(nbc.runNotebook, c.runNotebook), route(nbc.copyNotebook, c.copyNotebook),
          route(nbc.archiveNotebook, c.archiveNotebook), route(nbc.shareNotebook, c.shareNotebook), route(nbc.revokeNotebookShare, c.revokeNotebookShare),
          route(nbc.listNotebookShares, c.listNotebookShares), route(nbc.exportNotebook, c.exportNotebook),
          route(mlc.createMlModel, c.createMlModel), route(mlc.listMlModels, c.listMlModels), route(mlc.getMlModel, c.getMlModel), route(mlc.saveMlModel, c.saveMlModel),
          route(mlc.trainMlModel, c.trainMlModel), route(mlc.listMlModelVersions, c.listMlModelVersions), route(mlc.getMlModelVersion, c.getMlModelVersion),
          route(mlc.publishMlModelVersion, c.publishMlModelVersion), route(mlc.predictMlModel, c.predictMlModel), route(mlc.archiveMlModel, c.archiveMlModel),
          route(mlc.shareMlModel, c.shareMlModel), route(mlc.revokeMlModelShare, c.revokeMlModelShare), route(mlc.listMlModelShares, c.listMlModelShares),
          route(saveView, c.saveView), route(listViews, c.listViews), route(openView, c.openView), route(renameView, c.renameView),
          route(archiveView, c.archiveView), route(favouriteView, c.favouriteView), route(unfavouriteView, c.unfavouriteView),
          route(runView, c.runView), route(copyView, c.copyView), route(getDashboard, c.getDashboard), route(moveTile, c.moveTile),
          route(anc.createAnalysis, c.createAnalysis), route(anc.createAnalysisFromTurn, c.createAnalysisFromTurn), route(anc.createAnalysisFromAppChart, c.createAnalysisFromAppChart), route(anc.readAnalysis, c.readAnalysis), route(anc.runAnalysis, c.runAnalysis),
          route(shareView, c.shareView), route(revokeShare, c.revokeShare), route(listShares, c.listShares),
          route(getSharingPolicy, c.getSharingPolicy), route(setOrganisationSharingPolicy, c.setOrganisationSharingPolicy),
          route(setScopeSharingPolicy, c.setScopeSharingPolicy),
          route(transferViews, c.transferViews), route(listInheritedViews, c.listInheritedViews), route(reviewInheritedView, c.reviewInheritedView),
          route(getPreferences, c.getPreferences), route(readRail, c.readRail), route(readBriefing, c.readBriefing),
          route(followResource, c.followResource), route(unfollowResource, c.unfollowResource), route(listFollows, c.listFollows), route(updatePreferences, c.updatePreferences), route(markHomeSeen, c.markHomeSeen),
          route(listFavourites, c.listFavourites), route(addFavourite, c.addFavourite), route(removeFavourite, c.removeFavourite),
          route(listTerminologySkins, c.listTerminologySkins), route(setTerminologySkin, c.setTerminologySkin),
          route(supersedeTerminologySkin, c.supersedeTerminologySkin),
        ],
      };
    },
  });
}

export const service = createWorkspaceService();
