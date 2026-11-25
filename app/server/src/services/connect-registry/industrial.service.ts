// Industrial endpoints (spec 20.1 to 20.3, 20.7): the broker or server an MQTT or OPC UA
// connection reaches through its Silo Agent pool. industrial.connect at the connection's
// owning scope creates one; OPC UA's security policy None is refused unless the person also
// holds industrial.declare_writable there and records the exception for a segregated network,
// which every clone from the connection then shows.

import type { IndustrialEndpointView } from '../../contracts/connect-registry/industrial.contract.ts';
import { probeIndustrialEndpoint } from '../../contracts/connect-runtime/industrialProbe.contract.ts';
import { issueOpcUaApplicationCertificate } from '../../contracts/credential/opcuaApplication.contract.ts';
import { manifestSchema } from '../../contracts/connect/manifest.contract.ts';
import type { HandlerContext } from '../../infra/http.infra.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import type { IndustrialEndpoint } from '../../models/connect/industrialEndpoint.model.ts';
import { connectorManifestRepo, industrialEndpointRepo } from '../../repos/connect/index.repo.ts';
import { AppError, fromDatabaseError } from '../../utils/errors.util.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { recordConnectEvent } from './connectEvents.service.ts';
import { demand, loadConnection, type RegistryDeps } from './registry.service.ts';

type Context = Pick<HandlerContext, 'request' | 'correlationId'>;

const viewOf = (e: IndustrialEndpoint): IndustrialEndpointView => ({
  id: e.id, connectionId: e.connectionId, plugin: e.plugin as IndustrialEndpointView['plugin'], endpointUrl: e.endpointUrl, agentPoolId: e.agentPoolId,
  securityPolicy: e.securityPolicy, insecureExceptionBy: e.insecureExceptionBy,
  applicationCertificate: e.appCertificatePem === null || e.appCertificateThumbprint === null ? null : { pem: e.appCertificatePem, thumbprint: e.appCertificateThumbprint },
  serverCertificateThumbprint: e.serverCertificateThumbprint, namespaceUris: e.namespaceUris, verifiedAt: e.verifiedAt,
  status: e.status as IndustrialEndpointView['status'], createdAt: e.createdAt,
});

/** A probe's wait: the agent's connect, GetEndpoints and session, with room for the relay. */
const PROBE_TIMEOUT_MS = 60_000;

/**
 * OPC UA's security: None, or a current policy with Sign or SignAndEncrypt (OPC 10000-7).
 * Basic128Rsa15 and Basic256 are deprecated by the OPC Foundation and refused.
 */
const OPCUA_POLICY = /^(None|(Basic256Sha256|Aes128_Sha256_RsaOaep|Aes256_Sha256_RsaPss) (Sign|SignAndEncrypt))$/;

/** The manifest protocol each plugin serves. */
const PLUGIN_PROTOCOL = { mqtt: 'mqtt', opcua: 'opc_ua' } as const;

