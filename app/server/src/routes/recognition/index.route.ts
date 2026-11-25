// recognition (spec 38): the noticing half of Silo. Generic detectors compute findings over
// the organisation's own ontology, thresholds learn only from organisation dispositions, a
// model may order findings but never decides one exists, and each person keeps Lenses.
// Association analysis states co-occurrence in fixed, non-causal language, and investigation
// asks four questions of the estate, naming what it cannot answer without Capture.

import {
  computeAssociations, designateOutcome, investigate, listAssociations, listOutcomes, revokeOutcome,
} from '../../contracts/recognition/association.contract.ts';
import {
  configureDetector, getRun, listConfigurations, listDetectors, runDetectors,
} from '../../contracts/recognition/detector.contract.ts';
import {
  dispositionFinding, getFinding, listFindings, listFindingsRaisedSince, listObjectFindings, rankFindings,
} from '../../contracts/recognition/finding.contract.ts';
import {
  copyLens, createLens, listLenses, listLensShares, listSharedLenses, openLens, recordLensDisposition, revokeLensShare, shareLens, updateLens,
} from '../../contracts/recognition/lens.contract.ts';
import { recognitionController } from '../../controllers/recognition/recognition.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';

export const service = defineService({
  name: 'recognition',
  needs: { postgres: ['control'] },
  create(deps) {
    const c = recognitionController({ databases: deps.databases, services: deps.services, logger: deps.logger });
    return {
      routes: [
        route(listDetectors, c.listDetectors), route(configureDetector, c.configureDetector), route(listConfigurations, c.listConfigurations),
        route(runDetectors, c.runDetectors), route(getRun, c.getRun),
        route(listFindings, c.listFindings), route(listFindingsRaisedSince, c.listFindingsRaisedSince), route(getFinding, c.getFinding), route(listObjectFindings, c.listObjectFindings),
        route(dispositionFinding, c.dispositionFinding), route(rankFindings, c.rankFindings),
        route(designateOutcome, c.designateOutcome), route(revokeOutcome, c.revokeOutcome), route(listOutcomes, c.listOutcomes),
        route(computeAssociations, c.computeAssociations), route(listAssociations, c.listAssociations), route(investigate, c.investigate),
        route(createLens, c.createLens), route(listLenses, c.listLenses), route(updateLens, c.updateLens),
        route(shareLens, c.shareLens), route(listLensShares, c.listLensShares), route(revokeLensShare, c.revokeLensShare),
        route(openLens, c.openLens), route(listSharedLenses, c.listSharedLenses), route(copyLens, c.copyLens),
        route(recordLensDisposition, c.recordLensDisposition),
      ],
    };
  },
});
