// Findings and their review (spec 19.4): a finding is a proposal, never a configuration. A
// reviewer holding discovery.review approves or rejects it; approving one whose catalogue was
// read can promote it: a private connector (built by the visual, deterministic route), its
// first version and a draft connection bound to the scanning agent's pool, created through
// connect-registry as the reviewer, who needs connector.build and connection.create there.
// Nothing is connected: credentials come through the normal path, and the connection is
// verified like any other (spec 17). With proposeOntology, the connection's structure enters
// derivation and confirmation (spec 22) as the reviewer.
//
// Every call made for a promotion is keyed by the finding, so a retried review replays what
// was created rather than creating it twice.

import { createConnection } from '../../contracts/connect-registry/connection.contract.ts';
import { createConnector, createManifestVersion } from '../../contracts/connect-registry/connector.contract.ts';
import { foundStructure, proposedLink, proposedObjectType, type FindingView } from '../../contracts/discovery/discovery.contract.ts';
import { startDerivation } from '../../contracts/ontology/proposal.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { DiscoveryFinding } from '../../models/connect/discoveryFinding.model.ts';
import { agentRepo, discoveryAuthorisationRepo, discoveryFindingRepo, discoveryRunRepo } from '../../repos/connect/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { demand, enabledOrRefuse, memberOf, recordDiscoveryEvent, type Context, type DiscoveryDeps } from './deps.service.ts';
import { promotedManifest, snake } from './proposals.service.ts';

const parseArray = <T>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }, raw: unknown): T[] =>
  (Array.isArray(raw) ? raw : []).flatMap((v) => { const r = schema.safeParse(v); return r.success ? [r.data as T] : []; });

export function findingView(f: DiscoveryFinding): FindingView {
  return {
    id: f.id, runId: f.runId, host: f.host, found: foundStructure.parse(f.found), proposedConnectorType: f.proposedConnectorType,
    proposedObjectTypes: parseArray(proposedObjectType, f.proposedObjectTypes), proposedLinks: parseArray(proposedLink, f.proposedLinks),
    confidence: f.confidence === null ? null : Number(f.confidence), reviewDecision: f.reviewDecision, reviewedBy: f.reviewedBy,
    reviewedAt: f.reviewedAt, promotedConnectorId: f.promotedConnectorId, promotedConnectionId: f.promotedConnectionId,
    ontologyProposalId: f.ontologyProposalId, createdAt: f.createdAt,
  };
}