export async function createIndustrialEndpoint(deps: RegistryDeps, ctx: Context, connectionId: string, input: {
  plugin: 'mqtt' | 'opcua'; endpointUrl: string; securityPolicy: string; insecureException?: true | undefined;
  serverCertificateThumbprint?: string | undefined;
}): Promise<IndustrialEndpointView> {
  const connection = await loadConnection(deps, ctx, connectionId);
  await demand(deps, ctx, 'industrial.connect', connection.owningScopeId, connection.id);
  const membershipId = ctx.request.membershipId;
  if (membershipId === undefined) throw new AppError('forbidden', 'a person creates an industrial endpoint', { code: 'industrial.member_required' });
  if (connection.status === 'revoked') throw new AppError('conflict', 'a revoked connection takes no endpoint', { code: 'connection.revoked' });
  if (connection.agentPoolId === null) {
    throw new AppError('validation', 'an industrial endpoint is reached through the Silo Agent: the connection names an agent pool', { code: 'industrial.agent_required' });
  }
  const control = deps.databases.pool('control');
  const manifestRow = await inTransaction(control, ctx.request, (db) => connectorManifestRepo.findById(db, connection.manifestId), { readOnly: true });
  const manifest = manifestRow === undefined ? undefined : manifestSchema.safeParse(manifestRow.document);
  if (manifest?.success !== true) throw new AppError('integrity', 'the connection runs a manifest that does not read', { code: 'connection.manifest_unreadable' });
  if (manifest.data.protocol.kind !== PLUGIN_PROTOCOL[input.plugin]) {
    throw new AppError('validation', `the connection's manifest speaks ${manifest.data.protocol.kind}, not ${PLUGIN_PROTOCOL[input.plugin]}`, {
      code: 'industrial.plugin_mismatch',
    });
  }
  const scheme = input.endpointUrl.slice(0, input.endpointUrl.indexOf('://'));
  if ((input.plugin === 'opcua') !== (scheme === 'opc.tcp')) {
    throw new AppError('validation', input.plugin === 'opcua' ? 'an OPC UA server is opc.tcp://' : 'an MQTT broker is tcp:// or ssl://', { code: 'industrial.url_scheme' });
  }
  if (input.plugin === 'mqtt' && !['tls', 'plain'].includes(input.securityPolicy)) {
    throw new AppError('validation', 'an MQTT broker is secured by tls (ssl://) or reached plain (tcp://) on the customer\'s network', { code: 'industrial.policy_invalid' });
  }
  if (input.plugin === 'mqtt' && (input.securityPolicy === 'tls') !== ['ssl', 'mqtts'].includes(scheme)) {
    throw new AppError('validation', 'a TLS broker is ssl://, a plain one tcp://', { code: 'industrial.policy_invalid' });
  }
  if (input.plugin === 'opcua' && !OPCUA_POLICY.test(input.securityPolicy)) {
    throw new AppError('validation', 'an OPC UA server is secured by None, or Basic256Sha256, Aes128_Sha256_RsaOaep or Aes256_Sha256_RsaPss with Sign or SignAndEncrypt', {
      code: 'industrial.policy_invalid',
    });
  }
  const none = input.plugin === 'opcua' && input.securityPolicy === 'None';
  if (input.insecureException === true && !none) {
    throw new AppError('validation', 'an exception is recorded only for OPC UA\'s security policy None', { code: 'industrial.exception_unused' });
  }
  if (none) {
    if (input.insecureException !== true) {
      throw new AppError('validation', 'OPC UA\'s security policy None is refused unless the connection owner records an exception for a segregated network', {
        code: 'industrial.policy_none_refused',
      });
    }
    await demand(deps, ctx, 'industrial.declare_writable', connection.owningScopeId, connection.id);
  }
  const signed = input.plugin === 'opcua' && !none;
  if (signed && input.serverCertificateThumbprint === undefined) {
    throw new AppError('validation', 'a signed OPC UA endpoint pins the server\'s certificate: give its thumbprint as the server shows it', {
      code: 'industrial.server_certificate_required',
    });
  }
  if (!signed && input.serverCertificateThumbprint !== undefined) {
    throw new AppError('validation', 'only a signed OPC UA endpoint pins a server certificate', { code: 'industrial.server_certificate_unused' });
  }
  const id = uuidv7();
  // A signed endpoint's application, made by the credential service, after a quick check that the endpoint is new.
  let application: { certificatePem: string; thumbprint: string } | undefined;
  if (signed) {
    const existing = await inTransaction(control, ctx.request, (db) => industrialEndpointRepo.findByConnectionIdAndEndpointUrl(db, {
      organisationId: connection.organisationId, connectionId, endpointUrl: input.endpointUrl,
    }), { readOnly: true });
    if (existing !== undefined) throw new AppError('conflict', 'the connection already has that endpoint', { code: 'industrial.endpoint_exists' });
    application = await deps.services.call(issueOpcUaApplicationCertificate, { body: { connectionId, endpointId: id } }, { request: ctx.request, correlationId: ctx.correlationId });
  }
  try {
    const row = await inTransaction(control, ctx.request, async (db) => {
      const inserted = await industrialEndpointRepo.insert(db, {
        id, organisationId: connection.organisationId, connectionId, plugin: input.plugin, endpointUrl: input.endpointUrl,
        agentPoolId: connection.agentPoolId!, securityPolicy: input.securityPolicy, insecureExceptionBy: none ? membershipId : null,
        // Signed: untrusted until verified, the customer's step (trusting the certificate) between.
        ...(application === undefined ? {} : {
          status: 'untrusted', appCertificatePem: application.certificatePem, appCertificateThumbprint: application.thumbprint,
          serverCertificateThumbprint: input.serverCertificateThumbprint!,
        }),
      });
      const event = { organisationId: connection.organisationId, correlationId: ctx.correlationId, membershipId, resourceType: 'connection' as const, resourceId: connection.id };
      await recordConnectEvent(db, {
        ...event, event: 'industrial_endpoint_created',
        detail: { endpoint_id: inserted.id, plugin: input.plugin, policy_none: none, ...(application === undefined ? {} : { application_thumbprint: application.thumbprint }) },
      });
      if (none) await recordConnectEvent(db, { ...event, event: 'opcua_insecure_exception_recorded', detail: { endpoint_id: inserted.id } });
      return inserted;
    });
    return viewOf(row);
  } catch (error) {
    if (fromDatabaseError(error).category === 'conflict') {
      throw new AppError('conflict', 'the connection already has that endpoint', { code: 'industrial.endpoint_exists' });
    }
    throw error;
  }
}

