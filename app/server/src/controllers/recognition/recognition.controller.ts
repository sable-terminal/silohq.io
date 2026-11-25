// The recognition service's endpoints: contracts to the services that do the work.

import type {
  computeAssociations, designateOutcome, investigate, listAssociations, listOutcomes, revokeOutcome,
} from '../../contracts/recognition/association.contract.ts';
import type {
  configureDetector, getRun, listConfigurations, listDetectors, runDetectors,
} from '../../contracts/recognition/detector.contract.ts';
import type {
  dispositionFinding, getFinding, listFindings, listFindingsRaisedSince, listObjectFindings, rankFindings,
} from '../../contracts/recognition/finding.contract.ts';
import type {
  copyLens, createLens, listLenses, listLensShares, listSharedLenses, openLens, recordLensDisposition, revokeLensShare, shareLens, updateLens,
} from '../../contracts/recognition/lens.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import * as associations from '../../services/recognition/associations.service.ts';
import * as configuration from '../../services/recognition/configuration.service.ts';
import type { RecognitionDeps } from '../../services/recognition/deps.service.ts';
import * as findings from '../../services/recognition/findings.service.ts';
import * as investigation from '../../services/recognition/investigation.service.ts';
import * as lenses from '../../services/recognition/lenses.service.ts';
import * as ranking from '../../services/recognition/ranking.service.ts';
import * as runs from '../../services/recognition/runs.service.ts';

export function recognitionController(deps: RecognitionDeps): {
  listDetectors: RouteHandlers<typeof listDetectors>;
  configureDetector: RouteHandlers<typeof configureDetector>;
  listConfigurations: RouteHandlers<typeof listConfigurations>;
  runDetectors: RouteHandlers<typeof runDetectors>;
  getRun: RouteHandlers<typeof getRun>;
  listFindings: RouteHandlers<typeof listFindings>;
  listFindingsRaisedSince: RouteHandlers<typeof listFindingsRaisedSince>;
  getFinding: RouteHandlers<typeof getFinding>;
  listObjectFindings: RouteHandlers<typeof listObjectFindings>;
  dispositionFinding: RouteHandlers<typeof dispositionFinding>;
  rankFindings: RouteHandlers<typeof rankFindings>;
  designateOutcome: RouteHandlers<typeof designateOutcome>;
  revokeOutcome: RouteHandlers<typeof revokeOutcome>;
  listOutcomes: RouteHandlers<typeof listOutcomes>;
  computeAssociations: RouteHandlers<typeof computeAssociations>;
  listAssociations: RouteHandlers<typeof listAssociations>;
  investigate: RouteHandlers<typeof investigate>;
  createLens: RouteHandlers<typeof createLens>;
  listLenses: RouteHandlers<typeof listLenses>;
  updateLens: RouteHandlers<typeof updateLens>;
  recordLensDisposition: RouteHandlers<typeof recordLensDisposition>;
  shareLens: RouteHandlers<typeof shareLens>;
  listLensShares: RouteHandlers<typeof listLensShares>;
  revokeLensShare: RouteHandlers<typeof revokeLensShare>;
  openLens: RouteHandlers<typeof openLens>;
  listSharedLenses: RouteHandlers<typeof listSharedLenses>;
  copyLens: RouteHandlers<typeof copyLens>;
} {
  return {
    listDetectors: { handle: async (_input, ctx) => ({ detectors: await configuration.listDetectors(deps, ctx) }) },
    configureDetector: {
      handle: (input, ctx) => configuration.configureDetector(deps, ctx, input.params.objectTypeId, input.params.detector, input.body),
    },
    listConfigurations: {
      handle: async (input, ctx) => ({ configurations: await configuration.listConfigurations(deps, ctx, input.params.objectTypeId) }),
    },
    runDetectors: { handle: (input, ctx) => runs.runDetectorsOn(deps, ctx, input.body) },
    getRun: { handle: (input, ctx) => configuration.getRun(deps, ctx, input.params.runId) },
    listFindingsRaisedSince: { handle: ({ body }, ctx) => findings.listFindingsRaisedSince(deps, ctx, body) },
    listFindings: {
      handle: (input, ctx) => findings.listFindings(deps, ctx, {
        objectTypeId: input.query.objectTypeId, detector: input.query.detector, detectorId: input.query.detectorId,
        includeSuperseded: input.query.includeSuperseded === 'true',
        lensId: input.query.lensId, limit: input.query.limit,
      }),
    },
    getFinding: { handle: (input, ctx) => findings.getFinding(deps, ctx, input.params.findingId, input.query.lensId) },
    listObjectFindings: {
      handle: (input, ctx) => findings.listObjectFindings(deps, ctx, input.params.objectTypeId, input.params.objectId, input.query.lensId),
    },
    dispositionFinding: { handle: (input, ctx) => findings.dispositionFinding(deps, ctx, input.params.findingId, input.body) },
    rankFindings: { handle: (input, ctx) => ranking.rankFindings(deps, ctx, input.body) },
    designateOutcome: { handle: (input, ctx) => associations.designateOutcome(deps, ctx, input.body) },
    revokeOutcome: { handle: (input, ctx) => associations.revokeOutcome(deps, ctx, input.params.outcomeId) },
    listOutcomes: { handle: (input, ctx) => associations.listOutcomes(deps, ctx, input.query.objectTypeId) },
    computeAssociations: { handle: (_input, ctx) => associations.computeAssociations(deps, ctx) },
    listAssociations: { handle: (input, ctx) => associations.listAssociations(deps, ctx, input.query) },
    investigate: { handle: (input, ctx) => investigation.investigate(deps, ctx, input.body) },
    createLens: { handle: (input, ctx) => lenses.createLens(deps, ctx, input.body) },
    listLenses: { handle: async (_input, ctx) => ({ lenses: await lenses.listLenses(deps, ctx) }) },
    updateLens: { handle: (input, ctx) => lenses.updateLens(deps, ctx, input.params.lensId, input.body) },
    recordLensDisposition: {
      handle: (input, ctx) => lenses.recordLensDisposition(deps, ctx, input.params.lensId, input.params.findingId, input.body.disposition),
    },
    shareLens: { handle: (input, ctx) => lenses.shareLens(deps, ctx, input.params.lensId, input.body) },
    listLensShares: { handle: (input, ctx) => lenses.listLensShares(deps, ctx, input.params.lensId) },
    revokeLensShare: {
      handle: async (input, ctx) => {
        await lenses.revokeLensShare(deps, ctx, input.params.shareId);
      },
    },
    openLens: { handle: (input, ctx) => lenses.openLens(deps, ctx, input.params.lensId) },
    listSharedLenses: { handle: (_input, ctx) => lenses.listSharedLenses(deps, ctx) },
    copyLens: { handle: (input, ctx) => lenses.copyLens(deps, ctx, input.params.lensId, input.body) },
  };
}