export function createFindings(deps: DiscoveryDeps) {
  const control = deps.databases.pool('control');

  async function load(ctx: Context, id: string): Promise<DiscoveryFinding> {
    const f = await inTransaction(control, ctx.request, (db) => discoveryFindingRepo.findById(db, id), { readOnly: true });
    if (!f) throw new AppError('not_found', 'no such finding', { code: 'discovery.finding_not_found' });
    return f;
  }

  return {
    async list(ctx: Context, filter: { runId?: string | undefined; decision?: string | undefined; limit: number }): Promise<FindingView[]> {
      await enabledOrRefuse(deps, ctx);
      await demand(deps, ctx, ['discovery.review', 'discovery.authorise']);
      const rows = await inTransaction(control, ctx.request, (db) => discoveryFindingRepo.list(db, filter), { readOnly: true });
      return rows.map(findingView);
    },

    async get(ctx: Context, id: string): Promise<FindingView> {
      await enabledOrRefuse(deps, ctx);
      await demand(deps, ctx, ['discovery.review', 'discovery.authorise']);
      return findingView(await load(ctx, id));
    },

    async review(ctx: Context, id: string, input: {
      decision: 'approve' | 'reject';
      promote?: { owningScopeId: string; name?: string | undefined; proposeOntology: boolean } | undefined;
    }): Promise<FindingView> {
      await enabledOrRefuse(deps, ctx);
      const membershipId = memberOf(ctx);
      await demand(deps, ctx, ['discovery.review']);
      const finding = await load(ctx, id);
      if (finding.reviewDecision !== 'pending') {
        // A retried promotion that recorded its decision answers what it did.
        if (finding.reviewedBy === membershipId && (finding.reviewDecision === 'approved') === (input.decision === 'approve')) return findingView(finding);
        throw new AppError('conflict', `the finding is already ${finding.reviewDecision}`, { code: 'discovery.finding_reviewed' });
      }
      const now = new Date().toISOString();
      const event = { organisationId: finding.organisationId, correlationId: ctx.correlationId, request: ctx.request };

      let promoted: { connectorId: string; connectionId: string } | undefined;
      if (input.decision === 'approve' && input.promote !== undefined) {
        const view = findingView(finding);
        const manifest = promotedManifest(view.found, view.proposedLinks, finding.host);
        if (manifest === undefined) {
          throw new AppError('conflict', 'this finding has no catalogue to build a connector from; approve it without promoting, or build one', {
            code: 'discovery.not_promotable',
          });
        }
        const agent = await inTransaction(control, ctx.request, async (db) => {
          const run = (await discoveryRunRepo.findById(db, finding.runId))!;
          const authorisation = (await discoveryAuthorisationRepo.findById(db, run.authorisationId))!;
          return agentRepo.findById(db, authorisation.agentId);
        }, { readOnly: true });
        if (agent === undefined) throw new AppError('conflict', 'the agent that found it is gone', { code: 'discovery.agent_not_found' });
        const options = (step: string) => ({ request: ctx.request, correlationId: ctx.correlationId, idempotencyKey: `finding-${id}-${step}` });
        const product = view.found.product ?? 'Database';
        const connector = await deps.services.call(createConnector, {
          body: {
            slug: `disc-${snake(finding.host).replaceAll('_', '-').slice(0, 30)}-${id.slice(-8)}`.replace(/-+/g, '-'),
            name: `${product} on ${finding.host}`.slice(0, 200), provider: product.slice(0, 200), sourceRoute: 'visual',
            description: `Found by discovery run ${finding.runId}.`,
          },
        }, options('connector'));
        await deps.services.call(createManifestVersion, { params: { connectorId: connector.id }, body: { document: manifest as never } }, options('version'));
        const connection = await deps.services.call(createConnection, {
          body: {
            connectorId: connector.id, name: input.promote.name ?? `${product} on ${finding.host}`.slice(0, 200),
            owningScopeId: input.promote.owningScopeId, agentPoolId: agent.poolId,
          },
        }, options('connection'));
        promoted = { connectorId: connector.id, connectionId: connection.id };
      }

      let updated = await inTransaction(control, ctx.request, async (db) => {
        const locked = (await discoveryFindingRepo.findForUpdate(db, id))!;
        if (locked.reviewDecision !== 'pending') throw new AppError('conflict', 'the finding was reviewed meanwhile', { code: 'discovery.finding_reviewed' });
        const row = (await discoveryFindingRepo.update(db, id, {
          reviewDecision: input.decision === 'approve' ? 'approved' : 'rejected', reviewedBy: membershipId, reviewedAt: now,
          ...(promoted === undefined ? {} : { promotedConnectorId: promoted.connectorId, promotedConnectionId: promoted.connectionId }),
        }))!;
        await recordDiscoveryEvent(db, {
          ...event, event: 'finding_reviewed', resource: { type: 'discovery_finding', id },
          detail: { decision: row.reviewDecision, host: finding.host.slice(0, 200), promoted: promoted !== undefined },
        });
        if (promoted !== undefined) {
          await recordDiscoveryEvent(db, {
            ...event, event: 'finding_promoted_to_connector', resource: { type: 'discovery_finding', id },
            detail: { connector_id: promoted.connectorId, connection_id: promoted.connectionId },
          });
        }
        return row;
      });

      if (promoted !== undefined && input.promote?.proposeOntology === true) {
        try {
          const proposal = await deps.services.call(startDerivation, { body: { connectionId: promoted.connectionId } }, {
            request: ctx.request, correlationId: ctx.correlationId, idempotencyKey: `finding-${id}-derivation`,
          });
          updated = await inTransaction(control, ctx.request, async (db) => {
            const row = (await discoveryFindingRepo.update(db, id, { ontologyProposalId: proposal.id }))!;
            await recordDiscoveryEvent(db, {
              ...event, event: 'finding_proposed_to_ontology', resource: { type: 'discovery_finding', id }, detail: { ontology_proposal_id: proposal.id },
            });
            return row;
          });
        } catch (error) {
          // The promotion stands; the derivation can be started from the connection later.
          deps.logger.info('a promoted finding did not enter derivation', {
            event: 'discovery.derivation_not_started', resourceId: id, outcome: isAppError(error) ? error.code : 'error',
          });
        }
      }
      return findingView(updated);
    },
  };
}

export type Findings = ReturnType<typeof createFindings>;
