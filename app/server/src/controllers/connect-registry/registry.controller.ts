// connect-registry's endpoints: parsed input to the registry service and back.

import type { listOutboundWebhooks, registerOutboundWebhook, revokeOutboundWebhook } from '../../contracts/connect-registry/outboundWebhook.contract.ts';
import type { createIndustrialEndpoint, listIndustrialEndpoints, verifyIndustrialEndpoint } from '../../contracts/connect-registry/industrial.contract.ts';
import type {
  declareWritablePoint, listWritablePoints, raiseWritablePointRisk, retireWritablePoint, setWritablePointTestSafe,
} from '../../contracts/connect-registry/writablePoint.contract.ts';
import * as points from '../../services/connect-registry/writablePoints.service.ts';
import * as industrial from '../../services/connect-registry/industrial.service.ts';
import type {
  changeConnectionStatus, createConnection, getConnection, listConnections, renameConnection, setConnectionParameters, setConnectionSecrets,
  setConnectionPolicyAuthority,
} from '../../contracts/connect-registry/connection.contract.ts';
import type {
  createConnector, createManifestVersion, getConnector, getConnectorSetup, getManifestVersion, getOwnManifestDocument, listConnectors, listManifestVersions,
} from '../../contracts/connect-registry/connector.contract.ts';
import type { RouteHandlers } from '../../infra/http.infra.ts';
import * as registry from '../../services/connect-registry/registry.service.ts';
import type { RegistryDeps } from '../../services/connect-registry/registry.service.ts';

