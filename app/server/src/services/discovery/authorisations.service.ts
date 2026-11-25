// Scan authorisations (spec 19.2): one agent, explicit targets, the methods allowed, a host
// bound and an expiry; routed through an approval chain (spec 44) and usable only once
// approved, before it expires, until revoked.
//
// The authorisation and its chain are written in one transaction, as the schema intends (the
// key from the authorisation to its chain is deferred): the chain is the approvals service's
// shape (action.approval_chains, subject discovery_scan, a slot per approver) and approvals
// decides on it like any other. Its snapshot holds one condition: approvals_required people
// other than the requester, holding discovery.authorise (approvals checks it). How many: the
// organisation's default approval policy if it has one, and at least one (open decision
// 19.8, decided here on the safe side: a scan always needs a second person). The chain
// approves exactly the authorisation document whose hash the approver quotes, and expires
// no later than the authorisation.

import {
  MAX_AUTHORISATION_DAYS, type AuthorisationView, type DiscoveryMethod,
} from '../../contracts/discovery/discovery.contract.ts';
import type { ChainCondition } from '../../contracts/approvals/approval.contract.ts';
import { storedConditions } from '../approvals/snapshot.service.ts';
import { inTransaction, type Queryable } from '../../infra/postgres.infra.ts';
import type { ApprovalChain } from '../../models/action/approvalChain.model.ts';
import type { DiscoveryAuthorisation } from '../../models/connect/discoveryAuthorisation.model.ts';
import { approvalChainRepo, approvalPolicyRepo, approvalStepRepo } from '../../repos/action/index.repo.ts';
import { agentRepo, discoveryAuthorisationRepo, discoveryRunRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { demand, enabledOrRefuse, memberOf, recordDiscoveryEvent, type Context, type DiscoveryDeps } from './deps.service.ts';
import { authorisationDocument } from './proposals.service.ts';

const CONDITION = 'discovery_scan';
const DEFAULT_CHAIN_HOURS = 24;

export function authorisationView(a: DiscoveryAuthorisation, chain: ApprovalChain | undefined, now = Date.now()): AuthorisationView {
  const expired = Date.parse(a.expiresAt) <= now;
  const chainStatus = chain === undefined ? 'pending'
    : chain.status === 'pending' && Date.parse(chain.expiresAt) <= now ? 'expired' : chain.status;
  const status = a.revokedAt !== null ? 'revoked' : expired ? 'expired' : chainStatus;
  return {
    id: a.id, agentId: a.agentId, ranges: a.ranges, methods: a.methods as DiscoveryMethod[], maxHosts: a.maxHosts, expiresAt: a.expiresAt,
    authorisedBy: a.authorisedBy, approvalChainId: a.approvalChainId, status, documentHash: a.signedHash?.toString('hex') ?? ''.padEnd(64, '0'),
    createdAt: a.createdAt, revokedAt: a.revokedAt,
  };
}

export function createAuthorisations(deps: DiscoveryDeps, onRevoked: (db: Queryable, ctx: Context, authorisationId: string) => Promise<void>) {
  const control = deps.databases.pool('control');

  async function load(ctx: Context, id: string): Promise<{ authorisation: DiscoveryAuthorisation; chain: ApprovalChain | undefined }> {
    return inTransaction(control, ctx.request, async (db) => {
      const authorisation = await discoveryAuthorisationRepo.findById(db, id);
      if (!authorisation) throw new AppError('not_found', 'no such scan authorisation', { code: 'discovery.authorisation_not_found' });
      return { authorisation, chain: await approvalChainRepo.findById(db, authorisation.approvalChainId) };
    }, { readOnly: true });
  }

  return {
    load,

    async request(ctx: Context, input: { agentId: string; ranges: string[]; methods: DiscoveryMethod[]; maxHosts: number; expiresAt: string })
      : Promise<AuthorisationView> {
      await enabledOrRefuse(deps, ctx);
      const membershipId = memberOf(ctx);
      await demand(deps, ctx, ['discovery.authorise']);
      const organisationId = ctx.request.organisationId!;
      const now = Date.now();
      const expires = Date.parse(input.expiresAt);
      if (expires <= now + 60_000) throw new AppError('validation', 'an authorisation expires in the future', { code: 'discovery.expiry_past' });
      if (expires > now + MAX_AUTHORISATION_DAYS * 86_400_000) {
        throw new AppError('validation', `an authorisation is a window of at most ${MAX_AUTHORISATION_DAYS} days, not standing permission`, {
          code: 'discovery.expiry_too_far', details: { bound: 'days', limit: MAX_AUTHORISATION_DAYS },
        });
      }
      const id = uuidv7();
      const chainId = uuidv7();
      const { document, hash } = authorisationDocument({ id, organisationId, ...input, authorisedBy: membershipId });
      const created = await inTransaction(control, ctx.request, async (db) => {
        const agent = await agentRepo.findById(db, input.agentId);
        if (!agent) throw new AppError('not_found', 'no such agent', { code: 'discovery.agent_not_found' });
        if (agent.status === 'revoked') throw new AppError('conflict', 'the agent is revoked', { code: 'discovery.agent_revoked' });
        if (agent.discoveryDisabledLocally) {
          throw new AppError('conflict', 'discovery is disabled on that agent by its host', { code: 'discovery.agent_refuses' });
        }
        // The organisation default (no connection, no scope), at least one other person.
        const defaults = (await approvalPolicyRepo.listLive(db)).filter((p) => p.connectionId === null && p.scopeId === null);
        const required = Math.max(1, ...defaults.map((p) => p.approvalsRequired));
        const hours = Math.min(DEFAULT_CHAIN_HOURS, ...defaults.map((p) => p.expiryHours));
        const chainExpires = new Date(Math.min(expires, now + hours * 3_600_000)).toISOString();
        const authorisation = await discoveryAuthorisationRepo.insert(db, {
          id, organisationId, agentId: input.agentId, ranges: input.ranges, methods: input.methods, maxHosts: input.maxHosts,
          expiresAt: new Date(expires).toISOString(), authorisedBy: membershipId, approvalChainId: chainId, signedHash: hash,
        });
        const condition: ChainCondition = {
          id: CONDITION, count: required, qualification: 'any_permitted', qualifyingRoleId: null, requiresAdmin: false, selfApprovalPermitted: false,
          connectionIds: [], sources: defaults.length > 0 ? defaults.map((p) => p.id) : ['default'],
        };
        const chain = await approvalChainRepo.insert(db, {
          id: chainId, organisationId, subjectKind: 'discovery_scan', discoveryAuthorisationId: id, requesterMembershipId: membershipId,
          policySnapshot: { conditions: storedConditions([condition]), sequential: false, subject: 'discovery_scan', document } as never,
          diffHash: hash, approvalsRequired: required, status: 'pending', expiresAt: chainExpires,
        });
        for (let n = 0; n < required; n++) {
          await approvalStepRepo.insert(db, {
            id: uuidv7(), organisationId, chainId, sequence: null, qualifyingRule: CONDITION, offeredAt: new Date(now).toISOString(),
          });
        }
        await recordDiscoveryEvent(db, {
          organisationId, correlationId: ctx.correlationId, request: ctx.request, event: 'scan_authorised',
          resource: { type: 'discovery_authorisation', id },
          detail: {
            agent_id: input.agentId, targets: input.ranges.length, methods: input.methods.join(','), max_hosts: input.maxHosts,
            approvals_required: required, approval_chain_id: chainId,
          },
        });
        return { authorisation, chain };
      });
      return authorisationView(created.authorisation, created.chain);
    },

    async get(ctx: Context, id: string): Promise<AuthorisationView> {
      await enabledOrRefuse(deps, ctx);
      await demand(deps, ctx, ['discovery.authorise', 'discovery.review']);
      const { authorisation, chain } = await load(ctx, id);
      return authorisationView(authorisation, chain);
    },

    async list(ctx: Context, limit: number): Promise<AuthorisationView[]> {
      await enabledOrRefuse(deps, ctx);
      await demand(deps, ctx, ['discovery.authorise', 'discovery.review']);
      return inTransaction(control, ctx.request, async (db) => {
        const out: AuthorisationView[] = [];
        for (const a of await discoveryAuthorisationRepo.list(db, limit)) out.push(authorisationView(a, await approvalChainRepo.findById(db, a.approvalChainId)));
        return out;
      }, { readOnly: true });
    },

    /** Revoked once; scans under it stop. A second revoke answers the same. */
    async revoke(ctx: Context, id: string): Promise<AuthorisationView> {
      await enabledOrRefuse(deps, ctx);
      memberOf(ctx);
      await demand(deps, ctx, ['discovery.authorise']);
      const result = await inTransaction(control, ctx.request, async (db) => {
        const revoked = await discoveryAuthorisationRepo.revoke(db, id);
        const authorisation = revoked ?? await discoveryAuthorisationRepo.findById(db, id);
        if (!authorisation) throw new AppError('not_found', 'no such scan authorisation', { code: 'discovery.authorisation_not_found' });
        if (revoked !== undefined) {
          await recordDiscoveryEvent(db, {
            organisationId: authorisation.organisationId, correlationId: ctx.correlationId, request: ctx.request, event: 'scan_authorisation_revoked',
            resource: { type: 'discovery_authorisation', id }, detail: { running: (await discoveryRunRepo.listRunning(db, id)).length },
          });
          await onRevoked(db, ctx, id);
        }
        return { authorisation, chain: await approvalChainRepo.findById(db, authorisation.approvalChainId) };
      });
      return authorisationView(result.authorisation, result.chain);
    },
  };
}

export type Authorisations = ReturnType<typeof createAuthorisations>;
