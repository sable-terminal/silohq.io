// Applying a decided proposal (spec 49.6): "a person decides → target system applies as that
// person". Each kind goes through its system's own confirmation path, called with the
// deciding person's request, so the artefact names them as its confirmer and every check
// that system makes is made of them. Nothing here writes another system's tables.

import { proposeActionType, publishActionTypeVersion } from '../../contracts/actions/actionType.contract.ts';
import { setConnectionWrites } from '../../contracts/conformance/writeClass.contract.ts';
import { confirmBuild } from '../../contracts/connector-builder/build.contract.ts';
import { decideHealProposal } from '../../contracts/connector-maintenance/maintenance.contract.ts';
import { saveObjectSet } from '../../contracts/ontology/objectSet.contract.ts';
import { createApp } from '../../contracts/studio/app.contract.ts';
import { createObjectViewLayout } from '../../contracts/studio/layout.contract.ts';
import { favouriteView, openView, saveView } from '../../contracts/workspace/view.contract.ts';
import { createCron } from '../../contracts/scheduler/cron.contract.ts';
import { getManifest } from '../../contracts/ontology/manifest.contract.ts';
import {
  confirmDecisions, getProposal as getOntologyProposal, listProposals as listOntologyProposals, mergeProposal, rebaseBranch,
} from '../../contracts/ontology/proposal.contract.ts';
import { configureDetector } from '../../contracts/recognition/detector.contract.ts';
import { confirmResolutionProposal, rejectResolutionProposal } from '../../contracts/resolution/proposal.contract.ts';
import { confirmEdge } from '../../contracts/simulation/graph.contract.ts';
import type { FdeEngagement, FdeProposal } from '../../models/fde/index.model.ts';
import { AppError } from '../../utils/errors.util.ts';
import { asPrincipal, type Context, type FdeDeps } from './deps.service.ts';

export type Decision = 'accept' | 'reject' | 'defer';

/** The record an applied proposal created or changed, as its fde_proposal_targets column. */
export interface Applied { column: string; id: string }

type Payload = Record<string, unknown>;

/** The derivation proposal holding a decision now: decisions left undecided move to a follow-up (ontology 22.6). */
async function holderOf(deps: FdeDeps, ctx: Context, payload: Payload): Promise<{ id: string; branchId: string }> {
  const decisionId = String(payload['decisionId']);
  const call = { request: ctx.request, correlationId: ctx.correlationId };
  const first = await deps.services.call(getOntologyProposal, { params: { proposalId: String(payload['ontologyProposalId']) } }, call);
  const holds = (p: { status: string; decisions?: { id: string; status: string }[] | null | undefined }) =>
    p.status === 'in_review' && (p.decisions ?? []).some((d) => d.id === decisionId && d.status === 'undecided');
  if (holds(first)) return { id: first.id, branchId: first.branchId };
  const open = await deps.services.call(listOntologyProposals, { query: { status: 'open', limit: 200 } }, call);
  const found = open.proposals.find((p) => holds(p as never));
  if (found === undefined) throw new AppError('conflict', 'the ontology no longer holds this decision open', { code: 'fde.decision_gone' });
  return { id: found.id, branchId: found.branchId };
}

