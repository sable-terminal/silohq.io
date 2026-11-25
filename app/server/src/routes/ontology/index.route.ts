// ontology (spec Part IV): the organisation's one ontology. Elements authored on branches,
// derivation from connections' declared schemas, reviewed proposals merged into immutable
// versions, saved object sets, and the version manifest every reader of the ontology uses.

import { listFieldAliases, removeFieldAlias, setFieldAlias } from '../../contracts/ontology/fieldAlias.contract.ts';
import { rankObjectTypes } from '../../contracts/ontology/embedding.contract.ts';
import { putFunction, putInterface, putLinkType, putObjectType, putSharedProperty } from '../../contracts/ontology/element.contract.ts';
import { getActiveVersion, getManifest, getVersionManifest, listVersions } from '../../contracts/ontology/manifest.contract.ts';
import { listPropertyMappings } from '../../contracts/ontology/mapping.contract.ts';
import { archiveObjectSet, getObjectSet, listObjectSets, saveObjectSet } from '../../contracts/ontology/objectSet.contract.ts';
import { deprecateElement, openRollback, retireElement } from '../../contracts/ontology/lifecycle.contract.ts';
import { listFieldProfiles, profileConnection } from '../../contracts/ontology/profile.contract.ts';
import {
  abandonBranch, approveProposal, confirmDecisions, getBranch, getBranchChanges, getProposal, listBranches, listProposals, mergeProposal,
  openBranch, rebaseBranch, rejectProposal, startDerivation, submitProposal, withdrawProposal,
} from '../../contracts/ontology/proposal.contract.ts';
import { ontologyController } from '../../controllers/ontology/ontology.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition, type Worker } from '../../infra/service.infra.ts';
import { createRetirementReminders, type RetirementReminders } from '../../services/ontology/retirementNotices.service.ts';
import { REMINDER_SWEEP_MS, retirementReminderWorker } from '../../workers/ontology/retirementReminders.worker.ts';

export function createOntologyService(options: {
  now?: () => Date;
  /** Send due retirement reminders on a timer (default true); a test runs the sweep itself. */
  sweep?: boolean;
  /** A test's handle on the reminder sweep. */
  onReminders?: (reminders: RetirementReminders) => void;
} = {}): ServiceDefinition {
  return defineService({
    name: 'ontology',
    // redis-data holds the idempotency keys of the keyed operations.
    needs: { postgres: ['control'], redis: ['data'] },
    create(deps) {
      const ontologyDeps = { databases: deps.databases, services: deps.services, logger: deps.logger, now: options.now };
      const c = ontologyController(ontologyDeps);
      const reminders = createRetirementReminders(ontologyDeps);
      options.onReminders?.(reminders);
      const workers: Worker[] = options.sweep === false ? [] : [retirementReminderWorker(reminders, REMINDER_SWEEP_MS, deps.logger)];
      return {
        workers,
        routes: [
          route(getVersionManifest, c.getVersionManifest), route(getManifest, c.getManifest), route(getActiveVersion, c.getActiveVersion),
          route(listVersions, c.listVersions), route(listPropertyMappings, c.listPropertyMappings),
          route(setFieldAlias, c.setFieldAlias), route(removeFieldAlias, c.removeFieldAlias), route(listFieldAliases, c.listFieldAliases),
          route(putObjectType, c.putObjectType), route(putLinkType, c.putLinkType), route(putSharedProperty, c.putSharedProperty),
          route(putInterface, c.putInterface), route(putFunction, c.putFunction),
          route(openBranch, c.openBranch), route(listBranches, c.listBranches), route(getBranch, c.getBranch),
          route(getBranchChanges, c.getBranchChanges), route(abandonBranch, c.abandonBranch), route(rebaseBranch, c.rebaseBranch),
          route(submitProposal, c.submitProposal), route(listProposals, c.listProposals), route(getProposal, c.getProposal),
          route(approveProposal, c.approveProposal), route(rejectProposal, c.rejectProposal), route(withdrawProposal, c.withdrawProposal),
          route(mergeProposal, c.mergeProposal),
          route(startDerivation, c.startDerivation), route(confirmDecisions, c.confirmDecisions),
          route(profileConnection, c.profileConnection), route(listFieldProfiles, c.listFieldProfiles),
          route(deprecateElement, c.deprecateElement), route(retireElement, c.retireElement), route(openRollback, c.openRollback),
          route(saveObjectSet, c.saveObjectSet), route(listObjectSets, c.listObjectSets), route(getObjectSet, c.getObjectSet),
          route(archiveObjectSet, c.archiveObjectSet), route(rankObjectTypes, c.rankObjectTypes),
        ],
      };
    },
  });
}

export const service = createOntologyService();
