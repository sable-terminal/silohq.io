// Industrial endpoints in connect-runtime (spec 20.3, 20.7): the probe that verifies an OPC UA
// endpoint (contracts/connect-runtime/industrialProbe.contract.ts), and the endpoint marked
// untrusted where a read finds the server no longer trusts its application certificate, until
// someone verifies it again (industrial_endpoint_untrusted).

import { manifestSchema } from '../../contracts/connect/manifest.contract.ts';
import type { PROBE_OUTCOMES } from '../../contracts/connect-runtime/industrialProbe.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { IndustrialEndpoint } from '../../models/connect/industrialEndpoint.model.ts';
import { connectionRepo, connectorManifestRepo, industrialEndpointRepo } from '../../repos/connect/index.repo.ts';
import { AppError, isAppError } from '../../utils/errors.util.ts';
import { pemToDerBase64 } from '../../utils/pem.util.ts';
import { recordConnectEvent } from '../connect-registry/connectEvents.service.ts';
import { withLogin } from './agent.service.ts';
import type { Caller, RuntimeDeps } from './read.service.ts';

const PROBE_MS = 45_000;

/** The server's refusals a probe reports as its outcome; anything else (no agent, a target refused) is an error. */
const OUTCOME_OF: Record<string, (typeof PROBE_OUTCOMES)[number]> = {
  'industrial.endpoint_untrusted': 'untrusted',
  'industrial.server_certificate_mismatch': 'server_certificate_mismatch',
  'industrial.policy_not_offered': 'policy_not_offered',
  'source.login_refused': 'login_refused',
  'agent.source_unreachable': 'unreachable',
};

export async function probeIndustrialEndpoint(deps: RuntimeDeps, caller: Caller, endpointId: string, connectionId: string) {
  const control = deps.databases.pool('control');
  const { connection, endpoint, manifest } = await inTransaction(control, caller.request, async (db) => {
    const connection = await connectionRepo.findById(db, connectionId);
    const endpoint = await industrialEndpointRepo.findById(db, endpointId);
    if (connection === undefined || endpoint === undefined || endpoint.connectionId !== connection.id) {
      throw new AppError('not_found', 'no such endpoint on the connection', { code: 'industrial.endpoint_not_found' });
    }
    const row = await connectorManifestRepo.findById(db, connection.manifestId);
    const parsed = row === undefined ? undefined : manifestSchema.safeParse(row.document);
    if (parsed?.success !== true) throw new AppError('integrity', 'the connection runs a manifest that does not read', { code: 'connection.manifest_unreadable' });
    return { connection, endpoint, manifest: parsed.data };
  }, { readOnly: true });
  if (endpoint.plugin !== 'opcua') {
    throw new AppError('validation', 'an MQTT broker is checked by reading through it', { code: 'industrial.probe_unsupported' });
  }
  if (endpoint.status === 'revoked') throw new AppError('conflict', 'a revoked endpoint is not probed', { code: 'industrial.endpoint_revoked' });
  const signed = endpoint.securityPolicy === 'None' || endpoint.appCertificatePem === null || endpoint.serverCertificateThumbprint === null ? undefined
    : { endpointId: endpoint.id, certificate: pemToDerBase64(endpoint.appCertificatePem), serverThumbprint: endpoint.serverCertificateThumbprint };
  const channel = withLogin(deps.agent, { reason: 'probe', request: caller.request, correlationId: caller.correlationId });
  if (channel.opcuaProbe === undefined || connection.agentPoolId === null) {
    throw new AppError('source_unreachable', 'OPC UA is reached through the connection\'s Silo Agent', { code: 'agent.unavailable' });
  }
  const signal = AbortSignal.timeout(PROBE_MS + 5_000);
  try {
    const found = await channel.opcuaProbe({
      organisationId: connection.organisationId, connectionId: connection.id, agentPoolId: connection.agentPoolId,
      endpointUrl: endpoint.endpointUrl, securityPolicy: endpoint.securityPolicy, signed, timeoutMs: PROBE_MS, signal,
      sealLogin: manifest.auth.strategy !== 'none',
    });
    return { outcome: 'trusted' as const, ...found };
  } catch (error) {
    const outcome = isAppError(error) ? OUTCOME_OF[error.code ?? ''] : undefined;
    if (outcome === undefined) throw error;
    return { outcome, namespaceUris: [] };
  }
}

/**
 * The server no longer trusts the endpoint's application certificate (a read found it): the
 * endpoint is untrusted until someone verifies it again, recorded once as it changes.
 */
export async function markUntrusted(deps: Pick<RuntimeDeps, 'databases'>, caller: Caller, endpoint: Pick<IndustrialEndpoint, 'id' | 'connectionId' | 'organisationId'>): Promise<void> {
  await inTransaction(deps.databases.pool('control'), caller.request, async (db) => {
    if (!await industrialEndpointRepo.markUntrustedIfActive(db, endpoint.id)) return;
    await recordConnectEvent(db, {
      service: 'connect-runtime', organisationId: endpoint.organisationId, correlationId: caller.correlationId,
      event: 'industrial_endpoint_untrusted', membershipId: caller.request.membershipId, resourceType: 'connection', resourceId: endpoint.connectionId,
      detail: { endpoint_id: endpoint.id, found_by: 'read' },
    });
  });
}
