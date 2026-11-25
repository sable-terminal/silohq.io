// fleet-control (spec 11), in the global tier: the release registry and artefact store,
// channels, two-person promotion, rollouts in waves gated on health, and bundle signing
// for air-gapped installs. The sovereign cell runs its own, holding the sovereign release
// key: it countersigns reviewed bundles and signs nothing else.
//
// The cell-side Fleet agent runs under the same name inside each cell (FLEET_ROLE=cell_agent)
// and calls these endpoints: it carries the cell's agent channel to its Silo Agents
// (services/fleet-control/cellAgent.service.ts) and, given the cell's Kubernetes API
// (FLEET_KUBERNETES), applies the cell's own releases (cellRelease.service.ts). State is in the
// fleet tables, so replicas agree; the rollout worker in each replica takes fleet-control's lock.

import { fleetController, sbomController } from '../../controllers/fleet-control/fleet.controller.ts';
import { countersignBundle, signBundle } from '../../contracts/fleet-control/bundle.contract.ts';
import { readAgentBinary } from '../../contracts/fleet-control/agentBinary.contract.ts';
import { readReleaseDocument } from '../../contracts/fleet-control/releaseDocument.contract.ts';
import { readRelease, registerRelease } from '../../contracts/fleet-control/release.contract.ts';
import { putReleaseSbom, putReleaseVex, readReleaseFindings, syncAdvisories } from '../../contracts/fleet-control/sbom.contract.ts';
import { listCellEvents, listFleetEvents, reportMigrationApplied, verifyFleetEvents } from '../../contracts/fleet-control/events.contract.ts';
import { getConceptTemplateSet } from '../../contracts/fleet-control/conceptTemplates.contract.ts';
import {
  approvePromotion, desiredRelease, haltRollout, putCellChangePolicy, readChannel, readPromotion, readRollout, reportVerdict, requestPromotion,
} from '../../contracts/fleet-control/rollout.contract.ts';
import { required } from '../../config/index.config.ts';
import { openFleetControl } from '../../services/fleet-control/control.service.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import type { ArtefactStore } from '../../services/fleet-control/artefactStore.service.ts';
import { createCellFleetAgent, type CellFleetAgent } from '../../services/fleet-control/cellAgent.service.ts';
import { configMapStore, createCellReleases, type CellReleaseDeps, type CellReleases } from '../../services/fleet-control/cellRelease.service.ts';
import { createSyntheticFixture, type SyntheticFixture } from '../../services/fleet-control/syntheticFixture.service.ts';
import { createSyntheticTests, type SyntheticTests } from '../../services/fleet-control/syntheticTests.service.ts';
import { createPublicApi } from '../../services/fleet-control/publicApi.service.ts';
import { syntheticWorker } from '../../workers/fleet-control/synthetic.worker.ts';
import { cellReportsWorker } from '../../workers/fleet-control/cellReports.worker.ts';
import { createCellReports, type CellReports } from '../../services/fleet-control/cellReports.service.ts';
import { createServer } from 'node:http';
import { createSignalStore, DEFAULT_GATE_SETTINGS, type GateSettings, type SignalStore } from '../../services/fleet-control/cellSignals.service.ts';
import { reportProcessSignals } from '../../contracts/fleet-control/signals.contract.ts';
import { createKubernetesClient } from '../../infra/kubernetes.infra.ts';
import { cellReleaseWorker } from '../../workers/fleet-control/cellRelease.worker.ts';
import { createObjectStore, type ObjectStore } from '../../infra/objectStorage.infra.ts';
import { agentChannelWorker } from '../../workers/fleet-control/agentChannel.worker.ts';
import { trustedKey } from '../../services/fleet-control/signing.service.ts';
import { advisoriesWorker } from '../../workers/fleet-control/advisories.worker.ts';
import { rolloutsWorker } from '../../workers/fleet-control/rollouts.worker.ts';