export async function applyDecision(deps: FdeDeps, ctx: Context, e: FdeEngagement, p: FdeProposal, decision: Decision,
  edited: Payload, ontologyPrincipal: string | undefined): Promise<Applied | undefined> {
  const call = { request: ctx.request, correlationId: ctx.correlationId };
  if (decision === 'defer') return undefined;
  switch (p.kind) {
    case 'estate_entry':
      // The scope list is the engagement's own record (50.4): nothing to apply elsewhere.
      return undefined;

    case 'action_type': {
      // Proposed and confirmed by the person who decided (42.12: never a service principal), as they edited it.
      if (decision === 'reject') return undefined;
      const type = await deps.services.call(proposeActionType, { body: {
        apiName: String(edited['apiName']), displayName: String(edited['displayName']), owningScopeId: String(edited['owningScopeId']),
      } }, { ...call, idempotencyKey: `fde.${p.id}.type` });
      await deps.services.call(publishActionTypeVersion, { params: { actionTypeId: type.id }, body: edited['definition'] as never },
        { ...call, idempotencyKey: `fde.${p.id}.version` });
      return { column: 'actionTypeId', id: type.id };
    }

    case 'connector_manifest':
      // The build's version is the connection's already: accepting records that a person stands behind it (16.3).
      return decision === 'reject' ? undefined : { column: 'connectorManifestId', id: String(edited['manifestId']) };

    case 'connector_mapping': {
      // Confirmed in the builder as the person, with their corrections; the first acceptance verifies the connection
      // when they hold connector.verify (16.3).
      const connectionId = String(edited['connectionId']);
      const edits = p.payload as Record<string, unknown>;
      const changed = (k: string) => JSON.stringify(edits[k]) !== JSON.stringify(edited[k]);
      await deps.services.call(confirmBuild, { params: { connectionId }, body: { decisions: [{
        object: String(edited['object']), accept: decision !== 'reject',
        ...(decision !== 'reject' && changed('objectType') ? { objectType: String(edited['objectType']) } : {}),
        ...(decision !== 'reject' && changed('identifier') ? { identifier: edited['identifier'] as string[] } : {}),
        ...(decision !== 'reject' && changed('properties') ? { properties: edited['properties'] as { field: string; property: string }[] } : {}),
      }] } }, { ...call, idempotencyKey: `fde.${p.id}.mapping` });
      return decision === 'reject' ? undefined : { column: 'connectionId', id: connectionId };
    }

    case 'write_enablement': {
      // Enabled by the person who decided, with connector.enable_writes; the service checks the
      // passed run is still on the connection's current manifest version.
      if (decision === 'reject') return undefined;
      const connectionId = String(edited['connectionId']);
      await deps.services.call(setConnectionWrites, { params: { connectionId }, body: { enabled: true } }, call);
      return { column: 'connectionId', id: connectionId };
    }

    case 'studio_app': {
      // Created as the person who decided, who owns it; marked as generated (50.9).
      if (decision === 'reject') return undefined;
      const created = await deps.services.call(createApp, { body: {
        name: String(edited['name']), generatedBy: 'ai_fde', template: edited['template'] === undefined ? undefined as never
          : { name: String(edited['template']) as never, bindings: edited['bindings'] as never },
      } }, { ...call, idempotencyKey: `fde.${p.id}.app` });
      return { column: 'appId', id: created.app.id };
    }

    case 'cron_notify': {
      // Owned by the person who accepted it, so it outlives the engagement (50.10). Notify only:
      // the AI FDE never proposes a mutate action. The view is the person's own; its object set is the subject.
      if (decision === 'reject') return undefined;
      const opened = await deps.services.call(openView, { params: { viewId: String(edited['savedViewId']) } }, call);
      if (opened.view.objectSetId === null) {
        throw new AppError('conflict', 'the dashboard view no longer names an object set', { code: 'fde.cron_subject_unknown' });
      }
      const cron = await deps.services.call(createCron, { body: {
        name: String(edited['name']), subject: { objectSetId: opened.view.objectSetId }, trigger: { schedule: String(edited['schedule']) },
        condition: edited['condition'] as never, actions: [{ kind: 'notify', recipients: (edited['recipients'] ?? []) as string[] }],
      } }, { ...call, idempotencyKey: `fde.${p.id}.cron` });
      return { column: 'automationId', id: cron.id };
    }

    case 'object_view_layout': {
      // A layout draft the person owns; it becomes the type's when a reviewer approves it (34.6).
      if (decision === 'reject') return undefined;
      const created = await deps.services.call(createObjectViewLayout, { body: {
        objectTypeId: String(edited['objectTypeId']), name: String(edited['name']), definition: edited['definition'] as never, generatedBy: 'ai_fde',
      } }, { ...call, idempotencyKey: `fde.${p.id}.layout` });
      return { column: 'appId', id: created.app.id };
    }

    case 'dashboard': {
      // The person's own saved view over the type's objects, on their dashboard (37.2).
      if (decision === 'reject') return undefined;
      const set = await deps.services.call(saveObjectSet, { body: { name: String(edited['name']), definition: edited['objectSet'] as never } },
        { ...call, idempotencyKey: `fde.${p.id}.set` });
      const view = await deps.services.call(saveView, { body: { kind: 'object_set', name: String(edited['name']), objectSetId: set.id } },
        { ...call, idempotencyKey: `fde.${p.id}.view` });
      await deps.services.call(favouriteView, { params: { viewId: view.id }, body: {} }, call);
      return { column: 'savedViewId', id: view.id };
    }

    case 'heal_review': {
      // The person's decision on the repair itself (17.5): accepting tests and applies it, rejecting closes it.
      const proposalId = String(edited['healProposalId']);
      await deps.services.call(decideHealProposal, { params: { proposalId }, body: { decision: decision === 'reject' ? 'reject' : 'accept' } }, call);
      return decision === 'reject' ? undefined : { column: 'healProposalId', id: proposalId };
    }

    case 'reliability_finding':
      // A finding is acknowledged, not applied: what a person does about it is theirs (51.11).
      return undefined;

    case 'object_type':
    case 'link_type': {
      const holder = await holderOf(deps, ctx, edited);
      // The follow-up proposal's branch began at main as it was; bring it up to date first, as the
      // ontology principal, so a link finds the types accepted before it.
      if (ontologyPrincipal !== undefined) {
        await deps.services.call(rebaseBranch, { params: { branchId: holder.branchId }, body: {} },
          { request: asPrincipal(e.organisationId, ontologyPrincipal), correlationId: ctx.correlationId })
          .catch(() => undefined);
      }
      const decisionId = String(edited['decisionId']);
      const edits = edited !== (p.payload as Payload) && JSON.stringify(edited['definition']) !== JSON.stringify((p.payload as Payload)['definition']);
      const action = decision === 'reject' ? { decisionId, action: 'reject' as const }
        : edits ? { decisionId, action: 'correct' as const, ...(p.kind === 'object_type' ? { objectType: edited['definition'] } : { linkType: edited['definition'] }) }
          : { decisionId, action: 'accept' as const };
      const confirmed = await deps.services.call(confirmDecisions, { params: { proposalId: holder.id }, body: { decisions: [action as never] } },
        { ...call, idempotencyKey: `${p.id}.decide` });
      if (decision === 'reject' || confirmed.version === null) return undefined;
      await deps.services.call(mergeProposal, { params: { proposalId: holder.id } }, { ...call, idempotencyKey: `${p.id}.merge` });
      const manifest = await deps.services.call(getManifest, { query: {} }, call);
      const apiName = String(edited['apiName']);
      const made = p.kind === 'object_type' ? manifest.objectTypes.find((t) => t.apiName === apiName) : manifest.linkTypes.find((l) => l.apiName === apiName);
      return made === undefined ? undefined : { column: p.kind === 'object_type' ? 'objectTypeId' : 'linkTypeId', id: made.id };
    }

    case 'resolution_pair': {
      const proposalId = String(edited['resolutionProposalId']);
      if (decision === 'reject') {
        await deps.services.call(rejectResolutionProposal, { params: { proposalId } }, call);
        return undefined;
      }
      await deps.services.call(confirmResolutionProposal, { params: { proposalId } }, call);
      return { column: 'resolutionProposalId', id: proposalId };
    }

    case 'detector_configuration': {
      if (decision === 'reject') return undefined;
      const configured = await deps.services.call(configureDetector, {
        params: { objectTypeId: String(edited['objectTypeId']), detector: edited['detector'] as never },
        body: { properties: edited['properties'] as string[], timeField: null, enabled: true },
      }, call);
      return { column: 'detectorConfigurationId', id: configured.id };
    }

    case 'dependency_edge': {
      if (decision === 'reject') return undefined;
      // 51.10: a foreign key gives the edge and its direction, never its kind or lead time; the person states them.
      if (edited['kind'] === undefined || edited['leadTime'] === undefined) {
        throw new AppError('validation', 'an edge is accepted with its kind and lead time, which the person states', { code: 'fde.edge_needs_kind_and_lead_time' });
      }
      const confirmed = await deps.services.call(confirmEdge, {
        params: { edgeId: String(edited['edgeId']) },
        body: {
          kind: edited['kind'] as never, leadTime: edited['leadTime'] as never, buffer: (edited['buffer'] ?? null) as never,
          reason: String(edited['reason'] ?? 'confirmed from an AI FDE proposal'), version: Number(edited['version']),
        },
      }, call);
      return { column: 'dependencyEdgeId', id: confirmed.edge.id };
    }

    default:
      throw new AppError('conflict', `${p.kind} proposals are not applied in this build`, { code: 'fde.kind_not_applied' });
  }
}

/** Which payload fields a person may change when accepting each kind. */
export const EDITABLE: Readonly<Partial<Record<FdeProposal['kind'], readonly string[]>>> = {
  action_type: ['apiName', 'displayName', 'definition'],
  connector_mapping: ['objectType', 'identifier', 'properties'],
  studio_app: ['name'],
  object_view_layout: ['name'],
  cron_notify: ['name', 'schedule', 'recipients'],
  dashboard: ['name'],
  object_type: ['definition'],
  link_type: ['definition'],
  detector_configuration: ['properties'],
  dependency_edge: ['kind', 'leadTime', 'buffer', 'reason'],
};