export async function listIndustrialEndpoints(deps: RegistryDeps, ctx: Context, connectionId: string): Promise<IndustrialEndpointView[]> {
  const connection = await loadConnection(deps, ctx, connectionId);
  await demand(deps, ctx, 'industrial.connect', connection.owningScopeId, connection.id);
  const rows = await inTransaction(deps.databases.pool('control'), ctx.request, (db) => industrialEndpointRepo.listForConnection(db, connectionId), { readOnly: true });
  return rows.map(viewOf);
}

/**
 * Verifies an OPC UA endpoint (industrial.connect at the owning scope): the agent connects as a
 * read would, and the endpoint's status follows from what the server said.
 */
export async function verifyIndustrialEndpoint(deps: RegistryDeps, ctx: Context, connectionId: string, endpointId: string) {
  const connection = await loadConnection(deps, ctx, connectionId);
  await demand(deps, ctx, 'industrial.connect', connection.owningScopeId, connection.id);
  const membershipId = ctx.request.membershipId;
  if (membershipId === undefined) throw new AppError('forbidden', 'a person verifies an industrial endpoint', { code: 'industrial.member_required' });
  const control = deps.databases.pool('control');
  const endpoint = await inTransaction(control, ctx.request, (db) => industrialEndpointRepo.findById(db, endpointId), { readOnly: true });
  if (endpoint === undefined || endpoint.connectionId !== connection.id) {
    throw new AppError('not_found', 'no such endpoint on the connection', { code: 'industrial.endpoint_not_found' });
  }
  const found = await deps.services.call(probeIndustrialEndpoint, { params: { endpointId }, body: { connectionId } }, {
    request: ctx.request, correlationId: ctx.correlationId, timeoutMs: PROBE_TIMEOUT_MS,
  });
  const event = { organisationId: connection.organisationId, correlationId: ctx.correlationId, membershipId, resourceType: 'connection' as const, resourceId: connection.id };
  const updated = await inTransaction(control, ctx.request, async (db) => {
    switch (found.outcome) {
      case 'trusted': {
        const row = await industrialEndpointRepo.update(db, endpoint.id, { status: 'active', namespaceUris: found.namespaceUris, verifiedAt: new Date().toISOString() });
        await recordConnectEvent(db, { ...event, event: 'industrial_endpoint_verified', detail: { endpoint_id: endpoint.id, namespaces: found.namespaceUris.length } });
        return row;
      }
      case 'untrusted':
      case 'server_certificate_mismatch': {
        const row = await industrialEndpointRepo.update(db, endpoint.id, { status: 'untrusted' });
        await recordConnectEvent(db, {
          ...event, event: 'industrial_endpoint_untrusted',
          detail: { endpoint_id: endpoint.id, found_by: 'verification', reason: found.outcome === 'untrusted' ? 'application_not_trusted' : 'server_certificate_mismatch' },
        });
        return row;
      }
      case 'unreachable':
        return endpoint.status === 'active' ? endpoint : industrialEndpointRepo.update(db, endpoint.id, { status: 'unreachable' });
      default:
        return endpoint;
    }
  });
  return {
    outcome: found.outcome, endpoint: viewOf(updated ?? endpoint),
    ...(found.serverSha1 === undefined || found.serverSha256 === undefined ? {} : { presented: { sha1: found.serverSha1, sha256: found.serverSha256 } }),
  };
}