export interface FleetServiceOptions {
  store?: ArtefactStore;
  /** The clock, for tests of soaks and waves. */
  now?: () => number;
  /** How often running rollouts are advanced; a minute by default. */
  tickMs?: number;
  /** A cell's Fleet agent: the cell's object storage (tests give one in memory), and how soon a failed pull is tried again. */
  objects?: ObjectStore;
  agentRetryMs?: number;
  /** Told the cell's Fleet agent, for tests to pull when they choose. */
  onCellAgent?: (agent: CellFleetAgent) => void;
  /** Told the cell's release applier, for tests to pull when they choose; and how often it looks at a roll. */
  onCellReleases?: (releases: CellReleases) => void;
  checkEveryMs?: number;
  /** The gates' thresholds and window, for tests; and the synthetic tests' results. */
  gates?: Partial<GateSettings>;
  synthetic?: CellReleaseDeps['synthetic'];
  /** Told the cell agent's signal store, for tests to read; and its reports, for tests to make. */
  onSignals?: (store: SignalStore) => void;
  onCellReports?: (reports: CellReports) => void;
  /** Told the synthetic tests, their fixture and its port, for tests to drive; and how long a test's step may wait. */
  onSynthetic?: (tests: SyntheticTests, fixture: SyntheticFixture, port: number) => void;
  syntheticWaitMs?: number;
}

