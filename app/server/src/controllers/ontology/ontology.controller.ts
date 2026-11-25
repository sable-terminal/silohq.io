// The ontology's endpoints: parsed input to the services and back. A keyed operation keeps
// a reference to its result, so a retry under the same key reads what the first produced.

import { rankObjectTypes as rankTypes } from '../../services/ontology/embeddings.service.ts';
import type { rankObjectTypes } from '../../contracts/ontology/embedding.contract.ts';
import type { putFunction, putInterface, putLinkType, putObjectType, putSharedProperty } from '../../contracts/ontology/element.contract.ts';
import type { getActiveVersion, getManifest, getVersionManifest, listVersions } from '../../contracts/ontology/manifest.contract.ts';
import type { listPropertyMappings } from '../../contracts/ontology/mapping.contract.ts';
import type { listFieldAliases, removeFieldAlias, setFieldAlias } from '../../contracts/ontology/fieldAlias.contract.ts';
import * as aliases from '../../services/ontology/fieldAliases.service.ts';
import type { ElementKind } from '../../contracts/ontology/proposal.contract.ts';
import type { deprecateElement, openRollback, retireElement } from '../../contracts/ontology/lifecycle.contract.ts';
import type { listFieldProfiles, profileConnection as profileContract } from '../../contracts/ontology/profile.contract.ts';
import type {
  abandonBranch, approveProposal, confirmDecisions, getBranch, getBranchChanges, getProposal, listBranches, listProposals, mergeProposal,
  openBranch, rebaseBranch, rejectProposal, startDerivation, submitProposal, withdrawProposal,
} from '../../contracts/ontology/proposal.contract.ts';
import type { saveObjectSet, getObjectSet, listObjectSets, archiveObjectSet } from '../../contracts/ontology/objectSet.contract.ts';
import type { HandlerContext, RouteHandlers } from '../../infra/http.infra.ts';
import { confirmDecisions as confirm, startDerivation as derive } from '../../services/ontology/derivation.service.ts';
import { deprecateElement as deprecate, openRollback as rollback, retireElement as retire } from '../../services/ontology/lifecycle.service.ts';
import { listProfiles, profileConnection } from '../../services/ontology/profiles.service.ts';
import type { OntologyDeps } from '../../services/ontology/deps.service.ts';
import * as elements from '../../services/ontology/elements.service.ts';
import * as sets from '../../services/ontology/objectSets.service.ts';
import * as versioning from '../../services/ontology/versioning.service.ts';

/** A commit's result, read back from the version it wrote. */
async function replayCommit(deps: OntologyDeps, ctx: HandlerContext, ref: string | undefined, kind: ElementKind) {
  const [versionId, elementId] = (ref ?? '.').split('.');
  const manifest = await versioning.getVersionManifest(deps, ctx, versionId!);
  const list = { object_type: manifest.objectTypes, link_type: manifest.linkTypes, shared_property: manifest.sharedProperties,
    interface: manifest.interfaces, function: manifest.functions }[kind] as { id: string }[];
  return { version: manifest.version, element: list.find((e) => e.id === elementId) as never };
}

