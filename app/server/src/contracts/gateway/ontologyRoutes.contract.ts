// The ontology in the product (spec 21 to 25): reading the ontology and its versions,
// authoring on branches, review and merge, derivation and saved object sets. The gateway
// decides the route's permission first; the ontology service decides again with the exact
// permission an action needs (approving with ontology.confirm or ontology.manage, editing
// visual metadata with ontology.manage) and refuses what the gateway let through.

import * as el from '../ontology/element.contract.ts';
import * as mf from '../ontology/manifest.contract.ts';
import * as mp from '../ontology/mapping.contract.ts';
import * as fa from '../ontology/fieldAlias.contract.ts';
import * as os from '../ontology/objectSet.contract.ts';
import * as lc from '../ontology/lifecycle.contract.ts';
import * as pf from '../ontology/profile.contract.ts';
import * as pr from '../ontology/proposal.contract.ts';
import { runObjectSet } from '../executor/result.contract.ts';
import { z } from 'zod';
import { definePublicRoute } from './publicRoute.contract.ts';

const view = { permission: 'ontology.view' };

export const readOntology = definePublicRoute({
  name: 'readOntology', method: 'GET', path: '/ontology', session: 'complete', permission: view,
  query: mf.getManifest.query, response: mf.getManifest.response, forwards: mf.getManifest,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const readOntologyVersion = definePublicRoute({
  name: 'readOntologyVersion', method: 'GET', path: '/ontology/versions/:versionId', session: 'complete', permission: view,
  params: mf.getVersionManifest.params, response: mf.getVersionManifest.response, forwards: mf.getVersionManifest,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listOntologyVersions = definePublicRoute({
  name: 'listOntologyVersions', method: 'GET', path: '/ontology/versions', session: 'complete', permission: view,
  query: mf.listVersions.query, response: mf.listVersions.response, forwards: mf.listVersions,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const listOntologyBranches = definePublicRoute({
  name: 'listOntologyBranches', method: 'GET', path: '/ontology/branches', session: 'complete', permission: view,
  query: pr.listBranches.query, response: pr.listBranches.response, forwards: pr.listBranches,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const openOntologyBranch = definePublicRoute({
  name: 'openOntologyBranch', method: 'POST', path: '/ontology/branches', session: 'complete', permission: { permission: 'ontology.branch' },
  body: pr.openBranch.body, response: pr.openBranch.response, status: 201, forwards: pr.openBranch,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const readOntologyBranch = definePublicRoute({
  name: 'readOntologyBranch', method: 'GET', path: '/ontology/branches/:branchId', session: 'complete', permission: view,
  params: pr.getBranch.params, response: pr.getBranch.response, forwards: pr.getBranch,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const readOntologyBranchChanges = definePublicRoute({
  name: 'readOntologyBranchChanges', method: 'GET', path: '/ontology/branches/:branchId/changes', session: 'complete', permission: view,
  params: pr.getBranchChanges.params, response: pr.getBranchChanges.response, forwards: pr.getBranchChanges,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const rebaseOntologyBranch = definePublicRoute({
  name: 'rebaseOntologyBranch', method: 'POST', path: '/ontology/branches/:branchId/rebase', session: 'complete',
  permission: { permission: 'ontology.branch' },
  params: pr.rebaseBranch.params, body: pr.rebaseBranch.body, response: pr.rebaseBranch.response, forwards: pr.rebaseBranch,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const abandonOntologyBranch = definePublicRoute({
  name: 'abandonOntologyBranch', method: 'POST', path: '/ontology/branches/:branchId/abandon', session: 'complete',
  permission: { permission: 'ontology.branch' },
  params: pr.abandonBranch.params, response: pr.abandonBranch.response, forwards: pr.abandonBranch,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const putOntologyObjectType = definePublicRoute({
  name: 'putOntologyObjectType', method: 'PUT', path: '/ontology/branches/:branchId/object-types/:apiName', session: 'complete',
  permission: { permission: 'ontology.propose' },
  params: el.putObjectType.params, body: el.putObjectType.body, response: el.putObjectType.response, forwards: el.putObjectType,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const putOntologyLinkType = definePublicRoute({
  name: 'putOntologyLinkType', method: 'PUT', path: '/ontology/branches/:branchId/link-types/:apiName', session: 'complete',
  permission: { permission: 'ontology.propose' },
  params: el.putLinkType.params, body: el.putLinkType.body, response: el.putLinkType.response, forwards: el.putLinkType,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const putOntologySharedProperty = definePublicRoute({
  name: 'putOntologySharedProperty', method: 'PUT', path: '/ontology/branches/:branchId/shared-properties/:apiName', session: 'complete',
  permission: { permission: 'ontology.manage' },
  params: el.putSharedProperty.params, body: el.putSharedProperty.body, response: el.putSharedProperty.response, forwards: el.putSharedProperty,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const putOntologyInterface = definePublicRoute({
  name: 'putOntologyInterface', method: 'PUT', path: '/ontology/branches/:branchId/interfaces/:apiName', session: 'complete',
  permission: { permission: 'ontology.manage' },
  params: el.putInterface.params, body: el.putInterface.body, response: el.putInterface.response, forwards: el.putInterface,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const putOntologyFunction = definePublicRoute({
  name: 'putOntologyFunction', method: 'PUT', path: '/ontology/branches/:branchId/functions/:apiName', session: 'complete',
  permission: { permission: 'function.author' },
  params: el.putFunction.params, body: el.putFunction.body, response: el.putFunction.response, forwards: el.putFunction,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const submitOntologyProposal = definePublicRoute({
  name: 'submitOntologyProposal', method: 'POST', path: '/ontology/branches/:branchId/proposals', session: 'complete',
  permission: { permission: 'ontology.propose' },
  params: pr.submitProposal.params, body: pr.submitProposal.body, response: pr.submitProposal.response, status: 201, forwards: pr.submitProposal,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const listOntologyProposals = definePublicRoute({
  name: 'listOntologyProposals', method: 'GET', path: '/ontology/proposals', session: 'complete', permission: view,
  query: pr.listProposals.query, response: pr.listProposals.response, forwards: pr.listProposals,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const readOntologyProposal = definePublicRoute({
  name: 'readOntologyProposal', method: 'GET', path: '/ontology/proposals/:proposalId', session: 'complete', permission: view,
  params: pr.getProposal.params, response: pr.getProposal.response, forwards: pr.getProposal,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

// The permission used to approve is in the body; the ontology service decides it.
export const approveOntologyProposal = definePublicRoute({
  name: 'approveOntologyProposal', method: 'POST', path: '/ontology/proposals/:proposalId/approvals', session: 'complete', permission: view,
  params: pr.approveProposal.params, body: pr.approveProposal.body, response: pr.approveProposal.response, forwards: pr.approveProposal,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const rejectOntologyProposal = definePublicRoute({
  name: 'rejectOntologyProposal', method: 'POST', path: '/ontology/proposals/:proposalId/reject', session: 'complete',
  permission: { permission: 'ontology.confirm' },
  params: pr.rejectProposal.params, response: pr.rejectProposal.response, forwards: pr.rejectProposal,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const withdrawOntologyProposal = definePublicRoute({
  name: 'withdrawOntologyProposal', method: 'POST', path: '/ontology/proposals/:proposalId/withdraw', session: 'complete',
  permission: { permission: 'ontology.propose' },
  params: pr.withdrawProposal.params, response: pr.withdrawProposal.response, forwards: pr.withdrawProposal,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const mergeOntologyProposal = definePublicRoute({
  name: 'mergeOntologyProposal', method: 'POST', path: '/ontology/proposals/:proposalId/merge', session: 'complete',
  permission: { permission: 'ontology.merge' },
  params: pr.mergeProposal.params, response: pr.mergeProposal.response, forwards: pr.mergeProposal,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const startOntologyDerivation = definePublicRoute({
  name: 'startOntologyDerivation', method: 'POST', path: '/ontology/derivations', session: 'complete',
  permission: { permission: 'ontology.propose' },
  body: pr.startDerivation.body, response: pr.startDerivation.response, status: 201, forwards: pr.startDerivation,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

/** Deprecates an element on main (spec 25.7): ontology.manage. */
export const deprecateOntologyElement = definePublicRoute({
  name: 'deprecateOntologyElement', method: 'POST', path: '/ontology/elements/:kind/:elementId/deprecation', session: 'complete',
  permission: { permission: 'ontology.manage' },
  params: lc.deprecateElement.params, body: lc.deprecateElement.body, response: lc.deprecateElement.response, forwards: lc.deprecateElement,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

/** Retires a deprecated element on main once its date has come (spec 25.7): ontology.manage. */
export const retireOntologyElement = definePublicRoute({
  name: 'retireOntologyElement', method: 'POST', path: '/ontology/elements/:kind/:elementId/retirement', session: 'complete',
  permission: { permission: 'ontology.manage' },
  params: lc.retireElement.params, response: lc.retireElement.response, forwards: lc.retireElement,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

/** Opens a rollback proposal to a prior main version (spec 25.8); merged under ontology.merge once approved. */
export const openOntologyRollback = definePublicRoute({
  name: 'openOntologyRollback', method: 'POST', path: '/ontology/rollbacks', session: 'complete',
  permission: { permission: 'ontology.propose' },
  body: lc.openRollback.body, response: lc.openRollback.response, status: 201, forwards: lc.openRollback,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

/** Profiles a connection's fields for derivation: counts only, read at the source (spec 22.3). */
export const profileOntologyConnection = definePublicRoute({
  name: 'profileOntologyConnection', method: 'POST', path: '/ontology/connections/:connectionId/profiles', session: 'complete',
  permission: { permission: 'ontology.propose' },
  params: pf.profileConnection.params, body: pf.profileConnection.body, response: pf.profileConnection.response, forwards: pf.profileConnection,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const listOntologyFieldProfiles = definePublicRoute({
  name: 'listOntologyFieldProfiles', method: 'GET', path: '/ontology/connections/:connectionId/profiles', session: 'complete',
  permission: { permission: 'ontology.view' },
  params: pf.listFieldProfiles.params, query: pf.listFieldProfiles.query, response: pf.listFieldProfiles.response, forwards: pf.listFieldProfiles,
  call: (input) => ({ params: input.params, query: input.query }), reply: (output) => output,
});

export const confirmOntologyDecisions = definePublicRoute({
  name: 'confirmOntologyDecisions', method: 'POST', path: '/ontology/proposals/:proposalId/decisions', session: 'complete',
  permission: { permission: 'ontology.confirm' },
  params: pr.confirmDecisions.params, body: pr.confirmDecisions.body, response: pr.confirmDecisions.response, forwards: pr.confirmDecisions,
  call: (input) => ({ params: input.params, body: input.body }), reply: (output) => output,
});

export const saveOntologyObjectSet = definePublicRoute({
  name: 'saveOntologyObjectSet', method: 'POST', path: '/ontology/object-sets', session: 'complete',
  permission: { permission: 'object_set.save' },
  body: os.saveObjectSet.body, response: os.saveObjectSet.response, status: 201, forwards: os.saveObjectSet,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const listOntologyObjectSets = definePublicRoute({
  name: 'listOntologyObjectSets', method: 'GET', path: '/ontology/object-sets', session: 'complete', permission: view,
  query: os.listObjectSets.query, response: os.listObjectSets.response, forwards: os.listObjectSets,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const readOntologyObjectSet = definePublicRoute({
  name: 'readOntologyObjectSet', method: 'GET', path: '/ontology/object-sets/:objectSetId', session: 'complete', permission: view,
  params: os.getObjectSet.params, response: os.getObjectSet.response, forwards: os.getObjectSet,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

/** What a saved object set holds now, read as the person (U6): its members' titles and the properties asked for. */
export const runOntologyObjectSet = definePublicRoute({
  name: 'runOntologyObjectSet', reads: true, method: 'POST', path: '/ontology/object-sets/:objectSetId/runs', session: 'complete', permission: view,
  params: os.getObjectSet.params,
  body: z.strictObject({ select: z.array(z.uuid()).max(200).optional() }),
  response: runObjectSet.response,
  forwards: runObjectSet,
  call: (input) => ({ body: { objectSetId: input.params.objectSetId, select: input.body.select ?? [], trigger: 'structured' as const } }),
  reply: (output) => output,
});

export const archiveOntologyObjectSet = definePublicRoute({
  name: 'archiveOntologyObjectSet', method: 'POST', path: '/ontology/object-sets/:objectSetId/archive', session: 'complete',
  permission: { permission: 'object_set.save' },
  params: os.archiveObjectSet.params, response: os.archiveObjectSet.response, forwards: os.archiveObjectSet,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listOntologyPropertyMappings = definePublicRoute({
  name: 'listOntologyPropertyMappings', method: 'GET', path: '/ontology/object-types/:objectTypeId/mappings', session: 'complete', permission: view,
  params: mp.listPropertyMappings.params, response: mp.listPropertyMappings.response, forwards: mp.listPropertyMappings,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

const ALIAS_DECIDER = 'ontology checks ontology.confirm and that the declarer is a person (spec 21.6, 21.17)';

export const setOntologyFieldAlias = definePublicRoute({
  name: 'setOntologyFieldAlias', method: 'PUT', path: '/ontology/field-aliases', session: 'complete', decidedByService: ALIAS_DECIDER,
  body: fa.setFieldAlias.body, response: fa.setFieldAlias.response, forwards: fa.setFieldAlias,
  call: (input) => ({ body: input.body }), reply: (output) => output,
});

export const removeOntologyFieldAlias = definePublicRoute({
  name: 'removeOntologyFieldAlias', method: 'DELETE', path: '/ontology/field-aliases/:aliasId', session: 'complete', decidedByService: ALIAS_DECIDER,
  params: fa.removeFieldAlias.params, response: fa.removeFieldAlias.response, forwards: fa.removeFieldAlias,
  call: (input) => ({ params: input.params }), reply: (output) => output,
});

export const listOntologyFieldAliases = definePublicRoute({
  name: 'listOntologyFieldAliases', method: 'GET', path: '/ontology/field-aliases', session: 'complete', permission: view,
  query: fa.listFieldAliases.query, response: fa.listFieldAliases.response, forwards: fa.listFieldAliases,
  call: (input) => ({ query: input.query }), reply: (output) => output,
});

export const ONTOLOGY_ROUTES = [
  runOntologyObjectSet,
  setOntologyFieldAlias, removeOntologyFieldAlias, listOntologyFieldAliases,
  readOntology, listOntologyPropertyMappings, readOntologyVersion, listOntologyVersions, listOntologyBranches, openOntologyBranch, readOntologyBranch,
  readOntologyBranchChanges, rebaseOntologyBranch, abandonOntologyBranch, putOntologyObjectType, putOntologyLinkType,
  putOntologySharedProperty, putOntologyInterface, putOntologyFunction, submitOntologyProposal, listOntologyProposals,
  readOntologyProposal, approveOntologyProposal, rejectOntologyProposal, withdrawOntologyProposal, mergeOntologyProposal,
  startOntologyDerivation, confirmOntologyDecisions, profileOntologyConnection, listOntologyFieldProfiles,
  deprecateOntologyElement, retireOntologyElement, openOntologyRollback, saveOntologyObjectSet, listOntologyObjectSets, readOntologyObjectSet,
  archiveOntologyObjectSet,
] as const;