export function registryController(deps: RegistryDeps) {
  return {
    registerOutboundWebhook: {
      handle: ({ params, body }, ctx) => registry.registerOutboundWebhook(deps, ctx, params.connectionId, body),
    } satisfies RouteHandlers<typeof registerOutboundWebhook>,
    listOutboundWebhooks: {
      handle: async ({ params }, ctx) => ({ endpoints: await registry.listOutboundWebhooks(deps, ctx, params.connectionId) }),
    } satisfies RouteHandlers<typeof listOutboundWebhooks>,
    revokeOutboundWebhook: {
      handle: ({ params }, ctx) => registry.revokeOutboundWebhook(deps, ctx, params.endpointId),
    } satisfies RouteHandlers<typeof revokeOutboundWebhook>,
    createIndustrialEndpoint: {
      handle: ({ params, body }, ctx) => industrial.createIndustrialEndpoint(deps, ctx, params.connectionId, body),
    } satisfies RouteHandlers<typeof createIndustrialEndpoint>,
    listIndustrialEndpoints: {
      handle: async ({ params }, ctx) => ({ endpoints: await industrial.listIndustrialEndpoints(deps, ctx, params.connectionId) }),
    } satisfies RouteHandlers<typeof listIndustrialEndpoints>,
    verifyIndustrialEndpoint: {
      handle: ({ params }, ctx) => industrial.verifyIndustrialEndpoint(deps, ctx, params.connectionId, params.endpointId),
    } satisfies RouteHandlers<typeof verifyIndustrialEndpoint>,
    declareWritablePoint: {
      handle: ({ params, body }, ctx) => points.declareWritablePoint(deps, ctx, params.connectionId, body),
    } satisfies RouteHandlers<typeof declareWritablePoint>,
    listWritablePoints: {
      handle: async ({ params, query }, ctx) => ({ points: await points.listWritablePoints(deps, ctx, params.connectionId, query.includeRetired === 'true') }),
    } satisfies RouteHandlers<typeof listWritablePoints>,
    raiseWritablePointRisk: {
      handle: ({ params }, ctx) => points.raiseWritablePointRisk(deps, ctx, params.pointId),
    } satisfies RouteHandlers<typeof raiseWritablePointRisk>,
    setWritablePointTestSafe: {
      handle: ({ params, body }, ctx) => points.setWritablePointTestSafe(deps, ctx, params.pointId, body.testSafe),
    } satisfies RouteHandlers<typeof setWritablePointTestSafe>,
    retireWritablePoint: {
      handle: ({ params }, ctx) => points.retireWritablePoint(deps, ctx, params.pointId),
    } satisfies RouteHandlers<typeof retireWritablePoint>,
    createConnector: {
      handle: ({ body }, ctx) => registry.createConnector(deps, ctx, body),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => registry.getConnector(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof createConnector>,
    listConnectors: {
      handle: async ({ query }, ctx) => ({ connectors: await registry.listConnectors(deps, ctx, query.limit) }),
    } satisfies RouteHandlers<typeof listConnectors>,
    getConnector: {
      handle: ({ params }, ctx) => registry.getConnector(deps, ctx, params.connectorId),
    } satisfies RouteHandlers<typeof getConnector>,
    createManifestVersion: {
      handle: ({ params, body }, ctx) => registry.createManifestVersion(deps, ctx, params.connectorId, body),
      resultRef: (out) => out.id,
      replay: async (ref, ctx) => {
        const { document: _document, ...view } = await registry.getManifestVersion(deps, ctx, (await registry.getManifestConnector(deps, ctx, ref!)), ref!);
        return view;
      },
    } satisfies RouteHandlers<typeof createManifestVersion>,
    listManifestVersions: {
      handle: async ({ params }, ctx) => ({ versions: await registry.listManifestVersions(deps, ctx, params.connectorId) }),
    } satisfies RouteHandlers<typeof listManifestVersions>,
    getManifestVersion: {
      handle: ({ params }, ctx) => registry.getManifestVersion(deps, ctx, params.connectorId, params.versionId),
    } satisfies RouteHandlers<typeof getManifestVersion>,
    getOwnManifestDocument: {
      handle: ({ params }, ctx) => registry.getOwnManifestDocument(deps, ctx, params.connectorId, params.versionId),
    } satisfies RouteHandlers<typeof getOwnManifestDocument>,
    getConnectorSetup: {
      handle: ({ params, query }, ctx) => registry.getConnectorSetup(deps, ctx, params.connectorId, query.manifestId),
    } satisfies RouteHandlers<typeof getConnectorSetup>,
    createConnection: {
      handle: ({ body }, ctx) => registry.createConnection(deps, ctx, body),
      resultRef: (out) => out.id,
      replay: (ref, ctx) => registry.getConnection(deps, ctx, ref!),
    } satisfies RouteHandlers<typeof createConnection>,
    listConnections: {
      handle: async ({ query }, ctx) => ({ connections: await registry.listConnections(deps, ctx, query.limit) }),
    } satisfies RouteHandlers<typeof listConnections>,
    getConnection: {
      handle: ({ params }, ctx) => registry.getConnection(deps, ctx, params.connectionId),
    } satisfies RouteHandlers<typeof getConnection>,
    renameConnection: {
      handle: ({ params, body }, ctx) => registry.renameConnection(deps, ctx, params.connectionId, body),
    } satisfies RouteHandlers<typeof renameConnection>,
    changeConnectionStatus: {
      handle: ({ params, body }, ctx) => registry.changeConnectionStatus(deps, ctx, params.connectionId, body),
    } satisfies RouteHandlers<typeof changeConnectionStatus>,
    setConnectionPolicyAuthority: {
      handle: ({ params, body }, ctx) => registry.setPolicyAuthority(deps, ctx, params.connectionId, body),
    } satisfies RouteHandlers<typeof setConnectionPolicyAuthority>,
    setConnectionParameters: {
      handle: ({ params, body }, ctx) => registry.setConnectionParameters(deps, ctx, params.connectionId, body),
    } satisfies RouteHandlers<typeof setConnectionParameters>,
    setConnectionSecrets: {
      handle: ({ params, body }, ctx) => registry.setConnectionSecrets(deps, ctx, params.connectionId, body.values),
    } satisfies RouteHandlers<typeof setConnectionSecrets>,
  };
}