export function ontologyController(deps: OntologyDeps) {
  // Result references hold ids joined by dots (the keyspace allows no slash).
  const commitRef = (out: { version: { id: string }; element: { id: string } }) => `${out.version.id}.${out.element.id}`;
  return {
    // Narrowing a compile vocabulary (decision 2026-11-15)
    rankObjectTypes: {
      handle: ({ body }, ctx) => rankTypes(deps, ctx, body),
    } satisfies RouteHandlers<typeof rankObjectTypes>,
    // Reads
    getVersionManifest: {
      handle: ({ params }, ctx) => versioning.getVersionManifest(deps, ctx, params.versionId),
    } satisfies RouteHandlers<typeof getVersionManifest>,
    getManifest: {
      handle: ({ query }, ctx) => versioning.getManifest(deps, ctx, query.branchId),
    } satisfies RouteHandlers<typeof getManifest>,
    getActiveVersion: {
      handle: ({ query }, ctx) => versioning.getActiveVersion(deps, ctx, query.branchId),
    } satisfies RouteHandlers<typeof getActiveVersion>,
    setFieldAlias: {
      handle: ({ body }, ctx) => aliases.setFieldAlias(deps, ctx, body),
    } satisfies RouteHandlers<typeof setFieldAlias>,
    removeFieldAlias: {
      handle: ({ params }, ctx) => aliases.removeFieldAlias(deps, ctx, params.aliasId),
    } satisfies RouteHandlers<typeof removeFieldAlias>,
    listFieldAliases: {
      handle: ({ query }, ctx) => aliases.listFieldAliases(deps, ctx, query.connectionId),
    } satisfies RouteHandlers<typeof listFieldAliases>,
    listPropertyMappings: {
      handle: ({ params }, ctx) => versioning.listPropertyMappings(deps, ctx, params.objectTypeId),
    } satisfies RouteHandlers<typeof listPropertyMappings>,
    listVersions: {
      handle: async ({ query }, ctx) => ({ versions: await versioning.listVersions(deps, ctx, query.branchId, query.limit) }),
    } satisfies RouteHandlers<typeof listVersions>,

    // Elements
    putObjectType: {
      handle: ({ params, body }, ctx) => elements.putObjectType(deps, ctx, params.branchId, params.apiName, body),
      resultRef: commitRef, replay: (ref, ctx) => replayCommit(deps, ctx, ref, 'object_type'),
    } satisfies RouteHandlers<typeof putObjectType>,
    putLinkType: {
      handle: ({ params, body }, ctx) => elements.putLinkType(deps, ctx, params.branchId, params.apiName, body),
      resultRef: commitRef, replay: (ref, ctx) => replayCommit(deps, ctx, ref, 'link_type'),
    } satisfies RouteHandlers<typeof putLinkType>,
    putSharedProperty: {
      handle: ({ params, body }, ctx) => elements.putSharedProperty(deps, ctx, params.branchId, params.apiName, body),
      resultRef: commitRef, replay: (ref, ctx) => replayCommit(deps, ctx, ref, 'shared_property'),
    } satisfies RouteHandlers<typeof putSharedProperty>,
    putInterface: {
      handle: ({ params, body }, ctx) => elements.putInterface(deps, ctx, params.branchId, params.apiName, body),
      resultRef: commitRef, replay: (ref, ctx) => replayCommit(deps, ctx, ref, 'interface'),
    } satisfies RouteHandlers<typeof putInterface>,
    putFunction: {
      handle: ({ params, body }, ctx) => elements.putFunction(deps, ctx, params.branchId, params.apiName, body),
      resultRef: commitRef, replay: (ref, ctx) => replayCommit(deps, ctx, ref, 'function'),
    } satisfies RouteHandlers<typeof putFunction>,

    // Branches
    openBranch: {
      handle: ({ body }, ctx) => versioning.openBranch(deps, ctx, body.name),
      resultRef: (out) => out.id, replay: (ref, ctx) => versioning.getBranch(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof openBranch>,
    listBranches: {
      handle: async ({ query }, ctx) => ({ branches: await versioning.listBranches(deps, ctx, query.status === 'open', query.limit) }),
    } satisfies RouteHandlers<typeof listBranches>,
    getBranch: {
      handle: ({ params }, ctx) => versioning.getBranch(deps, ctx, params.branchId),
    } satisfies RouteHandlers<typeof getBranch>,
    getBranchChanges: {
      handle: ({ params }, ctx) => versioning.getBranchChanges(deps, ctx, params.branchId),
    } satisfies RouteHandlers<typeof getBranchChanges>,
    abandonBranch: {
      handle: ({ params }, ctx) => versioning.abandonBranch(deps, ctx, params.branchId),
    } satisfies RouteHandlers<typeof abandonBranch>,
    rebaseBranch: {
      handle: ({ params, body }, ctx) => versioning.rebaseBranch(deps, ctx, params.branchId, body.resolutions),
    } satisfies RouteHandlers<typeof rebaseBranch>,

    // Proposals
    submitProposal: {
      handle: ({ params, body }, ctx) => versioning.submitProposal(deps, ctx, params.branchId, body),
      resultRef: (out) => out.id, replay: (ref, ctx) => versioning.getProposal(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof submitProposal>,
    listProposals: {
      handle: async ({ query }, ctx) => ({ proposals: await versioning.listProposals(deps, ctx, query.status === 'open', query.limit) }),
    } satisfies RouteHandlers<typeof listProposals>,
    getProposal: {
      handle: ({ params }, ctx) => versioning.getProposal(deps, ctx, params.proposalId),
    } satisfies RouteHandlers<typeof getProposal>,
    approveProposal: {
      handle: ({ params, body }, ctx) => versioning.approveProposal(deps, ctx, params.proposalId, body.permission),
    } satisfies RouteHandlers<typeof approveProposal>,
    rejectProposal: {
      handle: ({ params }, ctx) => versioning.rejectProposal(deps, ctx, params.proposalId),
    } satisfies RouteHandlers<typeof rejectProposal>,
    withdrawProposal: {
      handle: ({ params }, ctx) => versioning.withdrawProposal(deps, ctx, params.proposalId),
    } satisfies RouteHandlers<typeof withdrawProposal>,
    mergeProposal: {
      handle: ({ params }, ctx) => versioning.mergeProposal(deps, ctx, params.proposalId),
      resultRef: (out) => `${out.proposal.id}.${out.version.id}`,
      replay: async (ref, ctx) => {
        const [proposalId, versionId] = ref!.split('.');
        const manifest = await versioning.getVersionManifest(deps, ctx, versionId!);
        return { proposal: await versioning.getProposal(deps, ctx, proposalId!), version: manifest.version };
      },
    } satisfies RouteHandlers<typeof mergeProposal>,

    // Derivation
    startDerivation: {
      handle: ({ body }, ctx) => derive(deps, ctx, body.connectionId, { profile: body.profile ?? true, overlap: body.overlap ?? true }),
      resultRef: (out) => out.id, replay: (ref, ctx) => versioning.getProposal(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof startDerivation>,
    deprecateElement: {
      handle: ({ params, body }, ctx) => deprecate(deps, ctx, params.kind, params.elementId, body),
    } satisfies RouteHandlers<typeof deprecateElement>,
    retireElement: {
      handle: ({ params }, ctx) => retire(deps, ctx, params.kind, params.elementId),
    } satisfies RouteHandlers<typeof retireElement>,
    openRollback: {
      handle: ({ body }, ctx) => rollback(deps, ctx, body),
    } satisfies RouteHandlers<typeof openRollback>,
    profileConnection: {
      handle: ({ params, body }, ctx) => profileConnection(deps, ctx, params.connectionId, body.objects),
    } satisfies RouteHandlers<typeof profileContract>,
    listFieldProfiles: {
      handle: async ({ params, query }, ctx) => ({ profiles: await listProfiles(deps, ctx, params.connectionId, query.depth) }),
    } satisfies RouteHandlers<typeof listFieldProfiles>,
    confirmDecisions: {
      handle: ({ params, body }, ctx) => confirm(deps, ctx, params.proposalId, body.decisions),
      resultRef: (out) => `${out.proposal.id}.${out.version?.id ?? ''}.${out.followUpProposalId ?? ''}`,
      replay: async (ref, ctx) => {
        const [proposalId, versionId, followUp] = ref!.split('.');
        return {
          proposal: await versioning.getProposal(deps, ctx, proposalId!),
          version: versionId ? (await versioning.getVersionManifest(deps, ctx, versionId)).version : null,
          followUpProposalId: followUp || null,
        };
      },
    } satisfies RouteHandlers<typeof confirmDecisions>,

    // Object sets
    saveObjectSet: {
      handle: ({ body }, ctx) => sets.saveObjectSet(deps, ctx, body),
      resultRef: (out) => out.id, replay: (ref, ctx) => sets.getObjectSet(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof saveObjectSet>,
    listObjectSets: {
      handle: async ({ query }, ctx) => ({ objectSets: await sets.listObjectSets(deps, ctx, query.limit) }),
    } satisfies RouteHandlers<typeof listObjectSets>,
    getObjectSet: {
      handle: ({ params }, ctx) => sets.getObjectSet(deps, ctx, params.objectSetId),
    } satisfies RouteHandlers<typeof getObjectSet>,
    archiveObjectSet: {
      handle: ({ params }, ctx) => sets.archiveObjectSet(deps, ctx, params.objectSetId),
    } satisfies RouteHandlers<typeof archiveObjectSet>,
  };
}

