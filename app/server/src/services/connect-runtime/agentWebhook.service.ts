// An outbound webhook sent by the connection's Silo Agent (spec 20.4): to the target as
// registered, or its status endpoint; a POST only on the grant actions signed for this attempt
// (checked here before it leaves the cell, and again by the agent).

import type { AgentWebhookRequest } from '../../contracts/connect-runtime/agentWebhook.contract.ts';
import type { SignedExecutionGrant } from '../../contracts/actions/grant.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { connectionRepo, webhookEndpointRepo } from '../../repos/connect/index.repo.ts';
import { AppError } from '../../utils/errors.util.ts';
import { verifyExecutionGrant } from '../actions/grants.service.ts';
import type { RuntimeDeps } from './read.service.ts';

/** A delivery or a status read waits this long for the agent's answer. */
const SEND_TIMEOUT_MS = 30_000;

const withoutQuery = (url: string): string => { const u = new URL(url); return `${u.origin}${u.pathname}`; };

export async function sendThroughAgent(deps: RuntimeDeps, ctx: Pick<HandlerContext, 'request' | 'correlationId'>, endpointId: string,
  input: { request: AgentWebhookRequest; grant?: SignedExecutionGrant | undefined }) {
  const { endpoint, connection } = await inTransaction(deps.databases.pool('control'), ctx.request, async (db) => {
    const endpoint = await webhookEndpointRepo.findById(db, endpointId);
    return { endpoint, connection: endpoint === undefined ? undefined : await connectionRepo.findById(db, endpoint.connectionId) };
  }, { readOnly: true });
  if (endpoint === undefined || endpoint.direction !== 'outbound' || connection === undefined) {
    throw new AppError('not_found', 'no such webhook target', { code: 'webhook.not_found' });
  }
  if (connection.agentPoolId === null) {
    throw new AppError('validation', 'this target is posted from the cell, not the agent', { code: 'webhook.not_via_agent' });
  }
  const request = input.request;
  // Only the address registered: the target for a delivery, its status endpoint for a read.
  const allowed = request.method === 'POST' ? request.url === endpoint.targetUrl
    : endpoint.statusUrl !== null && withoutQuery(request.url) === withoutQuery(endpoint.statusUrl);
  if (!allowed) throw new AppError('forbidden', 'the address is not the registered target\'s', { code: 'webhook.address_mismatch' });
  // A physical target's POST names its own action, so the agent checks it against its signed allow-list (47.4).
  if (request.method === 'POST' && endpoint.riskClass === 'physical' && request.physical?.action !== endpoint.actionName) {
    throw new AppError('forbidden', 'a physical target\'s request names its action, for the agent\'s allow-list', { code: 'webhook.physical_unmarked' });
  }
  if (request.physical !== undefined && (request.method !== 'POST' || endpoint.riskClass !== 'physical')) {
    throw new AppError('validation', 'only a physical target\'s POST is marked physical', { code: 'webhook.physical_unexpected' });
  }
  if (request.method === 'POST') {
    if (deps.grantKey === undefined) {
      throw new AppError('configuration', 'this cell has no execution grant key: writes through the Silo Agent cannot be checked', { code: 'write.grant_unavailable' });
    }
    verifyExecutionGrant(deps.grantKey, input.grant, { organisationId: connection.organisationId, connectionId: connection.id, object: 'webhook', statements: [request] });
  }
  if (deps.agent.http === undefined) {
    throw new AppError('source_unreachable', 'no Silo Agent of the connection\'s pool sends webhooks', { code: 'agent.unavailable' });
  }
  return deps.agent.http({
    organisationId: connection.organisationId, connectionId: connection.id, agentPoolId: connection.agentPoolId, statements: [request],
    ...(request.method === 'POST' && input.grant !== undefined ? { grant: input.grant } : {}), timeoutMs: SEND_TIMEOUT_MS, signal: AbortSignal.timeout(SEND_TIMEOUT_MS + 5_000),
  });
}
