// connect-runtime (catalogue): the one generic engine that executes every manifest. Secrets
// are placed by the credential service; tokens refreshed by the OAuth engine; customer
// databases reached through the Silo Agent, whose tunnel this service will terminate. Until
// the tunnel exists, reads through the agent are refused as unreachable.
//
// Where the deployment gives the agent endpoint its certificate and the agent CA, this
// service also listens at agent.<cell> (AGENT_ENDPOINT_PORT), where agents enrol (spec 10.2).
//
// Where the cell has the Silo release key and object-files, it takes the agent releases its
// Fleet agent carries in, rolls each through the cell's agents in waves, and offers agents
// their updates (spec 10.7, 11.4).

import { createAgentTunnels, type AgentTunnels } from '../../services/connect-runtime/agentTunnels.service.ts';
import { createAgentCaptures } from '../../services/connect-runtime/agentCaptures.service.ts';
import { createAgentRegistry } from '../../services/connect-runtime/agentRegistry.service.ts';
import { relayAgentWork } from '../../contracts/connect-runtime/agentRelay.contract.ts';
import { sealAgentCredentials } from '../../contracts/credential/connectionCredential.contract.ts';
import { sealOpcUaApplicationKey } from '../../contracts/credential/opcuaApplication.contract.ts';
import { createAgentAllowlists } from '../../services/connect-runtime/agentAllowlists.service.ts';
import { resolvePhysicalTargets } from '../../contracts/connect-runtime/physical.contract.ts';
import { resolvePhysicalTargets as resolvePhysical } from '../../services/connect-runtime/physicalTargets.service.ts';
import { probeIndustrialEndpoint } from '../../contracts/connect-runtime/industrialProbe.contract.ts';
import { probeIndustrialEndpoint as probeEndpoint } from '../../services/connect-runtime/industrialProbe.service.ts';
import { relayController } from '../../controllers/connect-runtime/relay.controller.ts';
import { startDiscoveryScan } from '../../contracts/connect-runtime/discoveryScan.contract.ts';
import { discoveryScanController } from '../../controllers/connect-runtime/discoveryScan.controller.ts';
import { createAgentScans, type AgentScans } from '../../services/connect-runtime/agentScans.service.ts';
import { createAgentUpdates, type AgentUpdates } from '../../services/connect-runtime/agentUpdates.service.ts';
import { installAgentRelease } from '../../contracts/connect-runtime/agentRelease.contract.ts';
import { agentReleaseController } from '../../controllers/connect-runtime/agentRelease.controller.ts';
import { agentRolloutsWorker } from '../../workers/connect-runtime/agentRollouts.worker.ts';
import { createObjectStore, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import { trustedKey } from '../../services/fleet-control/signing.service.ts';
import { uuidv7 } from '../../utils/id.util.ts';
import { readFileSync } from 'node:fs';
import type { Worker } from '../../infra/service.infra.ts';
import { createAgentCa } from '../../services/connect-runtime/agentCa.service.ts';
import { agentEndpoint } from '../../workers/connect-runtime/agentEndpoint.worker.ts';
import { observeObject } from '../../contracts/connect-runtime/observe.contract.ts';
import { profileObject } from '../../contracts/connect-runtime/profile.contract.ts';
import { readObject } from '../../contracts/connect-runtime/read.contract.ts';
import { readRecords, prepareWrites, writeRecords } from '../../contracts/connect-runtime/write.contract.ts';
import { observeController } from '../../controllers/connect-runtime/observe.controller.ts';
import { profileController } from '../../controllers/connect-runtime/profile.controller.ts';
import { readController } from '../../controllers/connect-runtime/read.controller.ts';
import { writeController } from '../../controllers/connect-runtime/write.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { sendWebhookThroughAgent } from '../../contracts/connect-runtime/agentWebhook.contract.ts';
import { sendThroughAgent } from '../../services/connect-runtime/agentWebhook.service.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { createBigQueryAdapter } from '../../infra/bigquery.infra.ts';
import { NO_AGENT_TUNNEL, tunnelChannel, type AgentChannel } from '../../services/connect-runtime/agent.service.ts';
import { createSiloStore, NO_SILO_STORE, type SiloStoreChannel } from '../../services/connect-runtime/siloStore.service.ts';

export function createConnectRuntimeService(options: {
  agent?: AgentChannel; siloStore?: SiloStoreChannel;
  /** Told the agent endpoint's port once it listens (tests bind port 0). */
  onAgentEndpoint?: (port: number) => void;
  /** The tunnels, for tests to give work through; and a shorter heartbeat for them. */
  onAgentTunnels?: (tunnels: AgentTunnels) => void;
  agentHeartbeatMs?: number;
  /** A change capture reader's lease, and the first wait before a failed slot is offered to the same agent again; tests shorten them. */
  agentCaptureLeaseMs?: number;
  agentCaptureRetryMs?: number;
  /** The longest between a running scan's reports to discovery; tests shorten it. */
  agentScanReportMs?: number;
  /** How long an allow-list sent and not yet taken waits before it is sent again; tests shorten it. */
  agentAllowlistResendMs?: number;
  /** object-files for agent binaries (tests give one in memory), the clock and the rollout tick, for tests of waves. */
  objects?: ObjectStore;
  now?: () => number;
  agentRolloutTickMs?: number;
  onAgentUpdates?: (updates: AgentUpdates) => void;
} = {}): ServiceDefinition {
  return defineService({
    name: 'connect-runtime',
    // redis-data: which replica holds each agent's tunnel (agentRegistry.service).
    needs: { postgres: ['control'], redis: ['data'] },
    async create(deps) {
      // The agent endpoint (spec 10.2), where the deployment configured it.
      const connect = deps.config.connect;
      const workers: Worker[] = [];
      let tunnels: AgentTunnels | undefined;
      let scans: AgentScans | undefined;
      // Agent updates through Fleet (spec 10.7, 11.4), where the cell has the release key and object-files.
      const releaseKey = deps.config.globalTier.fleet.releasePublicKey;
      const sovereignKey = deps.config.globalTier.fleet.sovereignPublicKey;
      const objects = options.objects ?? (deps.config.objectStorage?.filesBucket === undefined ? undefined : await createObjectStore(deps.config.objectStorage));
      const updates = releaseKey === undefined || objects === undefined ? undefined : createAgentUpdates({
        databases: deps.databases, logger: deps.logger, objects, target: deps.config.cell.buildTarget,
        // A sovereign cell's agent-sovereign heads are the sovereign fleet-control's (D202).
        trusted: [trustedKey(releaseKey, 'release'), ...(sovereignKey ? [trustedKey(sovereignKey, 'sovereign')] : [])],
        firstOrganisations: connect.agentFirstOrganisations, soakHours: connect.agentWaveSoakHours, ...(options.now ? { now: options.now } : {}),
      });
      if (updates !== undefined) {
        options.onAgentUpdates?.(updates);
        workers.push(agentRolloutsWorker({ updates, logger: deps.logger, ...(options.agentRolloutTickMs ? { intervalMs: options.agentRolloutTickMs } : {}) }));
      }
      // Discovery is compiled out of the sovereign build (spec 19): its agents get no scan key and no scan.
      const discoveryKey = deps.config.cell.buildTarget === 'sovereign' ? undefined : connect.discoveryScanPublicKey;
      if (connect.agentTlsCertFile !== undefined && connect.agentCaCertFile !== undefined) {
        const captures = createAgentCaptures({
          databases: deps.databases, services: deps.services, logger: deps.logger,
          // An MQTT capture's login (20.2): sealed to the agent for the lease, bound to the slot as its work.
          seal: async (s) => {
            const answer = await deps.services.call(sealAgentCredentials, {
              body: { connectionId: s.connectionId, reason: 'change_stream', agentId: s.agentId, workId: s.workId },
            }, { request: { organisationId: s.organisationId }, correlationId: uuidv7() });
            return answer.custody === 'cell' ? { sealed: answer.sealed, expiresAt: answer.expiresAt } : undefined;
          },
          // An OPC UA capture's application key (20.3), sealed the same way.
          sealKey: (s) => deps.services.call(sealOpcUaApplicationKey, {
            body: { connectionId: s.connectionId, endpointId: s.endpointId, reason: 'change_stream', agentId: s.agentId, workId: s.workId },
          }, { request: { organisationId: s.organisationId }, correlationId: uuidv7() }),
          ...(options.agentCaptureLeaseMs ? { leaseMs: options.agentCaptureLeaseMs } : {}),
          ...(options.agentCaptureRetryMs ? { retryMs: options.agentCaptureRetryMs } : {}),
        });
        // Work for an agent another replica holds is relayed to that replica's own address.
        const registry = createAgentRegistry({ store: deps.redis.data!, replicaId: uuidv7(), relayUrl: connect.agentRelayUrl });
        tunnels = createAgentTunnels({
          databases: deps.databases, logger: deps.logger, captures, registry,
          allowlists: createAgentAllowlists({ databases: deps.databases, logger: deps.logger, ...(options.agentAllowlistResendMs ? { resendMs: options.agentAllowlistResendMs } : {}) }),
          relay: async (target, work) => (await deps.services.call(relayAgentWork, {
            params: { agentId: target.agentId },
            body: {
              poolId: work.poolId, kind: work.kind, payload: work.payload, timeoutMs: work.timeoutMs,
              ...(work.seal === undefined ? {} : { seal: { connectionId: work.seal.connectionId, reason: work.seal.reason } }),
              ...(work.sealKey === undefined ? {} : { sealKey: { connectionId: work.sealKey.connectionId, endpointId: work.sealKey.endpointId, reason: work.sealKey.reason } }),
            },
          }, {
            request: work.seal?.request ?? work.sealKey?.request ?? { organisationId: work.organisationId },
            correlationId: work.seal?.correlationId ?? work.sealKey?.correlationId ?? uuidv7(),
            replicaUrl: target.relayUrl, timeoutMs: work.timeoutMs + 5_000,
            ...(work.signal ? { signal: work.signal } : {}),
          })).frames,
          ...(options.agentHeartbeatMs ? { heartbeatMs: options.agentHeartbeatMs } : {}),
          ...(options.now ? { now: options.now } : {}),
          // The connection's login, sealed by the credential service for the agent and work (spec 10.7).
          seal: async (s) => {
            const answer = await deps.services.call(sealAgentCredentials, {
              body: { connectionId: s.connectionId, reason: s.reason, agentId: s.agentId, workId: s.workId },
            }, { request: s.request, correlationId: s.correlationId });
            return answer.custody === 'cell' ? { sealed: answer.sealed, expiresAt: answer.expiresAt } : undefined;
          },
          // An OPC UA endpoint's application key (spec 20.3), sealed the same way.
          sealKey: async (s) => deps.services.call(sealOpcUaApplicationKey, {
            body: { connectionId: s.connectionId, endpointId: s.endpointId, reason: s.reason, agentId: s.agentId, workId: s.workId },
          }, { request: s.request, correlationId: s.correlationId }),
        });
        options.onAgentTunnels?.(tunnels);
        scans = createAgentScans({
          databases: deps.databases, services: deps.services, logger: deps.logger, tunnels, scanKey: discoveryKey,
          // An industrial endpoint's login and key for a discovery scan (19.2, 20.3), sealed for the scan.
          seal: async (s) => {
            const answer = await deps.services.call(sealAgentCredentials, {
              body: { connectionId: s.connectionId, reason: 'probe', agentId: s.agentId, workId: s.workId },
            }, { request: { organisationId: s.organisationId }, correlationId: uuidv7() });
            return answer.custody === 'cell' ? { sealed: answer.sealed, expiresAt: answer.expiresAt } : undefined;
          },
          sealKey: (s) => deps.services.call(sealOpcUaApplicationKey, {
            body: { connectionId: s.connectionId, endpointId: s.endpointId, reason: 'probe', agentId: s.agentId, workId: s.workId },
          }, { request: { organisationId: s.organisationId }, correlationId: uuidv7() }),
          ...(options.agentScanReportMs ? { reportMs: options.agentScanReportMs } : {}),
        });
        const ca = await createAgentCa({ certificatePem: readFileSync(connect.agentCaCertFile, 'utf8'), keyPem: connect.agentCaKey! });
        workers.push(agentEndpoint({
          host: deps.config.http.host, port: connect.agentPort,
          tls: { cert: readFileSync(connect.agentTlsCertFile, 'utf8'), key: connect.agentTlsKey! },
          ca, enrolment: { databases: deps.databases, logger: deps.logger, grantKey: connect.executionGrantPublicKey, discoveryKey }, tunnels, logger: deps.logger,
          ...(updates ? { updates } : {}),
          ...(options.onAgentEndpoint ? { onListening: options.onAgentEndpoint } : {}),
        }));
      }
      // Silo's own store (66.5): the cell's siloes project, where the build has BigQuery; none in the sovereign build.
      const bigQuery = options.siloStore === undefined && deps.config.bigQuery !== undefined
        ? createBigQueryAdapter({ projectId: deps.config.bigQuery.projectId, location: deps.config.bigQuery.location }) : undefined;
      const siloStore = options.siloStore ?? (bigQuery === undefined ? NO_SILO_STORE : createSiloStore(bigQuery, deps.config.bigQuery!.projectId));
      const runtime = {
        databases: deps.databases, services: deps.services, agent: options.agent ?? (tunnels ? tunnelChannel(tunnels) : NO_AGENT_TUNNEL), siloStore,
        bounds: deps.config.executorBounds, grantKey: connect.executionGrantPublicKey,
      };
      const read = readController(runtime);
      // The write path of approved mutations, and the record reads around it (spec 45.2).
      const writes = writeController(runtime);
      return {
        routes: [
          route(readObject, read), route(writeRecords, writes.write), route(prepareWrites, writes.prepare), route(readRecords, writes.read),
          // The nodes a physical Action would write, and their values now (47.3, 47.4), asked by actions.
          route(resolvePhysicalTargets, {
            handle: ({ body }, ctx) => resolvePhysical(runtime, { request: ctx.request, correlationId: ctx.correlationId, signal: ctx.signal }, body),
          }),
          // An OPC UA endpoint's verification (spec 20.3), asked by connect-registry.
          route(probeIndustrialEndpoint, {
            handle: ({ params, body }, ctx) => probeEndpoint(runtime, { request: ctx.request, correlationId: ctx.correlationId, signal: ctx.signal }, params.endpointId, body.connectionId),
          }),
          // Structure from a live sample, never values (spec 14.6, 17.3).
          route(observeObject, observeController(runtime)),
          // Field profiles for derivation: counts only, never values (spec 22.3).
          route(profileObject, profileController(runtime)),
          // Work for an agent this replica holds, relayed by the replica that chose it (spec 10.3).
          route(relayAgentWork, relayController(() => tunnels)),
          // Outbound webhooks to private targets, sent by the connection's agent (spec 20.4).
          route(sendWebhookThroughAgent, { handle: (input, ctx) => sendThroughAgent(runtime, ctx, input.params.endpointId, input.body) }),
          // Discovery scans, signed by discovery, given to the agent (spec 10.5).
          route(startDiscoveryScan, discoveryScanController(() => scans)),
          // Agent releases the cell's Fleet agent carries in (spec 10.7).
          route(installAgentRelease, agentReleaseController(updates)),
        ],
        workers,
        close: async () => {
          scans?.close();
          await bigQuery?.close();
        },
      };
    },
  });
}

export const service = createConnectRuntimeService();
