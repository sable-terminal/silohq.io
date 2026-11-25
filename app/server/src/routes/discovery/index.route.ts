// discovery (catalogue; spec 19): agent discovery. Off by default and unreachable when off;
// compiled out of the sovereign build entirely, so the service refuses to start there.
// Scans run on the Silo Agent, signed here for one run of an approved authorisation on one
// agent, given to it by connect-runtime and reported back run by run; findings become
// connectors through connect-registry and ontology proposals through derivation.

import {
  getDiscoverySettings, getFinding, getScanAuthorisation, getScanRun, listFindings, listScanAuthorisations, listScanRuns, requestScanAuthorisation,
  reviewFinding, revokeScanAuthorisation, setDiscoveryEnabled, startScan,
} from '../../contracts/discovery/discovery.contract.ts';
import { reportScanEvents } from '../../contracts/discovery/scan.contract.ts';
import { discoveryController } from '../../controllers/discovery/discovery.controller.ts';
import { route } from '../../infra/http.infra.ts';
import { defineService, type ServiceDefinition } from '../../infra/service.infra.ts';
import { connectRuntimeChannel, type DiscoveryAgentChannel } from '../../services/discovery/agent.service.ts';
import { createAuthorisations } from '../../services/discovery/authorisations.service.ts';
import type { DiscoveryDeps } from '../../services/discovery/deps.service.ts';
import { createFindings } from '../../services/discovery/findings.service.ts';
import { createRuns } from '../../services/discovery/runs.service.ts';
import { createScanSigner } from '../../services/discovery/scans.service.ts';
import { createSettings } from '../../services/discovery/settings.service.ts';
import { silentRunsWorker } from '../../workers/discovery/silentRuns.worker.ts';
import { AppError } from '../../utils/errors.util.ts';

export interface DiscoveryOptions {
  /** How scans reach agents: connect-runtime by default; tests stand in for it. */
  agent?: DiscoveryAgentChannel;
  /** A run with no report for this long has lost its agent; how often that is swept. */
  silentMs?: number;
  sweepMs?: number;
  sweep?: boolean;
}

export function createDiscoveryService(options: DiscoveryOptions = {}): ServiceDefinition {
  return defineService({
    name: 'discovery',
    // redis-data: idempotency keys of authorisation requests, scan starts and reviews.
    needs: { postgres: ['control'], redis: ['data'] },
    create(deps) {
      if (deps.config.cell.buildTarget === 'sovereign') {
        throw new AppError('configuration', 'agent discovery is compiled out of the sovereign build (spec 19)', { code: 'config.discovery.sovereign' });
      }
      const silentMs = options.silentMs ?? 120_000;
      const discovery: DiscoveryDeps = {
        databases: deps.databases, services: deps.services, logger: deps.logger, agent: options.agent ?? connectRuntimeChannel(deps.services),
        scans: createScanSigner(deps.config.connect.discoveryScanKey), silentMs,
      };
      const runs = createRuns(discovery);
      const settings = createSettings(discovery, (db, ctx) => runs.stopAll(db, ctx));
      const authorisations = createAuthorisations(discovery, (db, ctx, id) => runs.stopFor(db, ctx, id));
      const c = discoveryController({ settings, authorisations, runs, findings: createFindings(discovery) });
      return {
        routes: [
          route(getDiscoverySettings, c.getDiscoverySettings), route(setDiscoveryEnabled, c.setDiscoveryEnabled),
          route(requestScanAuthorisation, c.requestScanAuthorisation), route(listScanAuthorisations, c.listScanAuthorisations),
          route(getScanAuthorisation, c.getScanAuthorisation), route(revokeScanAuthorisation, c.revokeScanAuthorisation),
          route(startScan, c.startScan), route(getScanRun, c.getScanRun), route(listScanRuns, c.listScanRuns),
          // What the agent did, from the connect-runtime replica holding its tunnel.
          route(reportScanEvents, c.reportScanEvents),
          route(listFindings, c.listFindings), route(getFinding, c.getFinding), route(reviewFinding, c.reviewFinding),
        ],
        workers: options.sweep === false ? [] : [silentRunsWorker(runs, options.sweepMs ?? Math.min(30_000, silentMs), deps.logger)],
      };
    },
  });
}

export const service = createDiscoveryService();