export function createFleetService(options: FleetServiceOptions = {}): ServiceDefinition {
  return defineService({
    name: 'fleet-control',
    // The global tier's holds the fleet tables; a cell's Fleet agent holds no state of its own.
    needs: (config) => (config.globalTier.fleet.role === 'cell_agent' ? {} : { postgres: ['directory'] }),
    async create(deps) {
      const settings = deps.config.globalTier.fleet;
      if (settings.role === 'cell_agent') {
        const agent = createCellFleetAgent({
          services: deps.services, logger: deps.logger, target: deps.config.cell.buildTarget,
          objects: options.objects ?? await createObjectStore(deps.config.objectStorage!),
          trusted: [
            trustedKey(required(settings.releasePublicKey, 'FLEET_RELEASE_PUBLIC_KEY_FILE'), 'release'),
            // A sovereign cell's agent-sovereign heads are the sovereign fleet-control's (D202).
            ...(settings.sovereignPublicKey ? [trustedKey(settings.sovereignPublicKey, 'sovereign')] : []),
          ],
        });
        options.onCellAgent?.(agent);
        const workers = [agentChannelWorker({
          agent, logger: deps.logger, intervalMs: settings.agentPollMinutes * 60_000, ...(options.agentRetryMs ? { retryMs: options.agentRetryMs } : {}),
        })];
        // What the cell's processes answer, for the release gates (spec 11.2).
        const signals = createSignalStore();
        options.onSignals?.(signals);
        const routes = [route(reportProcessSignals, { handle: async ({ params, body }) => ({ accepted: signals.receive(params.processId, body) }) })];
        const kube = settings.kubernetes === 'none' ? undefined : createKubernetesClient({
          where: settings.kubernetes, tokenFile: settings.kubernetesTokenFile, caFile: settings.kubernetesCaFile, namespace: settings.kubernetesNamespace,
        });
        // Registration, status, the change policy and Fleet's events (D199); a provisioning cell's placement (D203).
        const reports = createCellReports({
          services: deps.services, logger: deps.logger, signals, cell: deps.config.cell, status: settings.cellStatus,
          ...(kube ? { placement: configMapStore<{ openedAt: string }>(kube, 'silo-fleet-placement') } : {}),
        });
        options.onCellReports?.(reports);
        workers.push(cellReportsWorker({ reports, logger: deps.logger, intervalMs: settings.reportSeconds * 1000 }));
        let close: (() => Promise<void>) | undefined;
        if (kube !== undefined) {
          const cell = deps.config.cell;
          // The synthetic tests (spec 11.2): the fixture source served here, the tests through the gateway.
          let synthetic: SyntheticTests | undefined;
          if (settings.syntheticPort !== undefined) {
            const fixture = createSyntheticFixture(deps.logger);
            const server = createServer(fixture.handler);
            await new Promise<void>((resolve) => server.listen(settings.syntheticPort, settings.syntheticHost, resolve));
            close = () => new Promise<void>((resolve) => server.close(() => resolve()));
            synthetic = createSyntheticTests({
              services: deps.services, api: createPublicApi(settings.gatewayUrl!, settings.gatewayOrigin!), gatewayUrl: settings.gatewayUrl!, fixture,
              fixtureUrl: settings.syntheticUrl!, store: configMapStore(kube, 'silo-fleet-synthetic'), logger: deps.logger,
              ...(options.syntheticWaitMs ? { waitMs: options.syntheticWaitMs } : {}),
            });
            options.onSynthetic?.(synthetic, fixture, (server.address() as { port: number }).port);
          }
          const results = synthetic;
          const releases = createCellReleases({
            services: deps.services, logger: deps.logger,
            kube,
            trusted: [trustedKey(required(settings.releasePublicKey, 'FLEET_RELEASE_PUBLIC_KEY_FILE'), 'release')],
            cell: { id: cell.id, buildTarget: cell.buildTarget, capabilities: cell.capabilities },
            channel: settings.channel ?? (cell.kind === 'sovereign' ? 'sovereign' : 'stable'),
            signals, gates: { ...DEFAULT_GATE_SETTINGS, windowMs: settings.gateWindowMinutes * 60_000, ...options.gates },
            ...(options.synthetic ? { synthetic: options.synthetic } : results ? { synthetic: async (releaseId: string) => results.resultsFor(releaseId) } : {}),
            settings: {
              imageRepository: required(settings.imageRepository, 'FLEET_IMAGE_REPOSITORY'), migrationSecret: settings.migrationSecret,
              rollTimeoutMs: settings.rollTimeoutMinutes * 60_000, ...(options.checkEveryMs ? { checkEveryMs: options.checkEveryMs } : {}),
            },
          });
          options.onCellReleases?.(releases);
          workers.push(cellReleaseWorker({
            releases, logger: deps.logger, intervalMs: settings.releasePollMinutes * 60_000, ...(options.agentRetryMs ? { retryMs: options.agentRetryMs } : {}),
          }));
          if (synthetic !== undefined) {
            workers.push(syntheticWorker({
              tests: synthetic, releases, logger: deps.logger, intervalMs: settings.syntheticMinutes * 60_000, onPassed: (id) => reports.openPlacement(id),
            }));
          }
        }
        return { routes, workers, ...(close ? { close } : {}) };
      }
      const { fleet, sbom, store } = await openFleetControl(deps.config, deps.databases, deps.logger, options);
      const handlers = fleetController(fleet, deps.config.cell.id);
      const sbomHandlers = sbomController(sbom, deps.logger);
      return {
        routes: [
          route(registerRelease, handlers.registerRelease),
          route(readRelease, handlers.readRelease),
          route(requestPromotion, handlers.requestPromotion),
          route(approvePromotion, handlers.approvePromotion),
          route(readPromotion, handlers.readPromotion),
          route(readChannel, handlers.readChannel),
          route(desiredRelease, handlers.desiredRelease),
          route(reportVerdict, handlers.reportVerdict),
          route(putCellChangePolicy, handlers.putCellChangePolicy),
          route(listFleetEvents, handlers.listFleetEvents),
          route(verifyFleetEvents, handlers.verifyFleetEvents),
          route(listCellEvents, handlers.listCellEvents),
          route(getConceptTemplateSet, handlers.getConceptTemplateSet),
          route(reportMigrationApplied, handlers.reportMigrationApplied),
          route(haltRollout, handlers.haltRollout),
          route(readRollout, handlers.readRollout),
          route(signBundle, handlers.signBundle),
          route(countersignBundle, handlers.countersignBundle),
          route(readAgentBinary, handlers.readAgentBinary),
          route(readReleaseDocument, handlers.readReleaseDocument),
          route(putReleaseSbom, sbomHandlers.putReleaseSbom),
          route(putReleaseVex, sbomHandlers.putReleaseVex),
          route(readReleaseFindings, sbomHandlers.readReleaseFindings),
          route(syncAdvisories, sbomHandlers.syncAdvisories),
        ],
        workers: [
          rolloutsWorker({ fleet, logger: deps.logger, ...(options.tickMs ? { intervalMs: options.tickMs } : {}) }),
          ...(sbom ? [advisoriesWorker({ sbom, logger: deps.logger })] : []),
        ],
      };
    },
  });
}

export const service = createFleetService();
