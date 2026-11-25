// connect-registry (catalogue): connectors, immutable manifest versions, trust tiers,
// connections, and Enterprise organisations' private links. Decisions through the policy
// service; secrets through the credential service.

import { listOutboundWebhooks, registerOutboundWebhook, revokeOutboundWebhook } from '../../contracts/connect-registry/outboundWebhook.contract.ts';
import { createIndustrialEndpoint, listIndustrialEndpoints, verifyIndustrialEndpoint } from '../../contracts/connect-registry/industrial.contract.ts';
import {
  declareWritablePoint, listWritablePoints, raiseWritablePointRisk, retireWritablePoint, setWritablePointTestSafe,
} from '../../contracts/connect-registry/writablePoint.contract.ts';
import {
  cellConnectionCount, changeConnectionStatus, createConnection, getConnection, listConnections, renameConnection, setConnectionParameters, setConnectionSecrets,
  setConnectionPolicyAuthority,
} from '../../contracts/connect-registry/connection.contract.ts';
import { inTransaction } from '../../infra/postgres.infra.ts';
import { connectionRepo } from '../../repos/connect/index.repo.ts';
import {
  createConnector, createManifestVersion, getConnector, getConnectorSetup, getManifestVersion, getOwnManifestDocument, listConnectors, listManifestVersions,
} from '../../contracts/connect-registry/connector.contract.ts';
import { setDraftConnectionVersion } from '../../contracts/connect-registry/draft.contract.ts';
import { registerSiloSource, retireSiloSource } from '../../contracts/connect-registry/siloSource.contract.ts';
import { transferOwnedConnections } from '../../contracts/connect-registry/ownership.contract.ts';
import { transferOwnedConnections as transferOwned } from '../../services/connect-registry/ownership.service.ts';
import { siloSourceController } from '../../controllers/connect-registry/siloSource.controller.ts';
import { addPrivateLink, listPrivateLinks, removePrivateLink } from '../../contracts/connect-registry/privateLink.contract.ts';
import { draftController } from '../../controllers/connect-registry/draft.controller.ts';
import { privateLinkController } from '../../controllers/connect-registry/privateLink.controller.ts';
import { agentController } from '../../controllers/connect-registry/agent.controller.ts';
import * as agentContracts from '../../contracts/connect-registry/agent.contract.ts';
import { registryController } from '../../controllers/connect-registry/registry.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService } from '../../infra/service.infra.ts';
import { createPrivateLinks } from '../../services/connect-registry/privateLinks.service.ts';
import { parseCidr } from '../../utils/network.util.ts';

export const service = defineService({
  name: 'connect-registry',
  // redis-data holds the idempotency keys of the keyed operations.
  needs: { postgres: ['control'], redis: ['data'] },
  create(deps) {
    const c = registryController({ databases: deps.databases, services: deps.services, logger: deps.logger });
    const s = siloSourceController({ databases: deps.databases, services: deps.services, logger: deps.logger });
    // The build routes' sandbox connection follows its draft (spec 16.3, 16.4).
    const d = draftController({ databases: deps.databases, services: deps.services, logger: deps.logger });
    const a = agentController({
      databases: deps.databases, services: deps.services, logger: deps.logger,
      agentEndpoint: deps.config.connect.agentHost ?? `agent.${deps.config.cell.id}.silohq.io`,
    });
    const p = privateLinkController(createPrivateLinks({
      databases: deps.databases, cellNetworks: (deps.config.connect.cellNetworks ?? []).map((text) => parseCidr(text)!),
    }));
    return {
      routes: [
        // The cell's live connections, for its Fleet agent's registration (spec 6.3; D203).
        route(cellConnectionCount, {
          handle: async () => ({ connections: await inTransaction(deps.databases.pool('control'), {}, (db) => connectionRepo.cellConnectionCount(db), { readOnly: true }) }),
        }),
        route(createConnector, c.createConnector), route(listConnectors, c.listConnectors), route(getConnector, c.getConnector),
        route(createManifestVersion, c.createManifestVersion), route(listManifestVersions, c.listManifestVersions),
        route(getManifestVersion, c.getManifestVersion), route(getOwnManifestDocument, c.getOwnManifestDocument), route(getConnectorSetup, c.getConnectorSetup),
        route(createConnection, c.createConnection), route(listConnections, c.listConnections), route(getConnection, c.getConnection),
        route(registerOutboundWebhook, c.registerOutboundWebhook), route(listOutboundWebhooks, c.listOutboundWebhooks),
        route(createIndustrialEndpoint, c.createIndustrialEndpoint), route(listIndustrialEndpoints, c.listIndustrialEndpoints),
        route(verifyIndustrialEndpoint, c.verifyIndustrialEndpoint),
        route(declareWritablePoint, c.declareWritablePoint), route(listWritablePoints, c.listWritablePoints),
        route(raiseWritablePointRisk, c.raiseWritablePointRisk), route(setWritablePointTestSafe, c.setWritablePointTestSafe),
        route(retireWritablePoint, c.retireWritablePoint),
        route(revokeOutboundWebhook, c.revokeOutboundWebhook),
        route(renameConnection, c.renameConnection), route(changeConnectionStatus, c.changeConnectionStatus),
        route(setConnectionPolicyAuthority, c.setConnectionPolicyAuthority),
        route(setConnectionSecrets, c.setConnectionSecrets), route(setConnectionParameters, c.setConnectionParameters),
        route(setDraftConnectionVersion, d.setDraftConnectionVersion),
        route(listPrivateLinks, p.listPrivateLinks), route(addPrivateLink, p.addPrivateLink), route(removePrivateLink, p.removePrivateLink),
        route(agentContracts.createAgentPool, a.createAgentPool), route(agentContracts.listAgentPools, a.listAgentPools),
        route(agentContracts.issueAgentEnrolmentToken, a.issueAgentEnrolmentToken), route(agentContracts.revokeAgent, a.revokeAgent),
        route(agentContracts.setAgentPoolUpdatePolicy, a.setAgentPoolUpdatePolicy), route(agentContracts.approveAgentPoolUpdate, a.approveAgentPoolUpdate),
        route(agentContracts.listAgentReleases, a.listAgentReleases),
        // A Silo as a source (66.5), registered by siloes-import when a definition is published.
        route(registerSiloSource, s.registerSiloSource), route(retireSiloSource, s.retireSiloSource),
        // A removed member's connections, at policy's call (55.7).
        route(transferOwnedConnections, { handle: (input, ctx) => transferOwned(deps, ctx, input.body.membershipId) }),
      ],
    };
  },
});
